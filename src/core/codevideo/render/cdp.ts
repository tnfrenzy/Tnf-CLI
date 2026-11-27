import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PageSpawnFn = (command: string, args: string[]) => ChildProcess;

export interface LaunchOptions {
  browserPath: string;
  /** Project directory: the only place file:// navigation/subresources may come from. */
  projectDir: string;
  signal?: AbortSignal | undefined;
  /** Test seam; defaults to node:child_process spawn with shell:false. */
  spawn?: PageSpawnFn | undefined;
  startupTimeoutMs?: number | undefined;
  commandTimeoutMs?: number | undefined;
}

export interface ScreenshotOptions {
  format: "jpeg" | "png";
  quality?: number | undefined;
  width: number;
  height: number;
  /** Output scale applied through the capture clip (draft = 0.5). */
  scale: number;
}

/** What the renderer needs from a page. Real implementation below; tests pass fakes. */
export interface PageSession {
  setViewport(width: number, height: number): Promise<void>;
  navigate(url: string, timeoutMs: number): Promise<void>;
  evaluate(expression: string, timeoutMs: number): Promise<unknown>;
  screenshot(opts: ScreenshotOptions): Promise<Buffer>;
  /** Recent uncaught page errors / console errors, for diagnostics returned to Claude. */
  pageErrors(): string[];
  close(): Promise<void>;
}

export type LaunchFn = (opts: LaunchOptions) => Promise<PageSession>;

export interface DevToolsEndpoint {
  port: number;
  browserPath: string | null;
}

/**
 * Parse the DevToolsActivePort file ("9222\n/devtools/browser/<guid>") or the
 * stderr banner ("DevTools listening on ws://127.0.0.1:9222/devtools/browser/<guid>").
 */
export function parseDevToolsPort(text: string): DevToolsEndpoint | null {
  const banner = /DevTools listening on ws:\/\/[^:\s]+:(\d+)(\/devtools\/browser\/[\w-]+)?/.exec(text);
  if (banner) {
    const port = Number(banner[1]);
    if (port > 0 && port < 65536) return { port, browserPath: banner[2] ?? null };
  }
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  if (/^\d{2,5}$/.test(first)) {
    const port = Number(first);
    if (port > 0 && port < 65536) {
      const second = lines[1]?.trim();
      return { port, browserPath: second && second.startsWith("/devtools/") ? second : null };
    }
  }
  return null;
}

