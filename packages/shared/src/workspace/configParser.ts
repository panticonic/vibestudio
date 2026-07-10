import YAML from "yaml";
import type {
  WorkspaceAppDecl,
  WorkspaceConfig,
  WorkspaceExtensionDecl,
  WorkspaceHeartbeatDecl,
  WorkspaceHostTargetDecl,
  WorkspaceHostTargetName,
  WorkspaceTrustDecl,
} from "./types.js";
import { WORKSPACE_APP_PACKAGE_SCOPE, WORKSPACE_EXTENSION_PACKAGE_SCOPE } from "./types.js";
import { WORKSPACE_SOURCE_DIRS } from "./sourceDirs.js";
import { validateWorkspaceGitConfig } from "./remotes.js";

export { WORKSPACE_APP_PACKAGE_SCOPE, WORKSPACE_EXTENSION_PACKAGE_SCOPE };

export function parseWorkspaceConfigContentWithId(content: string, id: string): WorkspaceConfig {
  const config = YAML.parse(content) as WorkspaceConfig;
  config.id = id;
  validateDeclaredUnits(config);
  return config;
}

const UNIT_SOURCE_NORMALIZE = /(^\/+|\/+$)/g;
const UNIT_PACKAGE_NAME = /^@[^/\s]+\/[^/\s]+$/;
const WORKSPACE_SOURCE_DIR_SET = new Set<string>(WORKSPACE_SOURCE_DIRS);

interface DeclaredUnitDescriptor<Decl extends { source: string }> {
  section: "extensions" | "apps";
  sourceRoot: "extensions" | "apps";
  packageScope: typeof WORKSPACE_EXTENSION_PACKAGE_SCOPE | typeof WORKSPACE_APP_PACKAGE_SCOPE;
  singular: "extension" | "app";
  values: Decl[] | undefined;
  validate?: (decl: Decl) => void;
}

function normalizeDeclaredUnitSourceKey<Decl extends { source: string }>(
  source: string,
  descriptor: DeclaredUnitDescriptor<Decl>
): string {
  const normalized = normalizeDeclaredUnitSource(source);
  const sourceRootPrefix = `${descriptor.sourceRoot}/`;
  if (normalized.startsWith(sourceRootPrefix)) {
    return normalized.slice(sourceRootPrefix.length);
  }
  if (normalized.startsWith(descriptor.packageScope)) {
    return normalized.slice(descriptor.packageScope.length);
  }
  return normalized;
}

