import type { CliProviderId } from "../../shared-types.js";
import { ClaudeProvider } from "./claude-provider.js";
import type { CliProvider } from "./types.js";

const CLAUDE = new ClaudeProvider();

export const CLI_PROVIDERS: Record<CliProviderId, CliProvider> = {
  claude: CLAUDE,
};

export function getCliProvider(id: CliProviderId): CliProvider {
  return CLI_PROVIDERS[id];
}

export function listCliProviders(): CliProvider[] {
  return [CLAUDE];
}
