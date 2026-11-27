import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "../../ui/src/api";

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof mockFetch>): [string, RequestInit] {
  return fn.mock.calls[0] as unknown as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

describe("library history client", () => {
  it("GETs role history with encoded id", async () => {
    setToken("tok");
    const fn = mockFetch({ versions: [] });
    const res = await api.libraryHistory("role", "a/b c");
    const [url, init] = lastCall(fn);
    expect(url.endsWith("/api/library/roles/a%2Fb%20c/history")).toBe(true);
    expect(init.method ?? "GET").toBe("GET");
    expect(res).toEqual({ versions: [] });
  });

  it("GETs item history", async () => {
    setToken("tok");
    const fn = mockFetch({ versions: [] });
    await api.libraryHistory("item", "it1");
    expect(lastCall(fn)[0].endsWith("/api/library/items/it1/history")).toBe(true);
  });

  it("POSTs restore for role and item with body", async () => {
    setToken("tok");
    for (const [kind, seg] of [["role", "roles"], ["item", "items"]] as const) {
      const fn = mockFetch({ preview: {} });
      const body = { versionId: "v1", dryRun: true, confirm: false, note: "n" };
      await api.restoreLibraryVersion(kind, "x#1", body);
      const [url, init] = lastCall(fn);
      expect(url.endsWith(`/api/library/${seg}/x%231/restore`)).toBe(true);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual(body);
      vi.unstubAllGlobals();
    }
  });

  it("saveLibraryRole sends note only when given", async () => {
    setToken("tok");
    const role = { id: "r", name: "R" } as never;
    let fn = mockFetch({ role });
    await api.saveLibraryRole(role, false);
    expect("note" in JSON.parse(lastCall(fn)[1].body as string)).toBe(false);
    fn = mockFetch({ role });
    await api.saveLibraryRole(role, false, "ghi chú");
    expect(JSON.parse(lastCall(fn)[1].body as string).note).toBe("ghi chú");
  });

  it("saveLibraryItem sends note only when given", async () => {
    setToken("tok");
    const item = { id: "i", name: "I", type: "skill" as const, content: "c", roleIds: [] };
    let fn = mockFetch({ item });
    await api.saveLibraryItem(item);
    expect("note" in JSON.parse(lastCall(fn)[1].body as string)).toBe(false);
    fn = mockFetch({ item });
    await api.saveLibraryItem(item, "n2");
    expect(JSON.parse(lastCall(fn)[1].body as string).note).toBe("n2");
  });
});