export function buildBrowserArgs(userDataDir: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--allow-file-access-from-files",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
    "about:blank",
  ];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function samePathInside(root: string, candidate: string): boolean {
  const norm = (p: string): string => {
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      /* keep resolved */
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const r = norm(root);
  const c = norm(candidate);
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when the URL may be loaded: data:/blob:/about: or a file:// path inside the project. */
export function isAllowedUrl(rawUrl: string, projectDir: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
  if (u.protocol !== "file:") return false;
  let filePath: string;
  try {
    filePath = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  // file:///C:/dir/x -> /C:/dir/x
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
  return samePathInside(projectDir, filePath);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type EventHandler = (params: Record<string, unknown>) => void;

/** Minimal CDP client over the WebSocket built into Node 22+. */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly defaultTimeoutMs: number,
  ) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data === "string") this.onMessage(data);
    });
    ws.addEventListener("close", () => this.failAll(new Error("Kết nối tới trình duyệt đã đóng.")));
    ws.addEventListener("error", () => this.failAll(new Error("Lỗi kết nối tới trình duyệt.")));
  }

  static connect(url: string, defaultTimeoutMs: number, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("Hết thời gian kết nối tới trình duyệt."));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws, defaultTimeoutMs));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Không kết nối được tới trình duyệt."));
      });
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? "lỗi CDP"}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) for (const h of [...set]) h(msg.params ?? {});
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Kết nối tới trình duyệt đã đóng."));
    const id = this.nextId++;
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hết thời gian chờ trình duyệt (${method}, ${Math.round(ms / 1000)}s).`));
      }, ms);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const defaultSpawn: PageSpawnFn = (command, args) =>
  nodeSpawn(command, args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

async function readEndpoint(
  userDataDir: string,
  stderrText: () => string,
  exited: () => boolean,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DevToolsEndpoint> {
  const deadline = Date.now() + timeoutMs;
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Đã hủy.");
    const fromStderr = parseDevToolsPort(stderrText());
    if (fromStderr) return fromStderr;
    try {
      const fromFile = parseDevToolsPort(fs.readFileSync(portFile, "utf8"));
      if (fromFile) return fromFile;
    } catch {
      /* not there yet */
    }
    if (exited()) throw new Error("Trình duyệt đã thoát trước khi sẵn sàng.");
    await sleep(50);
  }
  throw new Error("Hết thời gian chờ trình duyệt khởi động.");
}

async function httpJson(url: string, method: "GET" | "PUT", timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

interface TargetInfo {
  type?: string;
  webSocketDebuggerUrl?: string;
}

async function findPageWsUrl(port: number): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = (await httpJson(`${base}/json/list`, "GET", 3000)) as TargetInfo[];
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    if (attempt === 10) {
      try {
        const created = (await httpJson(`${base}/json/new?about:blank`, "PUT", 3000)) as TargetInfo;
        if (created.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
      } catch {
        /* retry */
      }
    }
    await sleep(100);
  }
  throw new Error("Không tìm thấy trang trong trình duyệt.");
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    try {
      const k = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
      k.on("error", () => undefined);
    } catch {
      /* ignore */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

/** Launch a private headless browser instance and return a page session. Always cleans up its temp dir. */
export const launchPage: LaunchFn = async (opts) => {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const cmdTimeout = opts.commandTimeoutMs ?? 30_000;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-cv-"));
  let child: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let exited = false;
  let closing: Promise<void> | null = null;
  const errors: string[] = [];

  const closeAll = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (client) client.close();
      if (child && !exited) {
        const c = child;
        const gone = new Promise<void>((resolve) => c.once("exit", () => resolve()));
        killTree(c);
        await Promise.race([gone, sleep(4000)]);
      }
      try {
        await fs.promises.rm(userDataDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
      } catch {
        /* best effort */
      }
    })();
    return closing;
  };

  const onAbort = (): void => {
    void closeAll();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let stderr = "";
    child = spawnFn(opts.browserPath, buildBrowserArgs(userDataDir));
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 20_000) stderr += d.toString("utf8");
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", () => {
      exited = true;
    });

    const endpoint = await readEndpoint(userDataDir, () => stderr, () => exited, opts.startupTimeoutMs ?? 20_000, opts.signal);
    const pageWs = await findPageWsUrl(endpoint.port);
    const c = await CdpClient.connect(pageWs, cmdTimeout);
    client = c;

    c.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      const text = d?.exception?.description ?? d?.text ?? "lỗi không rõ";
      if (errors.length < 20) errors.push(String(text).split("\n").slice(0, 3).join(" | "));
    });
    c.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error") return;
      const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
      if (errors.length < 20) errors.push(`console.error: ${text.slice(0, 300)}`);
    });
    c.on("Fetch.requestPaused", (p) => {
      const requestId = String(p.requestId);
      const url = (p.request as { url?: string } | undefined)?.url ?? "";
      if (isAllowedUrl(url, opts.projectDir)) {
        void c.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      } else {
        if (errors.length < 20) errors.push(`Đã chặn tài nguyên ngoài thư mục dự án: ${url.slice(0, 120)}`);
        void c.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      }
    });
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

    const session: PageSession = {
      async setViewport(width, height) {
        await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      },
      async navigate(url, timeoutMs) {
        if (!isAllowedUrl(url, opts.projectDir) || !url.startsWith("file:")) {
          throw new Error("Chỉ được mở tệp trong thư mục dự án.");
        }
        const loaded = new Promise<void>((resolve) => {
          const off = c.on("Page.loadEventFired", () => {
            off();
            resolve();
          });
        });
        const nav = await c.send<{ errorText?: string }>("Page.navigate", { url }, timeoutMs);
        if (nav.errorText) throw new Error(`Không mở được trang: ${nav.errorText}`);
        await Promise.race([
          loaded,
          sleep(timeoutMs).then(() => {
            throw new Error("Hết thời gian chờ trang tải xong.");
          }),
        ]);
      },
      async evaluate(expression, timeoutMs) {
        const r = await c.send<{
          result?: { value?: unknown };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (r.exceptionDetails) {
          const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "lỗi JavaScript";
          throw new Error(String(d).split("\n").slice(0, 4).join(" | "));
        }
        return r.result?.value;
      },
      async screenshot(o) {
        const r = await c.send<{ data: string }>("Page.captureScreenshot", {
          format: o.format,
          ...(o.format === "jpeg" ? { quality: o.quality ?? 92 } : {}),
          clip: { x: 0, y: 0, width: o.width, height: o.height, scale: o.scale },
          fromSurface: true,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        });
        return Buffer.from(r.data, "base64");
      },
      pageErrors: () => [...errors],
      async close() {
        opts.signal?.removeEventListener("abort", onAbort);
        await closeAll();
      },
    };
    return session;
  } catch (e) {
    opts.signal?.removeEventListener("abort", onAbort);
    await closeAll();
    throw e;
  }
};

export function projectFileUrl(projectDir: string, indexFile: string): string {
  return pathToFileURL(path.resolve(projectDir, indexFile)).href;
}
