import type { RunManager } from "../core/run/run-manager.js";
import type { RunStore } from "../core/run/run-store.js";
import type { createSkillStore } from "../core/skill-workshop/store.js";
import type { createSkillTrainer } from "../core/skill-workshop/runner.js";
import type { Workshop3DEngine } from "../core/workshop3d/index.js";
import type { ServerOptions } from "./http.js";
import type { createSkillsGen } from "./skills-gen.js";

/** Per-server objects shared by the route modules in `./routes` (built once in createServer). */
export interface ApiContext {
  manager: RunManager;
  store: RunStore;
  opts: ServerOptions;
  /** 3D workshop engine and, when it could not be created, why (its routes then answer 503). */
  w3d: { engine: Workshop3DEngine | null; error: string | null };
  workshop3d: Workshop3DEngine | null;
  skillStore: ReturnType<typeof createSkillStore>;
  skillTrainer: ReturnType<typeof createSkillTrainer>;
  skillsGen: ReturnType<typeof createSkillsGen>;
}
