import { type IncomingMessage, type ServerResponse } from "node:http";
import { SPLITTER_MAX_IDEA_CHARS, interviewIdea, splitIdea, type SplitDeps, type SplitManager, type SplitSource, type SplitStage } from "../../core/ideas/queue-split.js";
import { normalizeAnswers, type InterviewAnswers } from "../../core/ideas/idea-agents.js";
import { loadPendingInterview, removePendingInterview, savePendingInterview, type PendingInterview } from "../../core/ideas/idea-interview-store.js";
import { errorMessage, json, readJsonBody } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

const VI_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/** `/api/projects/<name>/queue/split/*`: split an idea into queue commands (jobs live in memory; pending interviews also on disk). */
export function createSplitApi(ctx: ApiContext) {
  const { manager, store } = ctx;
  // ---- Idea split jobs (T14): in-memory; an idea waiting for interview answers is also on disk (idea-interview-store) ----
  interface SplitJob {
    id?: string;
    project: string;
    state: "running" | "done" | "error" | "questions";
    stage?: SplitStage;
    questions?: string[];
    commands?: number;
    costUsd?: number;
    error?: string;
  }
  const splitJobs = new Map<string, SplitJob>();
  const splitBusy = new Set<string>();
  const SPLIT_JOBS_MAX = 50;

  function registerSplitJob(id: string, job: SplitJob): void {
    if (splitJobs.size >= SPLIT_JOBS_MAX) {
      for (const [k, v] of splitJobs) {
        if (v.state !== "running") splitJobs.delete(k);
        if (splitJobs.size < SPLIT_JOBS_MAX) break;
      }
    }
    job.id = id;
    splitJobs.set(id, job);
  }

  /**
   * Run `work` as one split job of `name`. The job id is `fixedId` (answers to a pending interview) or the id of the
   * first agent run it starts; the returned promise resolves with that id, or rejects when `work` fails before any run.
   */
  function launchSplitJob(name: string, fixedId: string | null, work: (deps: SplitDeps, job: SplitJob) => Promise<void>): Promise<string> {
    splitBusy.add(name);
    const job: SplitJob = { project: name, state: "running" };
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    const idPromise = new Promise<string>((resolve, reject) => {
      resolveId = resolve;
      rejectId = reject;
    });
    if (fixedId) {
      registerSplitJob(fixedId, job);
      resolveId(fixedId);
    }
    const wrapped: SplitManager = {
      startRun: async (input) => {
        const r = await manager.startRun(input);
        if (!job.id) {
          registerSplitJob(r.id, job);
          resolveId(r.id);
        }
        return r;
      },
      waitFor: (id) => manager.waitFor(id),
      // Without this the "Ý tưởng" role table in Settings (account and model per idea agent) was ignored on the HTTP path.
      resolveRoleAssignment: (role) => manager.resolveRoleAssignment(role),
    };
    const deps: SplitDeps = { manager: wrapped, queue: manager.queue, config: manager.config, getProject: (n) => store.getProject(n) };
    work(deps, job)
      .then(
        () => undefined,
        (e) => {
          Object.assign(job, { state: "error", error: errorMessage(e).message });
          rejectId(e); // no-op when the job id was already resolved
        },
      )
      .finally(() => splitBusy.delete(name));
    return idPromise;
  }

  function splitJobView(id: string, job: SplitJob, pending: PendingInterview | null) {
    return {
      runId: id,
      state: job.state,
      ...(job.stage ? { stage: job.stage } : {}),
      ...(job.questions ? { questions: job.questions } : pending ? { questions: pending.questions } : {}),
      ...(job.commands !== undefined ? { commands: job.commands } : {}),
      ...(job.costUsd !== undefined ? { costUsd: job.costUsd } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
  }

  async function handleSplitApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    name: string,
    runId: string | undefined,
    sub?: string,
  ): Promise<void> {
    const project = store.getProject(name);
    if (!project) return json(res, 404, { error: "project_not_found", message: `Không tìm thấy môi trường "${name}".` });
    if (name === "default" || !project.repo_path) {
      return json(res, 400, { error: "no_repo", message: `Môi trường "${name}" chưa gắn repo nên không chia được ý tưởng.` });
    }
    const dataDir = manager.config.dataDir;
    if (method === "GET" && runId) {
      const job = splitJobs.get(runId);
      const pending = loadPendingInterview(dataDir, name, runId);
      if (job && job.project === name) return json(res, 200, splitJobView(runId, job, pending));
      if (pending) return json(res, 200, splitJobView(runId, { project: name, state: "questions", questions: pending.questions, costUsd: pending.costUsd, ...(pending.lastError ? { error: pending.lastError } : {}) }, pending));
      return json(res, 404, { error: "not_found", message: "Không tìm thấy yêu cầu chia ý tưởng này." });
    }
    if (method === "POST" && runId && sub === "answers") {
      const pending = loadPendingInterview(dataDir, name, runId);
      if (!pending) return json(res, 404, { error: "not_found", message: "Không tìm thấy ý tưởng đang chờ trả lời phỏng vấn." });
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: "bad_request", message: "Nội dung gửi lên không hợp lệ." });
      if (body["dismiss"] === true) {
        removePendingInterview(dataDir, name, runId);
        splitJobs.delete(runId);
        return json(res, 200, { ok: true });
      }
      const skip = body["skip"] === true;
      if (!skip && !Array.isArray(body["answers"])) {
        return json(res, 400, { error: "bad_request", message: "Cần answers (mảng câu trả lời) hoặc skip: true." });
      }
      if (splitBusy.has(name)) {
        return json(res, 409, { error: "split_busy", message: `Môi trường "${name}" đang có một yêu cầu chia ý tưởng chạy; hãy đợi xong.` });
      }
      const answers = skip ? pending.questions.map(() => "") : normalizeAnswers(pending.questions, body["answers"]);
      const interview: InterviewAnswers = { questions: pending.questions, answers, skipped: skip };
      const id = await launchSplitJob(name, runId, async (deps, job) => {
        job.costUsd = pending.costUsd;
        try {
          const result = await splitIdea(deps, name, pending.idea, pending.source, { webSearch: pending.webSearch, interview, onStage: (s) => (job.stage = s) });
          removePendingInterview(dataDir, name, runId);
          Object.assign(job, { state: "done", commands: result.commands.length, costUsd: (job.costUsd ?? 0) + result.costUsd });
        } catch (e) {
          savePendingInterview(dataDir, { ...pending, lastError: errorMessage(e).message });
          throw e;
        }
      });
      return json(res, 202, { runId: id });
    }
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { error: "bad_request", message: "Nội dung gửi lên không hợp lệ." });
    const rawIdea = body["idea"];
    if (typeof rawIdea !== "string") return json(res, 400, { error: "bad_request", message: "Thiếu ý tưởng (idea) dạng chữ." });
    const idea = rawIdea.trim();
    if (!idea) return json(res, 400, { error: "bad_request", message: "Ý tưởng đang để trống." });
    if (idea.length > SPLITTER_MAX_IDEA_CHARS) {
      return json(res, 400, { error: "idea_too_long", message: `Ý tưởng quá dài (${idea.length} ký tự, tối đa ${SPLITTER_MAX_IDEA_CHARS}).` });
    }
    if (!VI_DIACRITICS.test(idea)) {
      return json(res, 400, { error: "need_vietnamese", message: "Hãy viết ý tưởng bằng tiếng Việt có dấu." });
    }
    const wsRaw = body["webSearch"];
    if (wsRaw !== undefined && typeof wsRaw !== "boolean") {
      return json(res, 400, { error: "bad_request", message: "webSearch phải là đúng/sai (boolean)." });
    }
    const skipRaw = body["skipInterview"];
    if (skipRaw !== undefined && typeof skipRaw !== "boolean") {
      return json(res, 400, { error: "bad_request", message: "skipInterview phải là đúng/sai (boolean)." });
    }
    const webSearch = wsRaw ?? manager.config.queue?.splitter?.webSearch ?? true;
    const srcRaw = body["source"];
    const refRaw = body["sourceRef"];
    if (srcRaw !== undefined && srcRaw !== "manual" && srcRaw !== "scout") {
      return json(res, 400, { error: "bad_request", message: 'source phải là "manual" hoặc "scout".' });
    }
    let splitSource: SplitSource = "manual";
    if (srcRaw === "scout") {
      if (typeof refRaw !== "string" || !/^[\w-]+#[a-z0-9_-]{1,32}$/.test(refRaw)) {
        return json(res, 400, { error: "bad_request", message: "Nguồn scout cần sourceRef dạng <mã run>#<mã đề xuất>." });
      }
      splitSource = { scout: true, ref: refRaw };
    } else if (refRaw !== undefined) {
      return json(res, 400, { error: "bad_request", message: 'sourceRef chỉ dùng khi source là "scout".' });
    }
    if (splitBusy.has(name)) {
      return json(res, 409, { error: "split_busy", message: `Môi trường "${name}" đang có một yêu cầu chia ý tưởng chạy; hãy đợi xong.` });
    }
    const interviewOn = manager.config.queue?.splitter?.interview === true && skipRaw !== true;
    try {
      const id = await launchSplitJob(name, null, async (deps, job) => {
        if (interviewOn) {
          job.stage = "interview";
          let iv: Awaited<ReturnType<typeof interviewIdea>> | null = null;
          try {
            iv = await interviewIdea(deps, name, idea);
          } catch (e) {
            // A failed interview never blocks the idea: the split goes on without questions.
            console.warn(`[queue] phỏng vấn ý tưởng không chạy được (${name}): ${errorMessage(e).message}`);
          }
          if (iv) {
            job.costUsd = iv.costUsd;
            if (!iv.ready) {
              savePendingInterview(dataDir, {
                id: iv.runId, project: name, idea, source: splitSource, webSearch, questions: iv.questions,
                state: "awaiting_user", createdAt: Date.now(), costUsd: iv.costUsd,
              });
              Object.assign(job, { state: "questions", questions: iv.questions });
              return;
            }
          }
        }
        const result = await splitIdea(deps, name, idea, splitSource, { webSearch, onStage: (s) => (job.stage = s) });
        Object.assign(job, { state: "done", commands: result.commands.length, costUsd: (job.costUsd ?? 0) + result.costUsd });
      });
      return json(res, 202, { runId: id });
    } catch (e) {
      const msg = errorMessage(e).message;
      return json(res, /chờ duyệt/.test(msg) ? 409 : 400, { error: "split_failed", message: msg });
    }
  }

  return { handleSplitApi };
}
