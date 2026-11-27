import type { RoleEvalCase, RoleEvalsResponse } from "../../types";

// Stub: will be replaced by the re-view command.
export interface RoleEvalViewProps {
  data: RoleEvalsResponse;
  draft: RoleEvalCase[];
  repeats: number;
  busy: boolean;
  error: string | null;
  onDraft: (cases: RoleEvalCase[]) => void;
  onRepeats: (n: number) => void;
  onSave: () => void;
  onRun: () => void;
  onCancel: () => void;
}

export function RoleEvalView(p: RoleEvalViewProps) {
  return (
    <div className="role-eval">
      <p>{p.draft.length} cases</p>
      <input type="number" value={p.repeats} onChange={(e) => p.onRepeats(Number(e.target.value))} />
      <button disabled={p.busy} onClick={p.onSave}>Save</button>
      <button disabled={p.busy || p.data.running} onClick={p.onRun}>Run</button>
      <button disabled={!p.data.running} onClick={p.onCancel}>Cancel</button>
      {p.error ? <p className="error">{p.error}</p> : null}
    </div>
  );
}
