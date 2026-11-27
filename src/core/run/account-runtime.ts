import { getCliProvider } from "./providers/registry.js";
import type { CliAccountStore } from "./cli-accounts.js";
import type { CliAccountPublic, CliAccountRuntimeStatus, CliModelChoice } from "../shared-types.js";
import type { ManagerOptions } from "./run-manager.js";

/** Runtime view of CLI accounts: in-memory cooldown cache (backed by the persistent store), model lists, binary resolution and status checks. */
export class AccountRuntime {
  private readonly accountCooldowns = new Map<string, number>();
  private readonly accountModelsCache = new Map<string, CliModelChoice[]>();

  constructor(private readonly opts: ManagerOptions, private readonly getAccounts: () => CliAccountStore) {}

  private get cliAccounts(): CliAccountStore {
    return this.getAccounts();
  }

  isAccountCoolingDown(accountId: string, now = Date.now()): boolean {
    const mem = this.accountCooldowns.get(accountId);
    if (mem && mem > now) return true;
    if (mem && mem <= now) this.accountCooldowns.delete(accountId);
    const persisted = this.cliAccounts.getCooldownUntil(accountId, now);
    if (persisted && persisted > now) {
      this.accountCooldowns.set(accountId, persisted);
      return true;
    }
    return false;
  }

  getAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
    const mem = this.accountCooldowns.get(accountId);
    if (mem && mem > now) return mem;
    const persisted = this.cliAccounts.getCooldownUntil(accountId, now);
    if (persisted && persisted > now) {
      this.accountCooldowns.set(accountId, persisted);
      return persisted;
    }
    return null;
  }

  markAccountCooldown(accountId: string, untilMs: number): void {
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      this.accountCooldowns.set(accountId, untilMs);
      this.cliAccounts.markCooldown(accountId, untilMs);
    }
  }

  clearAccountCooldown(accountId: string): boolean {
    this.accountCooldowns.delete(accountId);
    return this.cliAccounts.clearCooldown(accountId);
  }

  resolveBinaryForAccount(account: CliAccountPublic): { binaryPath: string; argsPrefix: string[] } {
    const provider = getCliProvider(account.provider);
    if (this.opts.claudePath) return { binaryPath: this.opts.claudePath, argsPrefix: [...(this.opts.claudeArgsPrefix ?? [])] };
    const p = provider.locate(account.binaryPath ?? this.opts.config.claudePath, this.opts.env ?? process.env);
    return { binaryPath: p, argsPrefix: [] };
  }

  modelsForAccount(account: CliAccountPublic, refresh = false): CliModelChoice[] {
    if (!refresh) {
      const cached = this.accountModelsCache.get(account.id);
      if (cached && cached.length > 0) return cached;
    }
    const provider = getCliProvider(account.provider);
    const fallback: CliModelChoice[] = account.provider === "claude" ? this.opts.config.models : [];
    try {
      const { binaryPath, argsPrefix } = this.resolveBinaryForAccount(account);
      const env = provider.sanitizeEnv(this.cliAccounts.envForAccount(account, this.opts.env ?? process.env));
      const models = provider.listModels(binaryPath, env, fallback, argsPrefix);
      this.accountModelsCache.set(account.id, models);
      return models;
    } catch {
      const models = provider.listModels("", this.opts.env ?? process.env, fallback);
      this.accountModelsCache.set(account.id, models);
      return models;
    }
  }

  async checkAccountStatus(accountId: string, refreshModels = true): Promise<CliAccountRuntimeStatus> {
    const account = this.cliAccounts.get(accountId);
    if (!account) throw new Error(`Không tìm thấy tài khoản CLI "${accountId}".`);
    const provider = getCliProvider(account.provider);
    const now = Date.now();
    const cooldownUntil = this.isAccountCoolingDown(account.id, now) ? (this.accountCooldowns.get(account.id) ?? null) : null;
    let binaryPath: string | null = null;
    let argsPrefix: string[] = [];
    try {
      const resolved = this.resolveBinaryForAccount(account);
      binaryPath = resolved.binaryPath;
      argsPrefix = resolved.argsPrefix;
    } catch (e) {
      return {
        accountId: account.id,
        provider: account.provider,
        installed: false,
        binaryPath: null,
        version: null,
        loggedIn: false,
        authMethod: "none",
        error: e instanceof Error ? e.message : String(e),
        checkedAt: now,
        models: this.modelsForAccount(account, false),
        cooldownUntil,
      };
    }
    const accEnv = this.cliAccounts.envForAccount(account, this.opts.env ?? process.env);
    const version = provider.readVersion(binaryPath, provider.sanitizeEnv(accEnv), argsPrefix);
    const models = this.modelsForAccount(account, refreshModels);
    try {
      const { status } = await provider.checkAuth(binaryPath, accEnv, argsPrefix);
      return {
        accountId: account.id,
        provider: account.provider,
        installed: true,
        binaryPath,
        version,
        loggedIn: status.loggedIn,
        authMethod: status.authMethod,
        ...(status.email ? { email: status.email } : {}),
        ...(status.subscriptionType ? { subscriptionType: status.subscriptionType } : {}),
        ...(status.orgName ? { orgName: status.orgName } : {}),
        checkedAt: now,
        models,
        cooldownUntil,
      };
    } catch (e) {
      return {
        accountId: account.id,
        provider: account.provider,
        installed: true,
        binaryPath,
        version,
        loggedIn: false,
        authMethod: "none",
        error: e instanceof Error ? e.message : String(e),
        checkedAt: now,
        models,
        cooldownUntil,
      };
    }
  }
}