function normalizeDeclaredUnitSource(source: string): string {
  return source
    .trim()
    .replace(UNIT_SOURCE_NORMALIZE, "")
    .replace(/^workspace\//, "");
}

function validateDeclaredUnitSource<Decl extends { source: string }>(
  source: string,
  descriptor: DeclaredUnitDescriptor<Decl>
): void {
  const normalized = normalizeDeclaredUnitSource(source);
  const [firstSegment] = normalized.split("/");
  const sourceRootPrefix = `${descriptor.sourceRoot}/`;
  if (
    firstSegment &&
    WORKSPACE_SOURCE_DIR_SET.has(firstSegment) &&
    firstSegment !== descriptor.sourceRoot
  ) {
    throw new Error(
      `meta/vibestudio.yml: \`${descriptor.section}[].source\` must point under \`${descriptor.sourceRoot}/name\` or use a \`${descriptor.packageScope}name\` package name`
    );
  }
  if (normalized.startsWith(sourceRootPrefix)) {
    const sourceIdentity = normalized.slice(sourceRootPrefix.length);
    if (!/^[^/\s]+$/.test(sourceIdentity) || sourceIdentity.endsWith(".git")) {
      throw new Error(
        `meta/vibestudio.yml: \`${descriptor.section}[].source\` must be \`${descriptor.sourceRoot}/name\` or \`${descriptor.packageScope}name\``
      );
    }
    return;
  }
  if (!UNIT_PACKAGE_NAME.test(normalized) || !normalized.startsWith(descriptor.packageScope)) {
    throw new Error(
      `meta/vibestudio.yml: \`${descriptor.section}[].source\` must be \`${descriptor.sourceRoot}/name\` or \`${descriptor.packageScope}name\``
    );
  }
}

function validateDeclaredUnitList<Decl extends { source: string }>(
  descriptor: DeclaredUnitDescriptor<Decl>
): void {
  const declarations = descriptor.values;
  if (declarations === undefined) return;
  if (!Array.isArray(declarations)) {
    throw new Error(`meta/vibestudio.yml: \`${descriptor.section}\` must be a list`);
  }
  const seen = new Set<string>();
  for (const decl of declarations) {
    if (!decl || typeof decl.source !== "string" || decl.source.trim().length === 0) {
      throw new Error(
        `meta/vibestudio.yml: every \`${descriptor.section}\` entry needs a non-empty \`source\``
      );
    }
    const ref = (decl as { ref?: unknown }).ref;
    if (ref !== undefined && (typeof ref !== "string" || ref.trim().length === 0)) {
      throw new Error(
        `meta/vibestudio.yml: \`${descriptor.section}[].ref\` must be a non-empty string when provided`
      );
    }
    validateDeclaredUnitSource(decl.source, descriptor);
    descriptor.validate?.(decl);
    const key = normalizeDeclaredUnitSourceKey(decl.source, descriptor);
    if (seen.has(key)) {
      throw new Error(
        `meta/vibestudio.yml: duplicate ${descriptor.singular} declaration for "${decl.source}"`
      );
    }
    seen.add(key);
  }
}

function validateDeclaredUnits(config: WorkspaceConfig): void {
  validateDeclaredUnitList<WorkspaceExtensionDecl>({
    section: "extensions",
    sourceRoot: "extensions",
    packageScope: WORKSPACE_EXTENSION_PACKAGE_SCOPE,
    singular: "extension",
    values: config.extensions,
  });
  validateDeclaredUnitList<WorkspaceAppDecl>({
    section: "apps",
    sourceRoot: "apps",
    packageScope: WORKSPACE_APP_PACKAGE_SCOPE,
    singular: "app",
    values: config.apps,
  });
  validateHeartbeats(config.heartbeats);
  validateTrust(config.trust);
  validateHostTargets(config.hostTargets);
  validateProviders(config);
  try {
    validateWorkspaceGitConfig(config.git);
  } catch (error) {
    throw new Error(
      `meta/vibestudio.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const DECL_NAME_RE = /^[A-Za-z0-9._:-]+$/;
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

function parseDurationMs(value: string, field: string): number {
  const match = value.match(DURATION_RE);
  if (!match) {
    throw new Error(`meta/vibestudio.yml: \`${field}\` must be a duration like 30s, 5m, 1h, or 1d`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return amount * multiplier;
}

function validateClock(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`meta/vibestudio.yml: \`${field}\` must be HH:MM`);
  }
}

function validateHeartbeats(heartbeats: WorkspaceHeartbeatDecl[] | undefined): void {
  if (heartbeats === undefined) return;
  if (!Array.isArray(heartbeats)) {
    throw new Error("meta/vibestudio.yml: `heartbeats` must be a list");
  }
  const seen = new Set<string>();
  for (const heartbeat of heartbeats) {
    if (!heartbeat || typeof heartbeat.name !== "string" || !DECL_NAME_RE.test(heartbeat.name)) {
      throw new Error("meta/vibestudio.yml: every `heartbeats` entry needs a stable name");
    }
    if (seen.has(heartbeat.name)) {
      throw new Error(`meta/vibestudio.yml: duplicate heartbeat declaration "${heartbeat.name}"`);
    }
    seen.add(heartbeat.name);
    if (
      !heartbeat.target ||
      typeof heartbeat.target.source !== "string" ||
      !heartbeat.target.source.trim() ||
      typeof heartbeat.target.className !== "string" ||
      !heartbeat.target.className.trim()
    ) {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} target.source and target.className are required`
      );
    }
    if (
      heartbeat.target.objectKey !== undefined &&
      (typeof heartbeat.target.objectKey !== "string" || !heartbeat.target.objectKey.trim())
    ) {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} target.objectKey must be a non-empty string`
      );
    }
    if (!heartbeat.schedule || typeof heartbeat.schedule.every !== "string") {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} schedule.every is required`
      );
    }
    const everyMs = parseDurationMs(heartbeat.schedule.every, `heartbeats[].schedule.every`);
    if (everyMs < 60_000 || everyMs > 30 * 86_400_000) {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} schedule.every must be between 1m and 30d`
      );
    }
    if (heartbeat.schedule.jitter !== undefined) {
      const jitterMs = parseDurationMs(heartbeat.schedule.jitter, `heartbeats[].schedule.jitter`);
      if (jitterMs < 0 || jitterMs > everyMs) {
        throw new Error(
          `meta/vibestudio.yml: heartbeat ${heartbeat.name} schedule.jitter must be no larger than schedule.every`
        );
      }
    }
    if (heartbeat.schedule.at !== undefined) {
      validateClock(heartbeat.schedule.at, `heartbeats[].schedule.at`);
      if (everyMs % 86_400_000 !== 0) {
        throw new Error(
          `meta/vibestudio.yml: heartbeat ${heartbeat.name} schedule.at only applies to day-multiple intervals`
        );
      }
    }
    if (heartbeat.schedule.activeHours) {
      validateClock(
        heartbeat.schedule.activeHours.start,
        `heartbeats[].schedule.activeHours.start`
      );
      validateClock(heartbeat.schedule.activeHours.end, `heartbeats[].schedule.activeHours.end`);
    }
    const tokenBudget = heartbeat.context?.tokenBudget;
    if (
      tokenBudget !== undefined &&
      (!Number.isInteger(tokenBudget) || tokenBudget < 1000 || tokenBudget > 200_000)
    ) {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} context.tokenBudget is out of range`
      );
    }
    const maxModelCalls = heartbeat.behavior?.maxModelCalls;
    if (
      maxModelCalls !== undefined &&
      (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 10)
    ) {
      throw new Error(
        `meta/vibestudio.yml: heartbeat ${heartbeat.name} behavior.maxModelCalls is out of range`
      );
    }
    if (heartbeat.behavior?.failureBackoff?.base !== undefined) {
      parseDurationMs(
        heartbeat.behavior.failureBackoff.base,
        `heartbeats[].behavior.failureBackoff.base`
      );
    }
    if (heartbeat.behavior?.failureBackoff?.max !== undefined) {
      parseDurationMs(
        heartbeat.behavior.failureBackoff.max,
        `heartbeats[].behavior.failureBackoff.max`
      );
    }
  }
}

export function resolveDeclaredExtensions(
  config: WorkspaceConfig
): Array<{ source: string; ref: string }> {
  return resolveDeclaredUnits(config.extensions ?? []).map((decl) => ({
    source: decl.source,
    ref: decl.ref,
  }));
}

export function resolveDeclaredApps(
  config: WorkspaceConfig
): Array<{ source: string; ref: string }> {
  return (config.apps ?? []).map((decl) => ({
    source: decl.source.trim(),
    ref: (decl.ref ?? "main").trim(),
  }));
}

function resolveDeclaredUnits<Decl extends { source: string; ref?: string }>(
  declarations: Decl[]
): Array<Decl & { source: string; ref: string }> {
  return declarations.map((decl) => ({
    ...decl,
    source: decl.source.trim(),
    ref: (decl.ref ?? "main").trim(),
  }));
}

// =============================================================================
// trust / hostTargets / providers — manifest-declared host contracts
// =============================================================================

const WORKSPACE_HOST_TARGETS: readonly WorkspaceHostTargetName[] = [
  "electron",
  "react-native",
  "terminal",
];

interface CanonicalUnitKind {
  sourceRoot: "apps" | "extensions";
  packageScope: typeof WORKSPACE_APP_PACKAGE_SCOPE | typeof WORKSPACE_EXTENSION_PACKAGE_SCOPE;
}

const APP_UNIT: CanonicalUnitKind = {
  sourceRoot: "apps",
  packageScope: WORKSPACE_APP_PACKAGE_SCOPE,
};
const EXTENSION_UNIT: CanonicalUnitKind = {
  sourceRoot: "extensions",
  packageScope: WORKSPACE_EXTENSION_PACKAGE_SCOPE,
};

/**
 * Canonicalize a declared app/extension identity to its workspace-relative
 * repo path (`apps/name` / `extensions/name`). Accepts either the repo-path
 * form or the scoped package-name form. Throws with the offending manifest
 * field on anything else.
 */
function canonicalUnitRepoPath(value: unknown, kind: CanonicalUnitKind, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`meta/vibestudio.yml: \`${field}\` must be a non-empty string`);
  }
  const normalized = normalizeDeclaredUnitSource(value);
  const identity = normalized.startsWith(`${kind.sourceRoot}/`)
    ? normalized.slice(kind.sourceRoot.length + 1)
    : normalized.startsWith(kind.packageScope)
      ? normalized.slice(kind.packageScope.length)
      : null;
  if (!identity || !/^[^/\s]+$/.test(identity) || identity.endsWith(".git")) {
    throw new Error(
      `meta/vibestudio.yml: \`${field}\` must be \`${kind.sourceRoot}/name\` or \`${kind.packageScope}name\` (got ${JSON.stringify(value)})`
    );
  }
  return `${kind.sourceRoot}/${identity}`;
}

