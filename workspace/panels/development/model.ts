import type {
  DevelopmentInstance,
  DevelopmentRun,
  DevelopmentRunEvent,
  DevelopmentSession,
  DevelopmentTarget,
} from "@vibestudio/service-schemas/development";
import type { SavedPermissionGrant } from "@vibestudio/service-schemas/permissions";
import type { GitImportedWorkspaceRepo } from "@vibestudio/service-schemas/gitInterop";

export const VIBESTUDIO_PROJECT = {
  path: "projects/vibestudio",
  remote: { name: "origin", url: "https://github.com/panticonic/vibestudio", branch: "main" },
} as const;

export function adoptedRepositoryId(imported: GitImportedWorkspaceRepo): string {
  const repositoryIds = imported.candidate.semanticEvidence.externalSnapshot.targetRepositoryIds;
  if (repositoryIds.length !== 1 || !repositoryIds[0]) {
    throw new Error(
      `Vibestudio adoption must atomically identify exactly one repository; received ${repositoryIds.length}`
    );
  }
  return repositoryIds[0];
}

/**
 * Keeps an idempotency id only while a click's outcome is ambiguous. A durable
 * refresh settles that intent; the next click is then intentionally new.
 */
export class IntentLedger {
  private readonly ids = new Map<string, string>();

  idFor(intent: string, create: () => string): string {
    const existing = this.ids.get(intent);
    if (existing) return existing;
    const next = create();
    this.ids.set(intent, next);
    return next;
  }

  settle(intent: string): void {
    this.ids.delete(intent);
  }
}

export function activeDevelopmentGrants(grants: readonly SavedPermissionGrant[]): SavedPermissionGrant[] {
  return grants.filter((grant) => grant.capability === "development.native.execute");
}

export function runSummary(run: DevelopmentRun): string {
  const state = run.state.replaceAll("-", " ");
  return `${state} · ${run.recipe.label}`;
}

export function knownEffects(run: DevelopmentRun): readonly string[] {
  if (!run.repair) return [];
  return Object.entries(run.repair.knownEffects).map(([effect, state]) => `${effect}: ${state}`);
}

export function latestLogLines(events: readonly DevelopmentRunEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.kind !== "log") return [];
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const line = (payload as Record<string, unknown>)["line"];
    return typeof line === "string" ? [line] : [];
  });
}

export function sessionStateLabel(session: DevelopmentSession): string {
  return session.state === "requires-repair" && session.repairAttention === "kept"
    ? "Repair record kept"
    : session.state.replaceAll("-", " ");
}

export function targetKey(target: DevelopmentTarget): string {
  switch (target.kind) {
    case "build-only":
      return "build-only";
    case "current-host-client":
      return `current-host-client:${target.client}`;
    case "isolated-host":
      return `isolated-host:${target.includeClient ? "with-client" : "host-only"}`;
  }
}

export function targetLabel(target: DevelopmentTarget): string {
  switch (target.kind) {
    case "build-only":
      return "Build only";
    case "current-host-client":
      return "Current host Electron client";
    case "isolated-host":
      return target.includeClient ? "Isolated host with client" : "Isolated host";
  }
}

export function instanceSummary(instance: DevelopmentInstance | null): string {
  if (!instance) return "No isolated instance";
  const route = instance.gatewayUrl ? ` · ${instance.gatewayUrl}` : "";
  return `${instance.state} · ${instance.instanceId} · generation ${instance.generationId}${route}`;
}

export function dirtyStateLabel(
  session: DevelopmentSession | null | undefined,
  routedDirty: boolean | undefined
): string {
  // A development session records the source fact durably. `application` is
  // the inherited working-chain state; `event` is an exact committed state.
  if (session?.basis.parentWorkingHead.kind === "application") {
    return "Uncommitted semantic changes included";
  }
  if (session?.basis.parentWorkingHead.kind === "event") {
    return "Clean committed semantic state";
  }
  if (routedDirty === true) return "Uncommitted semantic changes included";
  if (routedDirty === false) return "No uncommitted semantic changes reported";
  return "Working-change status is not available from this panel route";
}

export function appendUniquePage<T>(
  current: readonly T[],
  page: readonly T[],
  identity: (value: T) => string
): T[] {
  const seen = new Set(current.map(identity));
  return [...current, ...page.filter((value) => !seen.has(identity(value)))];
}
