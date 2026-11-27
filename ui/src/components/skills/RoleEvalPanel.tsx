import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { buildRunRequest, nextPollDelay } from "../../skills/roleEval";
import type { RoleEvalCase, RoleEvalsResponse } from "../../types";
import { RoleEvalView } from "./RoleEvalView";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function RoleEvalPanel({ roleId }: { roleId: string }) {
  const { t } = useT();
  const [data, setData] = useState<RoleEvalsResponse | null>(null);
  const [draft, setDraft] = useState<RoleEvalCase[]>([]);
  const [repeats, setRepeats] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.roleEvals(roleId);
      setData(d);
      setDraft(d.cases);
    } catch (e) {
      setError(msg(e));
    }
  }, [roleId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data?.running) return;
    const d = nextPollDelay(true);
    if (d == null) return;
    const h = setTimeout(() => void load(), d);
    return () => clearTimeout(h);
  }, [data, load]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => guard(() => api.saveRoleEvals(roleId, draft));
  const onRun = () =>
    guard(async () => {
      await api.runRoleEvals(roleId, buildRunRequest(repeats).repeats);
      await load();
    });
  const onCancel = () =>
    guard(async () => {
      await api.cancelRoleEvals(roleId);
      await load();
    });

  if (!data) return <p className="muted">{t.lib_eval_loading}</p>;
  return (
    <RoleEvalView
      data={data}
      draft={draft}
      repeats={repeats}
      busy={busy}
      error={error}
      onDraft={setDraft}
      onRepeats={setRepeats}
      onSave={() => void onSave()}
      onRun={() => void onRun()}
      onCancel={() => void onCancel()}
    />
  );
}