/** `apps/name` | `@workspace-apps/name` → `@workspace-apps/name`. */
export function workspaceAppPackageName(source: string): string {
  const repoPath = canonicalUnitRepoPath(source, APP_UNIT, "app source");
  return `${WORKSPACE_APP_PACKAGE_SCOPE}${repoPath.slice("apps/".length)}`;
}

/** `extensions/name` | `@workspace-extensions/name` → `@workspace-extensions/name`. */
export function workspaceExtensionPackageName(source: string): string {
  const repoPath = canonicalUnitRepoPath(source, EXTENSION_UNIT, "extension source");
  return `${WORKSPACE_EXTENSION_PACKAGE_SCOPE}${repoPath.slice("extensions/".length)}`;
}

export const WORKSPACE_EXTENSION_PROVIDER_NAMES = [
  "browserData",
  "gitInterop",
  "claudeCode",
] as const;
export type WorkspaceExtensionProviderName = (typeof WORKSPACE_EXTENSION_PROVIDER_NAMES)[number];

const WORKSPACE_EXTENSION_PROVIDERS = new Set<string>(WORKSPACE_EXTENSION_PROVIDER_NAMES);

function validateUnitSourceList(values: unknown, kind: CanonicalUnitKind, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new Error(`meta/vibestudio.yml: \`${field}\` must be a list`);
  }
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const value of values) {
    const repoPath = canonicalUnitRepoPath(value, kind, `${field}[]`);
    if (seen.has(repoPath)) {
      throw new Error(`meta/vibestudio.yml: duplicate \`${field}\` entry for "${repoPath}"`);
    }
    seen.add(repoPath);
    canonical.push(repoPath);
  }
  return canonical;
}

