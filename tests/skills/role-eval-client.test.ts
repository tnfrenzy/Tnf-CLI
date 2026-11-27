import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "../../ui/src/api";
import type { RoleEvalCase, RoleEvalsResponse } from "../../ui/src/types";

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof mockFetch>): [string, RequestInit] {
  return fn.mock.calls[0] as unknown as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

const weird = "a/b c?#";
const enc = encodeURIComponent(weird);

const cases: RoleEvalCase[] = [
  { id: "c1", title: "T", prompt: "P", checks: [{ type: "contains", value: "x" }, { type: "no-tool", names: ["Bash"] }], passRatio: 0.5 },
];

describe("role evals client", () => {
  it("roleEvals GETs the evals path and returns the object", async () => {
    setToken("tok123");
    const res: RoleEvalsResponse = { cases, results: [], version: "v1", running: false };
    const fn = mockFetch(res);
    const out = await api.roleEvals("dev");
    const [url, init] = lastCall(fn);
    expect(url.endsWith("/api/library/roles/dev/evals")).toBe(true);
    expect(init.method ?? "GET").toBe("GET");
    expect(out).toEqual(res);
  });

  it("encodes special ids in all four functions", async () => {
    setToken("tok123");
    const calls: [string, RequestInit][] = [];
    for (const [call, suffix] of [
      [() => api.roleEvals(weird), "/evals"],
      [() => api.saveRoleEvals(weird, cases), "/evals"],
      [() => api.runRoleEvals(weird), "/evals/run"],
      [() => api.cancelRoleEvals(weird), "/evals/cancel"],
    ] as const) {
      const fn = mockFetch({});
      await call();
      const c = lastCall(fn);
      calls.push(c);
      expect(c[0].endsWith(`/api/library/roles/${enc}${suffix}`)).toBe(true);
    }
    expect(calls).toHaveLength(4);
  });

  it("saveRoleEvals PUTs {cases} and returns {cases}", async () => {
    setToken("tok123");
    const fn = mockFetch({ cases });
    const out = await api.saveRoleEvals("dev", cases);
    const [url, init] = lastCall(fn);
    expect(url.endsWith("/api/library/roles/dev/evals")).toBe(true);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ cases });
    expect(out).toEqual({ cases });
  });

  it("runRoleEvals POSTs repeats and works without repeats", async () => {
    setToken("tok123");
    const fn = mockFetch({ started: true });
    const out = await api.runRoleEvals("dev", 3);
    const [url, init] = lastCall(fn);
    expect(url.endsWith("/api/library/roles/dev/evals/run")).toBe(true);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ repeats: 3 });
    expect(out).toEqual({ started: true });

    const fn2 = mockFetch({ started: true });
    const out2 = await api.runRoleEvals("dev");
    expect(lastCall(fn2)[1].method).toBe("POST");
    expect(out2).toEqual({ started: true });
  });

  it("cancelRoleEvals POSTs to /evals/cancel", async () => {
    setToken("tok123");
    const fn = mockFetch({ cancelled: true });
    const out = await api.cancelRoleEvals("dev");
    const [url, init] = lastCall(fn);
    expect(url.endsWith("/api/library/roles/dev/evals/cancel")).toBe(true);
    expect(init.method).toBe("POST");
    expect(out).toEqual({ cancelled: true });
  });

  it("sends the token header on every request", async () => {
    setToken("tok123");
    for (const call of [
      () => api.roleEvals("dev"),
      () => api.saveRoleEvals("dev", cases),
      () => api.runRoleEvals("dev", 1),
      () => api.cancelRoleEvals("dev"),
    ]) {
      const fn = mockFetch({});
      await call();
      const headers = lastCall(fn)[1].headers as Record<string, string>;
      expect(headers["x-controller-token"]).toBe("tok123");
    }
  });
});
