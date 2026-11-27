import fs from "node:fs";
import path from "node:path";
import type { AgentInfo } from "./events.js";

// Files the controller writes into a run directory on behalf of the agents (role notes, salvaged reports).

/** notes/<role>.md, then <role>-2.md, <role>-3.md … for repeated calls of the same role. */
export function saveRoleNote(runDir: string, a: AgentInfo, counter: Map<string, number>): void {
  const role = a.role.replace(/[^a-z0-9_-]/gi, "_") || "subagent";
  const n = (counter.get(role) ?? 0) + 1;
  counter.set(role, n);
  const file = path.join(runDir, "notes", n === 1 ? `${role}.md` : `${role}-${n}.md`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!-- Trả lời đầy đủ của vai ${a.role} (${a.agent_id}), controller lưu ngay khi nhận task_notification -->\n\n${a.reply!.trim()}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * CLI 2.1.301 refuses subagent Write calls that look like report files ("Subagents should return findings as
 * text"). Their full reply is still available in the task_notification `output_file`, so copy it into the files the
 * handoff protocol expects when the subagent could not create them itself. (Research runs.)
 */
export function salvageSubagentOutputs(runDir: string, agents: AgentInfo[]): void {
  const targets: Record<string, string> = { synthesizer: "report.md", analyzer: path.join("notes", "analysis.md") };
  let searcherIdx = 0;
  for (const a of agents) {
    let rel = targets[a.role];
    if (!rel && a.role === "searcher" && a.reply) {
      searcherIdx++;
      // Skip when the searcher's reply names a notes file that really exists (it managed to write it).
      const mentioned = [...a.reply.matchAll(/notes[\\/]([\w.-]+\.md)/g)].map((m) => m[1]!);
      if (mentioned.some((f) => fs.existsSync(path.join(runDir, "notes", f)))) continue;
      rel = path.join("notes", `searcher-${searcherIdx}.md`);
    }
    if (!rel) continue;
    const dest = path.join(runDir, rel);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
      // output_file was observed empty in 2.1.301; task_notification.summary (agent.reply) holds the full reply.
      let text = "";
      if (a.output_file && fs.existsSync(a.output_file)) text = fs.readFileSync(a.output_file, "utf8").trim();
      if (!text && a.reply) text = a.reply.trim();
      if (!text) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `<!-- Lưu tự động bởi controller từ trả lời của vai ${a.role} (subagent không được phép ghi file) -->\n\n${text}\n`, "utf8");
    } catch {
      /* best effort */
    }
  }
}

/** Single-agent runs answer inline; keep a report.md so the UI "Báo cáo" tab and history work the same way. */
export function saveFinalAnswerAsReport(runDir: string, resultText: string | null): void {
  if (!resultText || resultText.trim().length < 1200) return;
  const dest = path.join(runDir, "report.md");
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
    fs.writeFileSync(dest, `<!-- Lưu tự động bởi controller từ câu trả lời cuối của phiên chính -->\n\n${resultText.trim()}\n`, "utf8");
  } catch {
    /* best effort */
  }
}
