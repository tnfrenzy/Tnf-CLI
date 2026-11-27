import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setToken } from "../../ui/src/api";
import { codeVideoApi, codeVideoDownloadPath, codeVideoFilePath } from "../../ui/src/codevideo/client";

const UI = path.resolve(__dirname, "..", "..", "ui", "src");
const FILES = [
  "components/codevideo/CodeVideoCreate.tsx",
  "components/codevideo/CodeVideoRoom.tsx",
  "components/codevideo/CodeVideoSettings.tsx",
  "components/codevideo/CodeVideoPopups.tsx",
  "components/codevideo/codevideo.css",
  "codevideo/client.ts",
  "codevideo/logic.ts",
  "codevideo/useBlobUrl.ts",
];
const read = (f: string): string => fs.readFileSync(path.join(UI, f), "utf8");
const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

describe("codevideo UI source", () => {
  it("exports the components the App wires in", () => {
    expect(read("components/codevideo/CodeVideoCreate.tsx")).toMatch(/export function CodeVideoCreate\(/);
    expect(read("components/codevideo/CodeVideoRoom.tsx")).toMatch(/export function CodeVideoRoom\(/);
    expect(read("components/codevideo/CodeVideoSettings.tsx")).toMatch(/export function CodeVideoSettings\(/);
    const popups = read("components/codevideo/CodeVideoPopups.tsx");
    for (const n of ["CodeVideoCreatePopup", "CodeVideoRoomPopup", "CodeVideoSettingsPopup"]) expect(popups).toMatch(new RegExp(`export function ${n}\\(`));
  });

  it("never imports from the removed videostudio module", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/from\s+["'][^"']*videostudio/i);
  });

  it("every line with Vietnamese text goes through pick(vi, en) or is a comment", () => {
    const bad: string[] = [];
    for (const f of FILES.filter((x) => /\.tsx?$/.test(x))) {
      let inPick = 0;
      read(f)
        .split(/\r?\n/)
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          const code = line.replace(/\/\/.*$/, "");
          if (code.includes("pick(")) inPick = 1;
          if (VI.test(code) && !inPick && !/\bvi\b\s*=|"Không kết nối được tới máy chủ\."|"Yêu cầu không thành công/.test(code) && !code.includes("test(")) bad.push(`${f}:${i + 1}`);
          if (!code.includes("pick(") && !/\(\s*$/.test(code)) inPick = 0;
        });
    }
    expect(bad).toEqual([]);
  });

  it("does not use any", () => {
    for (const f of FILES.filter((x) => /\.tsx?$/.test(x))) expect(read(f), f).not.toMatch(/:\s*any\b|as any\b|<any>/);
  });

  it("buttons and inputs are labelled", () => {
    const room = read("components/codevideo/CodeVideoRoom.tsx");
    expect(room).toContain('role="progressbar"');
    expect(room).toContain("aria-valuenow");
    expect(room).toContain("POLL_MS = 1500");
    expect(read("components/codevideo/codevideo.css")).toContain(":focus-visible");
  });
});

describe("codevideo client contract", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => {
    calls.length = 0;
    setToken("t".repeat(32));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = url.endsWith("/settings") ? { reviewRounds: 1 } : url.includes("/generate") ? { state: "coding", job: { slug: "a" } } : { ok: true };
      return new Response(JSON.stringify(body), { status: url.endsWith("/missing") ? 404 : 200, headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds file URLs without a token", () => {
    expect(codeVideoFilePath("my video", "out/video.mp4")).toBe("/api/codevideo/my%20video/file?path=out%2Fvideo.mp4");
    expect(codeVideoDownloadPath("a")).toBe("/api/codevideo/a/download");
    expect(codeVideoFilePath("a", "out/video.mp4")).not.toContain("token");
  });

  it("sends the token header and JSON body", async () => {
    await codeVideoApi.create({ title: "T", brief: "B", width: 1080, height: 1920 });
    const c = calls[0]!;
    expect(c.url).toBe("/api/codevideo");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>)["x-controller-token"]).toBe("t".repeat(32));
    expect(JSON.parse(String(c.init.body))).toMatchObject({ title: "T", width: 1080 });
    await codeVideoApi.revise("a", "make it blue");
    expect(calls[1]!.url).toBe("/api/codevideo/a/revise");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ instruction: "make it blue" });
    await codeVideoApi.generate("a");
    await codeVideoApi.render("a");
    await codeVideoApi.cancel("a");
    await codeVideoApi.remove("a");
    expect(calls.slice(2).map((x) => `${x.init.method} ${x.url}`)).toEqual([
      "POST /api/codevideo/a/generate",
      "POST /api/codevideo/a/render",
      "POST /api/codevideo/a/cancel",
      "DELETE /api/codevideo/a",
    ]);
  });

  it("uploads raw bytes with an encoded x-file-name", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "ảnh logo.png");
    await codeVideoApi.uploadAsset("a", file);
    const c = calls[0]!;
    expect(c.url).toBe("/api/codevideo/a/assets");
    const h = c.init.headers as Record<string, string>;
    expect(h["x-file-name"]).toBe(encodeURIComponent("ảnh logo.png"));
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["x-controller-token"]).toBeTruthy();
    await expect(codeVideoApi.uploadAsset("a", new File([], "x.png"))).rejects.toBeInstanceOf(ApiError);
  });

  it("reads and writes settings, and turns errors into ApiError", async () => {
    await codeVideoApi.getSettings();
    await codeVideoApi.putSettings({ reviewRounds: 2 });
    expect(calls[1]!.init.method).toBe("PUT");
    await expect(codeVideoApi.get("missing")).rejects.toMatchObject({ status: 404 });
  });
});
