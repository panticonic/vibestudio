import { normalizeUnitRepoPath as normalizeRepoPath } from "@vibestudio/unit-host";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { AppBuildResultLike, AppRegistryEntry } from "./appHost.js";
import { TerminalAppRunner } from "./terminalAppRunner.js";

export interface AppRuntimeLog {
  workspaceId: string;
  unitName: string;
  kind: "app";
  timestamp: number;
  level: "info" | "error";
  message: string;
  source?: "stdout" | "stderr" | "runner";
}

interface TerminalRegistry {
  get(name: string): AppRegistryEntry | null;
  list(): AppRegistryEntry[];
  patch(name: string, patch: Partial<AppRegistryEntry>): AppRegistryEntry;
}

export interface TerminalAppRuntimeDeps {
  workspaceId: string;
  registry: TerminalRegistry;
  buildSystem: {
    getBuildByKey?(key: string): AppBuildResultLike | null;
  };
  connectionGrants?: Pick<ConnectionGrantService, "grant" | "revokeForPrincipal">;
  entityCache?: Pick<EntityCache, "resolve">;
  getGatewayUrl(): string;
  validateBuild(appId: string, build: AppBuildResultLike): void;
  emitStatus(appId: string, status: AppRegistryEntry["status"], error: string | null): void;
}

/** Owns terminal child-process lifecycle, connection grants, statuses, and captured output. */
export class TerminalAppRuntime {
  private readonly runner: TerminalAppRunner | null;
  private readonly logs = new Map<string, AppRuntimeLog[]>();

  constructor(private readonly deps: TerminalAppRuntimeDeps) {
    this.runner =
      deps.connectionGrants && deps.entityCache
        ? new TerminalAppRunner({
            connectionGrants: deps.connectionGrants,
            onStatus: (appId, status, error = null) => this.updateStatus(appId, status, error),
            onLog: (appId, level, message, source) => this.recordLog(appId, level, message, source),
          })
        : null;
  }

  async shutdown(): Promise<void> {
    await this.runner?.stopAll();
  }

  isRunningBuild(appId: string, buildKey: string): boolean {
    return this.runner?.isRunningBuild(appId, buildKey) === true;
  }

  async restart(sourceOrName: string): Promise<void> {
    const entry = this.findEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    if (entry.target !== "terminal") {
      throw new Error(`App ${entry.name} is not restartable by the terminal runner`);
    }
    await this.start(entry, { forceRestart: true });
  }

  async sync(entry: AppRegistryEntry, previous: AppRegistryEntry | null = null): Promise<void> {
    if (entry.target !== "terminal") return;
    if (
      !previous &&
      entry.activeBundleKey &&
      this.isRunningBuild(entry.name, entry.activeBundleKey)
    ) {
      return;
    }
    const wasRunning = previous ? this.runner?.isRunning(previous.name) === true : false;
    if (wasRunning) {
      await this.start(entry);
    } else {
      await this.stop(entry.name);
      this.deps.registry.patch(entry.name, { status: "available", lastError: null });
    }
  }

  async start(entry: AppRegistryEntry, options: { forceRestart?: boolean } = {}): Promise<void> {
    if (!this.runner) {
      this.deps.registry.patch(entry.name, {
        status: "error",
        lastError: "Terminal app runner is not configured",
      });
      this.deps.emitStatus(entry.name, "error", "Terminal app runner is not configured");
      return;
    }
    if (!entry.activeBundleKey) throw new Error(`Terminal app ${entry.name} has no active build`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) throw new Error(`Terminal app build is missing: ${entry.activeBundleKey}`);
    this.deps.validateBuild(entry.name, build);
    await this.runner.start(
      {
        appId: entry.name,
        source: normalizeRepoPath(entry.source.repo),
        buildKey: entry.activeBundleKey,
        effectiveVersion: entry.activeEv,
        gatewayUrl: this.deps.getGatewayUrl(),
        build,
        interactive: entry.interactive ?? false,
      },
      options
    );
  }

  async stop(appId: string): Promise<void> {
    await this.runner?.stop(appId);
  }

  logsFor(sourceOrName: string): AppRuntimeLog[] {
    const name = this.findEntry(sourceOrName)?.name ?? sourceOrName;
    return this.logs.get(name) ?? [];
  }

  private updateStatus(
    appId: string,
    status: "running" | "stopped" | "error",
    error: string | null
  ): void {
    const entry = this.deps.registry.get(appId);
    if (!entry || entry.target !== "terminal") return;
    const nextStatus = status === "stopped" ? "available" : status;
    this.deps.registry.patch(appId, { status: nextStatus, lastError: error });
    this.deps.emitStatus(appId, nextStatus, error);
  }

  private recordLog(
    appId: string,
    level: "info" | "error",
    message: string,
    source: "stdout" | "stderr" | "runner"
  ): void {
    const records = this.logs.get(appId) ?? [];
    records.push({
      workspaceId: this.deps.workspaceId,
      unitName: appId,
      kind: "app",
      timestamp: Date.now(),
      level,
      message,
      source,
    });
    if (records.length > 500) records.splice(0, records.length - 500);
    this.logs.set(appId, records);
  }

  private findEntry(sourceOrName: string): AppRegistryEntry | null {
    return (
      this.deps.registry.get(sourceOrName) ??
      this.deps.registry
        .list()
        .find(
          (entry) => normalizeRepoPath(entry.source.repo) === normalizeRepoPath(sourceOrName)
        ) ??
      null
    );
  }
}
