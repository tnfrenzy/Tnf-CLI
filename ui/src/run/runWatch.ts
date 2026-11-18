/** Pure helpers to detect and label a finished run (notification + tab title). */
import { runActionState } from "./runActions.js";

export type FinishKind = "done" | "error" | "interrupted" | "needs_commit";

export interface RunWatchInput {
  kind: string;
  status: string;
  merged?: boolean;
  error?: string | null;
}

/** null while the run is not in a terminal state (or was cancelled by the user). */
export function classifyFinish(run: RunWatchInput): FinishKind | null {
  if (run.status === "error") {
    return (run.error ?? "").startsWith("subagent_interrupted") ? "interrupted" : "error";
  }
  if (run.status === "done") {
    return runActionState(run).publishNeedsMerge ? "needs_commit" : "done";
  }
  return null;
}

/** Ids that were running before and are no longer running now. */
export function diffFinished(prevIds: Iterable<string>, currentRunningIds: Iterable<string>): string[] {
  const cur = new Set(currentRunningIds);
  return [...prevIds].filter((id) => !cur.has(id));
}

const PREFIX: Record<FinishKind, string> = {
  done: "Xong",
  error: "Lỗi",
  interrupted: "Bị cắt",
  needs_commit: "Cần commit",
};

export function buildTitle(kind: FinishKind, projectName: string): string {
  return `${PREFIX[kind]}: ${projectName}`;
}
