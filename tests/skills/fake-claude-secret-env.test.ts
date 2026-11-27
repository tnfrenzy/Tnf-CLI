import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = path.resolve(__dirname, "..", "..", "fixtures", "fake-claude.mjs");
const FAKE_KEY = "sk-ant-fake-secret-123";

let dir: string;
let outFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-secret-"));
  outFile = path.join(dir, "secret-env.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], key: string | null) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "ANTHROPIC_API_KEY") delete env[k];
  if (key !== null) env.ANTHROPIC_API_KEY = key;
  env.FAKE_CLAUDE_SECRET_ENV_FILE = outFile;
  return spawnSync(process.execPath, [fixture, ...args], { env: env as NodeJS.ProcessEnv, input: "", encoding: "utf8", windowsHide: true });
}

describe("fake-claude FAKE_CLAUDE_SECRET_ENV_FILE", () => {
  it("có khóa giả thì cờ là true và tệp không chứa giá trị khóa", () => {
    run([], FAKE_KEY);
    const raw = fs.readFileSync(outFile, "utf8");
    expect(JSON.parse(raw)).toEqual({ ANTHROPIC_API_KEY_PRESENT: true });
    expect(raw).not.toContain(FAKE_KEY);
  });

  it("không có khóa thì cờ là false", () => {
    run([], null);
    expect(JSON.parse(fs.readFileSync(outFile, "utf8"))).toEqual({ ANTHROPIC_API_KEY_PRESENT: false });
  });

  it("lệnh auth status không tạo tệp", () => {
    run(["auth", "status"], FAKE_KEY);
    expect(fs.existsSync(outFile)).toBe(false);
  });
});