function validateTrust(trust: WorkspaceTrustDecl | undefined): void {
  if (trust === undefined) return;
  if (trust === null || typeof trust !== "object" || Array.isArray(trust)) {
    throw new Error("meta/vibestudio.yml: `trust` must be a mapping");
  }
  validateUnitSourceList(trust.chromeApps, APP_UNIT, "trust.chromeApps");
  validateUnitSourceList(
    trust.connectionManagementApps,
    APP_UNIT,
    "trust.connectionManagementApps"
  );
}

function validateHostTargets(hostTargets: WorkspaceConfig["hostTargets"] | undefined): void {
  if (hostTargets === undefined) return;
  if (hostTargets === null || typeof hostTargets !== "object" || Array.isArray(hostTargets)) {
    throw new Error("meta/vibestudio.yml: `hostTargets` must be a mapping");
  }
  for (const [target, decl] of Object.entries(hostTargets)) {
    if (!(WORKSPACE_HOST_TARGETS as readonly string[]).includes(target)) {
      throw new Error(
        `meta/vibestudio.yml: unknown \`hostTargets\` key "${target}" (expected one of ${WORKSPACE_HOST_TARGETS.join(", ")})`
      );
    }
    if (decl === null || decl === undefined) continue;
    if (typeof decl !== "object" || Array.isArray(decl)) {
      throw new Error(`meta/vibestudio.yml: \`hostTargets.${target}\` must be a mapping`);
    }
    canonicalUnitRepoPath(
      (decl as WorkspaceHostTargetDecl).app,
      APP_UNIT,
      `hostTargets.${target}.app`
    );
    validateUnitSourceList(
      (decl as WorkspaceHostTargetDecl).requiresExtensions,
      EXTENSION_UNIT,
      `hostTargets.${target}.requiresExtensions`
    );
  }
}

