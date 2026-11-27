// Loads the first existing project file of a candidate list as an object URL (released on change and on unmount).
import { useEffect, useRef, useState } from "react";
import { codeVideoFileBlob } from "./client";

export type BlobStatus = "loading" | "ready" | "missing";

/**
 * `rels` are tried in order; the first that loads wins. `stamp` changes when the file was rewritten (same name, new
 * content) so it is fetched again. An empty list means nothing to load.
 */
export function useBlobUrl(slug: string, rels: readonly string[], stamp: string): { url: string | null; status: BlobStatus; rel: string | null } {
  const [state, setState] = useState<{ url: string | null; status: BlobStatus; rel: string | null }>({ url: null, status: rels.length ? "loading" : "missing", rel: null });
  const current = useRef<string | null>(null);
  const key = rels.join("|");

  useEffect(() => {
    if (!rels.length) {
      setState({ url: null, status: "missing", rel: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, status: s.url ? "ready" : "loading" }));
    void (async () => {
      for (const rel of rels) {
        try {
          const blob = await codeVideoFileBlob(slug, rel);
          if (!alive) return;
          const next = URL.createObjectURL(blob);
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = next;
          setState({ url: next, status: "ready", rel });
          return;
        } catch {
          /* try the next candidate */
        }
      }
      if (alive) {
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = null;
        setState({ url: null, status: "missing", rel: null });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, key, stamp]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = null;
    },
    [],
  );

  return state;
}
