import { spawn } from "node:child_process";

import { killTree } from "../design3d/cad-tools.js";
import { buildServerSpawn } from "../preview/preview.js";
import { splitCommand } from "../preview/preview-config.js";
import { redactSecrets } from "../release/redact.js";
import { WORKTREE_SETUP_LIMITS, type SetupCommandResult } from "./worktree-setup.js";

/**
 * Split a setup command into {file,args} without a shell. npm/npx/pnpm/yarn are .cmd shims on Windows, so we reuse
 * buildServerSpawn (blueprint choice): it routes them through cmd.exe after checking tokens for cmd metacharacters.
 */
export function buildSetupSpawn(command: string): { file: string; args: string[] } {
  const tokens = splitCommand(command.trim());
  if (tokens.length === 0) throw new Error("Lệnh setup trống.");
  const b = buildServerSpawn(tokens[0]!, tokens.slice(1));
  return { file: b.exe, args: b.args };
}

/** Run the setup command in cwd with a timeout; output tail is capped and secret-redacted. Never throws. */
export function runSetupCommand(a: { cwd: string; command: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<SetupCommandResult> {
  const t0 = Date.now();
  const limit = WORKTREE_SETUP_LIMITS.logTailBytes;
  const fail = (reason: string, tail = ""): SetupCommandResult => ({ ran: false, ok: false, exitCode: null, timedOut: false, tail, ms: Date.now() - t0, reason });
  let spec: { file: string; args: string[] };
  try {
    spec = buildSetupSpawn(a.command);
  } catch (e) {
    return Promise.resolve(fail(e instanceof Error ? e.message : String(e)));
  }
  return new Promise((resolve) => {
    let buf = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: SetupCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const tail = () => redactSecrets(buf.length > limit ? buf.slice(buf.length - limit) : buf);
    let child;
    try {
      child = spawn(spec.file, spec.args, { cwd: a.cwd, env: a.env ?? process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve(fail(e instanceof Error ? e.message : String(e)));
      return;
    }
    const onData = (d: string) => {
      buf += d;
      if (buf.length > limit * 4) buf = buf.slice(buf.length - limit * 2);
    };
    child.stdout?.setEncoding("utf8").on("data", onData);
    child.stderr?.setEncoding("utf8").on("data", onData);
    child.on("error", (e) => finish(fail(e.message, tail())));
    child.on("close", (code) => finish({ ran: true, ok: !timedOut && code === 0, exitCode: code, timedOut, tail: tail(), ms: Date.now() - t0 }));
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Pipes may stay open if a grandchild survives: give up waiting after a grace period.
      setTimeout(() => finish({ ran: true, ok: false, exitCode: null, timedOut: true, tail: tail(), ms: Date.now() - t0 }), 5000).unref();
    }, a.timeoutMs);
  });
}
