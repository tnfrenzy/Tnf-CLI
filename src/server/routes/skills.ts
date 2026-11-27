import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { validateInboxName } from "../../core/run/inbox.js";
import { normalizeName } from "../../core/roles/role-library.js";
import { SkillError, validateSlug } from "../../core/skill-workshop/package.js";
import { buildZip } from "../../core/app/zip.js";
import { PASS, type RouteResult, SKILL_BODY_LIMIT, json, readSkillBody, readStagedAttachments, skillErrorResponse } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** `/api/skills/*` (skill training floors) and `/api/skills-gen/*` (generative training sessions). */
export async function handleSkillRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, skillStore, skillTrainer, skillsGen } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/skills" || p.startsWith("/api/skills/")) {
    const parts = p.split("/").filter(Boolean); // ["api","skills", slug?, "zip"?]
    try {
      const skills = skillStore;
      if (parts.length === 2 && method === "GET") return json(res, 200, { skills: await skills.list() });
      if (parts.length === 2 && method === "POST") {
        const body = await readSkillBody(req, SKILL_BODY_LIMIT);
        const title = typeof body["title"] === "string" ? body["title"] : "";
        let slug = typeof body["slug"] === "string" && body["slug"] ? body["slug"] : normalizeName(title);
        if (!slug) throw new SkillError("Không tạo được slug từ tiêu đề; hãy nhập slug (a-z, 0-9, dấu gạch ngang).", 400, "bad_slug");
        slug = validateSlug(slug);
        const { items: attachItems, stageDirs } = readStagedAttachments(body["attachments"], manager);
        const rec = await skills.create({ slug, title, goal: typeof body["goal"] === "string" ? body["goal"] : "", files: (body["files"] ?? {}) as Record<string, string> });
        if (attachItems.length > 0) {
          try {
            await skills.attachExamples(slug, attachItems);
          } catch (e) {
            await skills.remove(slug).catch(() => undefined);
            throw e;
          }
          for (const d of stageDirs) fs.rmSync(d, { recursive: true, force: true });
        }
        return json(res, 201, rec);
      }
      if (parts.length >= 3) {
        let slug: string;
        try {
          slug = validateSlug(decodeURIComponent(parts[2]!));
        } catch (e) {
          if (e instanceof SkillError) throw e;
          throw new SkillError("Slug không hợp lệ.", 400, "bad_slug");
        }
        if (parts.length === 3 && method === "GET") return json(res, 200, await skills.get(slug));
        if (parts.length === 3 && method === "PUT") {
          const body = await readSkillBody(req, SKILL_BODY_LIMIT);
          const input: { title?: string; goal?: string; files?: Record<string, string> } = {};
          if (typeof body["title"] === "string") input.title = body["title"];
          if (typeof body["goal"] === "string") input.goal = body["goal"];
          if (body["files"] !== undefined) input.files = body["files"] as Record<string, string>;
          return json(res, 200, await skills.update(slug, input));
        }
        if (parts.length === 3 && method === "DELETE") {
          await skills.remove(slug);
          return json(res, 200, { ok: true });
        }
        if (parts.length === 4 && parts[3] === "zip" && method === "GET") {
          const entries = await skills.readZipEntries(slug);
          const zip = buildZip(entries);
          res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "content-disposition": `attachment; filename="${slug}.zip"`, "cache-control": "no-store" });
          return void res.end(zip);
        }
        if (parts.length === 4 && parts[3] === "answers" && method === "GET") {
          const schema = await skills.readInputsSchema(slug);
          return json(res, 200, { schema, answers: await skills.readAnswers(slug) });
        }
        if (parts.length === 4 && parts[3] === "answers" && method === "POST") {
          const body = await readSkillBody(req, SKILL_BODY_LIMIT);
          const answers = body["answers"];
          if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new SkillError("`answers` phải là một đối tượng id -> câu trả lời.", 400, "bad_request");
          let stageDir: string | undefined;
          const stageId = body["stageId"];
          if (stageId !== undefined && stageId !== null && stageId !== "") {
            if (typeof stageId !== "string" || validateInboxName(stageId)) throw new SkillError("Mã đính kèm không hợp lệ.", 400, "bad_stage");
            stageDir = manager.stageDir(stageId);
            if (!fs.existsSync(stageDir)) throw new SkillError("Không tìm thấy tệp đính kèm đã tải lên (mã đính kèm không tồn tại).", 400, "bad_stage");
          }
          await skills.writeAnswers(slug, answers as Record<string, unknown>, stageDir);
          return json(res, 200, { ok: true });
        }
        if (parts.length === 4 && parts[3] === "rounds" && method === "GET") {
          await skills.get(slug); // 404 for unknown slug
          return json(res, 200, await skillTrainer.getRounds(slug));
        }
        if (parts.length === 4 && parts[3] === "grade" && method === "POST") {
          await skills.get(slug); // 404 for unknown slug
          const body = await readSkillBody(req, SKILL_BODY_LIMIT);
          const score = body["score"];
          if (typeof score !== "number" || !Number.isFinite(score)) throw new SkillError("Điểm phải là số nguyên từ 0 đến 100.", 400, "invalid_grade");
          return json(res, 200, await skillTrainer.grade(slug, { score, feedback: body["feedback"] }));
        }
        if (parts[3] === "rounds" && parts.length >= 6 && parts[5] === "files" && method === "GET") {
          await skills.get(slug); // 404 for unknown slug
          const rn = /^[1-9][0-9]*$/.test(parts[4]!) ? Number(parts[4]) : 0;
          if (!rn) throw new SkillError("Số vòng không hợp lệ.", 400, "bad_round");
          if (parts.length === 6) return json(res, 200, { files: await skills.listTrialFiles(slug, rn) });
          if (parts.length === 7) {
            let name: string;
            try {
              name = decodeURIComponent(parts[6]!);
            } catch {
              throw new SkillError("Tên tệp không hợp lệ.", 400, "bad_file");
            }
            const text = await skills.readTrialFile(slug, rn, name);
            const dl = new URL(req.url ?? "/", "http://localhost").searchParams.get("download") === "1";
            res.writeHead(200, {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `${dl ? "attachment" : "inline"}; filename="${slug}-round-${rn}-${name}"`,
              "cache-control": "no-store"
            });
            return void res.end(text);
          }
        }
        if (parts.length === 4 && parts[3] === "restore-best" && method === "POST") {
          const { meta } = await skills.get(slug); // 404 for unknown slug
          const m = meta as unknown as { state?: string; paused?: boolean; bestRound?: number | null };
          if (["composing", "trial", "grading"].includes(String(m.state)) && m.paused !== true) {
            throw new SkillError("Đang huấn luyện: hãy tạm dừng hoặc dừng trước khi quay lại bản tốt nhất.", 409, "already_running");
          }
          const bestRound = m.bestRound;
          if (typeof bestRound !== "number" || bestRound <= 0) throw new SkillError("Chưa có vòng nào có điểm để quay lại.", 409, "no_best_round");
          const data = await skills.readRounds(slug);
          const rec = (data.rounds as Array<{ n?: number; skillVersion?: number }>).find((r) => r && r.n === bestRound);
          const ver = rec && Number.isInteger(rec.skillVersion) ? rec.skillVersion! : null;
          if (ver === null) throw new SkillError("Không tìm thấy phiên bản của vòng tốt nhất.", 409, "no_best_version");
          const restored = await skills.restoreVersion(slug, ver);
          return json(res, 200, { ok: true, restoredRound: bestRound, version: restored.meta.version });
        }
        if (parts.length === 4 && ["train", "start", "pause", "resume", "stop", "approve"].includes(parts[3]!) && method === "POST") {
          const action = parts[3]!;
          await skills.get(slug); // 404 for unknown slug
          const overrides: Record<string, number> = {};
          if (action === "train" || action === "start" || action === "resume") {
            const body = await readSkillBody(req, SKILL_BODY_LIMIT);
            for (const k of ["passScore", "maxRounds", "costCapUsd"]) {
              if (body[k] === undefined) continue;
              const v = body[k];
              if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new SkillError(`Giá trị "${k}" phải là số dương.`, 400, "bad_config");
              overrides[k] = v;
            }
          }
          if (action === "train" || action === "start") return json(res, 202, await skillTrainer.train(slug, overrides));
          if (action === "pause") return json(res, 200, await skillTrainer.pause(slug));
          if (action === "resume") return json(res, 200, await skillTrainer.resume(slug, overrides));
          if (action === "stop") return json(res, 200, await skillTrainer.stop(slug));
          return json(res, 200, await skillTrainer.approve(slug));
        }
      }
      return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
    } catch (e) {
      return skillErrorResponse(res, e);
    }
  }
  if (p === "/api/skills-gen" || p.startsWith("/api/skills-gen/")) {
    const parts = p.split("/").filter(Boolean); // ["api","skills-gen","sessions", slug?, ...]
    try {
      const out = await skillsGen.handle(req, parts, method);
      if (!out) return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
      if (out.zip) {
        res.writeHead(out.status, { "content-type": "application/zip", "content-length": out.zip.data.length, "content-disposition": `attachment; filename="${out.zip.filename}"`, "cache-control": "no-store" });
        return void res.end(out.zip.data);
      }
      if (out.file) {
        res.writeHead(out.status, { "content-type": out.file.contentType, "content-length": out.file.data.length, "content-disposition": `attachment; filename="${out.file.filename}"`, "cache-control": "no-store" });
        return void res.end(out.file.data);
      }
      return json(res, out.status, out.body ?? {});
    } catch (e) {
      return skillErrorResponse(res, e);
    }
  }
  return PASS;
}