function requireProviderSource(value: unknown, field: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`meta/vibestudio.yml: \`${field}\` must be a mapping with a \`source\``);
  }
  const source = (value as { source?: unknown }).source;
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error(`meta/vibestudio.yml: \`${field}.source\` must be a non-empty string`);
  }
  return source.trim();
}

function providerExtensionRepoPath(
  config: WorkspaceConfig,
  provider: WorkspaceExtensionProviderName
): string | null {
  const declared = (config.providers?.[provider] as { extension?: unknown } | undefined)?.extension;
  if (declared === undefined) return null;
  const repoPath = canonicalUnitRepoPath(
    declared,
    EXTENSION_UNIT,
    `providers.${provider}.extension`
  );
  const isDeclared = (config.extensions ?? []).some(
    (extension) =>
      typeof extension?.source === "string" &&
      canonicalUnitRepoPath(extension.source, EXTENSION_UNIT, "extensions[].source") === repoPath
  );
  if (!isDeclared) {
    throw new Error(
      `meta/vibestudio.yml: \`providers.${provider}.extension\` (${repoPath}) must also be declared under \`extensions\``
    );
  }
  return repoPath;
}

function validateProviders(config: WorkspaceConfig): void {
  const providers = config.providers;
  if (providers === undefined) return;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("meta/vibestudio.yml: `providers` must be a mapping");
  }
  if (providers.evalEngine !== undefined) {
    requireProviderSource(providers.evalEngine, "providers.evalEngine");
  }
  if (providers.evalRuntime !== undefined) {
    requireProviderSource(providers.evalRuntime, "providers.evalRuntime");
  }
  if (providers.cdpClient !== undefined) {
    requireProviderSource(providers.cdpClient, "providers.cdpClient");
  }
  for (const provider of WORKSPACE_EXTENSION_PROVIDERS) {
    const decl = providers[provider as WorkspaceExtensionProviderName];
    if (decl === undefined) continue;
    if (decl === null || typeof decl !== "object" || Array.isArray(decl)) {
      throw new Error(
        `meta/vibestudio.yml: \`providers.${provider}\` must be a mapping with an \`extension\``
      );
    }
    providerExtensionRepoPath(config, provider as WorkspaceExtensionProviderName);
  }
}

/**
 * Resolve the manifest's app trust grants to canonical repo paths
 * (`apps/name`). Missing `trust` (or a missing list) resolves to an empty
 * grant list — trust is never assumed.
 */
export function resolveWorkspaceTrustGrants(config: WorkspaceConfig): {
  chromeApps: string[];
  connectionManagementApps: string[];
} {
  return {
    chromeApps: validateUnitSourceList(config.trust?.chromeApps, APP_UNIT, "trust.chromeApps"),
    connectionManagementApps: validateUnitSourceList(
      config.trust?.connectionManagementApps,
      APP_UNIT,
      "trust.connectionManagementApps"
    ),
  };
}

/**
 * Resolve one host target's declared app (canonical `apps/name` repo path)
 * and its required extensions (canonical `extensions/name`). Returns null
 * when the manifest declares nothing for the target.
 */
export function resolveHostTargetDecl(
  config: WorkspaceConfig,
  target: WorkspaceHostTargetName
): { appSource: string; requiresExtensions: string[] } | null {
  const decl = config.hostTargets?.[target];
  if (!decl || typeof decl !== "object") return null;
  return {
    appSource: canonicalUnitRepoPath(decl.app, APP_UNIT, `hostTargets.${target}.app`),
    requiresExtensions: validateUnitSourceList(
      decl.requiresExtensions,
      EXTENSION_UNIT,
      `hostTargets.${target}.requiresExtensions`
    ),
  };
}

/**
 * Resolve a manifest-declared extension provider slot to a package name
 * (`@workspace-extensions/name`). Unknown/missing slots return null; malformed
 * declared slots throw during config parsing before callers get here.
 */
export function workspaceProviderExtensionPackageName(
  config: WorkspaceConfig,
  provider: string
): string | null {
  if (!WORKSPACE_EXTENSION_PROVIDERS.has(provider)) return null;
  const declared = (
    config.providers?.[provider as WorkspaceExtensionProviderName] as
      | { extension?: unknown }
      | undefined
  )?.extension;
  if (typeof declared !== "string" || declared.trim().length === 0) return null;
  return workspaceExtensionPackageName(declared);
}
