import type { Dict } from "../i18n";
import { SHARED_PROJECT } from "./iso/floors";

/** Modal title of a floor popup: "Tầng 1 · TNF". Single definition; empty name = default floor. Pure. */
export function floorTitle(n: number, name: string, t: Pick<Dict, "city_floor">): string {
  return `${t.city_floor} ${n} · ${name || SHARED_PROJECT}`;
}
