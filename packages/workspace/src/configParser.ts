import {
  WorkspaceAppCompatibilitySchema,
  appCompatibilityError,
} from "@vibestudio/workspace-contracts/appCompatibility";
import {
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
} from "./templateManifest.js";
import YAML from "yaml";
import { z, ZodError, type ZodIssue } from "zod";
import type {
  WorkspaceClientDecl,
  WorkspaceConfig,
  WorkspaceExtensionDecl,
  WorkspaceTrustDecl,
} from "@vibestudio/workspace-contracts/types";
import {
  CLIENT_RUNTIMES,
  HOST_KINDS,
  type ClientRuntime,
  type HostKind,
} from "@vibestudio/workspace-contracts/clients";
import {
  WORKSPACE_CLIENT_PACKAGE_SCOPE,
  WORKSPACE_EXTENSION_PACKAGE_SCOPE,
  WORKSPACE_SOURCE_DIRS,
} from "@vibestudio/workspace-contracts/sourceDirs";
import {
  WorkspaceConfigSchema,
  WorkspaceServiceExportSchema,
  WorkspaceTemplateAuthoringMetadataSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { WORKSPACE_SYSTEM_EPOCH, WORKSPACE_APP_VERSION } from "@vibestudio/shared/vcs/systemEpoch";

export { WORKSPACE_CLIENT_PACKAGE_SCOPE, WORKSPACE_EXTENSION_PACKAGE_SCOPE };

export const WORKSPACE_CONFIG_PATH = "meta/vibestudio.yml";

/**
 * The workspace manifest's content is wrong (missing, unparsable, or violating
 * its schema). The author wrote it, so it is a source error to repair, not an
 * infrastructure failure of reading it.
 */
export class WorkspaceConfigInvalidError extends Error {
  override readonly name = "WorkspaceConfigInvalidError";
}

export interface WorkspaceConfigReader {
  readText(path: string): Promise<string | null>;
}

/** Forward-stable dispatch envelope; intentionally ignores every other field. */
export function parseWorkspaceSystemEpochEnvelope(content: string): number {
  const value: unknown = YAML.parse(content);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("meta/vibestudio.yml must contain a configuration mapping");
  }
  const systemEpoch = (value as Record<string, unknown>)["systemEpoch"];
  if (!Number.isSafeInteger(systemEpoch) || (systemEpoch as number) < 0) {
    throw new Error("meta/vibestudio.yml: `systemEpoch` must be a nonnegative integer");
  }
  return systemEpoch as number;
}

/** Read the dispatch requirements without interpreting another host's runtime schema. */
export function parseWorkspaceAppCompatibilityEnvelope(content: string) {
  return WorkspaceAppCompatibilitySchema.parse(YAML.parse(content));
}

/**
 * Read the single runtime manifest published at one immutable workspace state.
 *
 * The manifest holds complete desired settings. Selected service contracts
 * are resolved from repository manifests in the same immutable tree;
 * installation history is owned separately by the source service.
 */
export async function readWorkspaceConfig(
  reader: WorkspaceConfigReader,
  id: string
): Promise<WorkspaceConfig> {
  const content = await reader.readText(WORKSPACE_CONFIG_PATH);
  if (content === null) throw new WorkspaceConfigInvalidError(`${WORKSPACE_CONFIG_PATH} is missing`);
  let runtime: ReturnType<typeof rootRuntimeFromTemplateManifest>;
  try {
    runtime = rootRuntimeFromTemplateManifest(
      parseTemplateManifestContent(content, parseWorkspaceSystemEpochEnvelope(content))
    );
  } catch (error) {
    throw workspaceConfigError(error);
  }
  const manifests = new Map(
    await Promise.all(
      [...new Set((runtime.services ?? []).map((service) => service.source))].map(
        async (source) => {
          normalizeWorkspaceRepoPath(source);
          return [source, await reader.readText(`${source}/package.json`)] as const;
        }
      )
    )
  );
  try {
    return parseWorkspaceConfigContentWithId(content, id, (source) => manifests.get(source) ?? null);
  } catch (error) {
    throw error instanceof WorkspaceConfigInvalidError ? error : workspaceConfigError(error);
  }
}

function workspaceConfigIssueMessage(issue: ZodIssue, file = WORKSPACE_CONFIG_PATH): string {
  const path = issue.path.join(".");
  if (
    issue.code === "invalid_type" &&
    issue.path[issue.path.length - 1] === "source" &&
    typeof issue.path[issue.path.length - 2] === "number"
  ) {
    return `${file}: every \`${String(issue.path[0])}\` entry needs a non-empty \`source\``;
  }
  if (issue.code === "unrecognized_keys") {
    const owner = path || "workspace configuration";
    return `${file}: unknown \`${owner}\` key ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
  }
  if (issue.code === "invalid_type" && issue.expected === "array") {
    return `${file}: \`${path}\` must be a list`;
  }
  return `${file}: \`${path}\`: ${issue.message}`;
}

/** A selected service's package.json is its own source file: errors in it name it, not the manifest. */
function parseServicePackage(source: string, content: string) {
  const file = `${source}/package.json`;
  try {
    return z
      .object({ vibestudio: z.object({ services: z.array(WorkspaceServiceExportSchema) }) })
      .parse(JSON.parse(content));
  } catch (error) {
    const detail =
      error instanceof ZodError && error.issues[0]
        ? workspaceConfigIssueMessage(error.issues[0], file)
        : `${file}: ${error instanceof Error ? error.message : String(error)}`;
    throw new WorkspaceConfigInvalidError(detail, { cause: error });
  }
}

function workspaceConfigError(error: unknown): WorkspaceConfigInvalidError {
  if (error instanceof WorkspaceConfigInvalidError) return error;
  const detail =
    error instanceof ZodError
      ? error.issues[0]
        ? workspaceConfigIssueMessage(error.issues[0])
        : "Invalid workspace configuration"
      : error instanceof Error
        ? error.message
        : String(error);
  return new WorkspaceConfigInvalidError(
    detail.startsWith("meta/vibestudio.yml") ? detail : `meta/vibestudio.yml: ${detail}`,
    { cause: error }
  );
}

export function parseWorkspaceConfigContentWithId(
  content: string,
  id: string,
  readServiceManifest: (source: string) => string | null = () => null
): WorkspaceConfig {
  const yamlValue: unknown = YAML.parse(content);
  if (yamlValue === null || typeof yamlValue !== "object" || Array.isArray(yamlValue)) {
    throw new Error("meta/vibestudio.yml must contain a configuration mapping");
  }
  if (Object.prototype.hasOwnProperty.call(yamlValue, "id")) {
    throw new Error(
      "meta/vibestudio.yml: `id` is resolved by the host and must not be declared in workspace source"
    );
  }
  const { template: _template, ...authored } = yamlValue as Record<string, unknown>;
  let runtime = authored;
  if (_template !== undefined) {
    const metadata = WorkspaceTemplateAuthoringMetadataSchema.safeParse(_template);
    if (!metadata.success) {
      const issue = metadata.error.issues[0];
      throw new Error(
        issue
          ? workspaceConfigIssueMessage({ ...issue, path: ["template", ...issue.path] })
          : "Invalid meta/vibestudio.yml template metadata"
      );
    }
  }
  let config: WorkspaceConfig;
  try {
    runtime = rootRuntimeFromTemplateManifest(
      parseTemplateManifestContent(content, authored["systemEpoch"] as number)
    ) as unknown as Record<string, unknown>;
    // Every contract comes from the same immutable source tree as its selection.
    const services = (
      runtime["services"] as Array<{ source: string; name: string }> | undefined
    )?.map((selection) => {
      const { source, name } = selection;
      normalizeWorkspaceRepoPath(source);
      const content = readServiceManifest(source);
      if (content === null) throw new Error(`Service ${name} requires ${source}/package.json`);
      const pkg = parseServicePackage(source, content);
      const exported = pkg.vibestudio.services.filter((service) => service.name === name);
      if (exported.length !== 1)
        throw new Error(`${source}/package.json must export service ${name} exactly once`);
      return { ...exported[0]!, source };
    });
    config = WorkspaceConfigSchema.parse({
      ...runtime,
      ...(services === undefined ? {} : { services }),
      id,
    });
  } catch (error) {
    throw workspaceConfigError(error);
  }
  return validateResolvedWorkspaceConfig(config);
}

export function validateResolvedWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  if (config.systemEpoch !== WORKSPACE_SYSTEM_EPOCH) {
    throw new Error(
      `meta/vibestudio.yml: systemEpoch ${config.systemEpoch} requires workspace host epoch ${config.systemEpoch}, but this process is epoch ${WORKSPACE_SYSTEM_EPOCH}; open it through the current hub or publish a prepared change with epochTransition`
    );
  }
  const compatibilityError = appCompatibilityError(
    WorkspaceAppCompatibilitySchema.parse(config),
    WORKSPACE_APP_VERSION
  );
  if (compatibilityError) throw new Error(compatibilityError);
  validateDeclaredUnits(config);
  return config;
}

const UNIT_SOURCE_NORMALIZE = /(^\/+|\/+$)/g;
const UNIT_PACKAGE_NAME = /^@[^/\s]+\/[^/\s]+$/;
const WORKSPACE_SOURCE_DIR_SET = new Set<string>(WORKSPACE_SOURCE_DIRS);

interface DeclaredUnitDescriptor<Decl extends { source: string }> {
  section: "extensions" | "clients";
  sourceRoot: "extensions" | "clients";
  packageScope: typeof WORKSPACE_EXTENSION_PACKAGE_SCOPE | typeof WORKSPACE_CLIENT_PACKAGE_SCOPE;
  singular: "extension" | "client";
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
  return source.trim().replace(UNIT_SOURCE_NORMALIZE, "");
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
  if (config.defaultRepo !== undefined) {
    if (typeof config.defaultRepo !== "string") {
      throw new Error("meta/vibestudio.yml: `defaultRepo` must be a workspace repo path");
    }
    try {
      config.defaultRepo = normalizeWorkspaceRepoPath(config.defaultRepo);
    } catch (error) {
      throw new Error(
        `meta/vibestudio.yml: invalid \`defaultRepo\`: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  validateDeclaredUnitList<WorkspaceExtensionDecl>({
    section: "extensions",
    sourceRoot: "extensions",
    packageScope: WORKSPACE_EXTENSION_PACKAGE_SCOPE,
    singular: "extension",
    values: config.extensions,
  });
  validateDeclaredUnitList<WorkspaceClientDecl>({
    section: "clients",
    sourceRoot: "clients",
    packageScope: WORKSPACE_CLIENT_PACKAGE_SCOPE,
    singular: "client",
    values: config.clients,
  });
  validateTrust(config.trust);
  validateClientDefaults(config.clientDefaults);
  validateRuntimeExtensions(config.runtimeExtensions);
  validateProviders(config);
}

export function resolveDeclaredExtensions(
  config: WorkspaceConfig
): Array<{ source: string; ref: string }> {
  return resolveDeclaredUnits(config.extensions ?? []).map((decl) => ({
    source: decl.source,
    ref: decl.ref,
  }));
}

export function resolveDeclaredClients(
  config: WorkspaceConfig
): Array<{ source: string; ref: string }> {
  return (config.clients ?? []).map((decl) => ({
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
// trust / clientDefaults / runtimeExtensions / providers — manifest-declared host contracts
// =============================================================================

interface CanonicalUnitKind {
  sourceRoot: "clients" | "extensions";
  packageScope: typeof WORKSPACE_CLIENT_PACKAGE_SCOPE | typeof WORKSPACE_EXTENSION_PACKAGE_SCOPE;
}

const CLIENT_UNIT: CanonicalUnitKind = {
  sourceRoot: "clients",
  packageScope: WORKSPACE_CLIENT_PACKAGE_SCOPE,
};
const EXTENSION_UNIT: CanonicalUnitKind = {
  sourceRoot: "extensions",
  packageScope: WORKSPACE_EXTENSION_PACKAGE_SCOPE,
};

/**
 * Canonicalize a declared client/extension identity to its workspace-relative
 * repo path (`clients/name` / `extensions/name`). Accepts either the repo-path
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

/** `clients/name` | `@workspace-clients/name` → `@workspace-clients/name`. */
export function workspaceClientPackageName(source: string): string {
  const repoPath = canonicalUnitRepoPath(source, CLIENT_UNIT, "client source");
  return `${WORKSPACE_CLIENT_PACKAGE_SCOPE}${repoPath.slice("clients/".length)}`;
}

/** `clients/name` | `@workspace-clients/name` → `clients/name`. */
export function workspaceClientRepoPath(source: string): string {
  return canonicalUnitRepoPath(source, CLIENT_UNIT, "client source");
}

/** `extensions/name` | `@workspace-extensions/name` → `@workspace-extensions/name`. */
export function workspaceExtensionPackageName(source: string): string {
  const repoPath = canonicalUnitRepoPath(source, EXTENSION_UNIT, "extension source");
  return `${WORKSPACE_EXTENSION_PACKAGE_SCOPE}${repoPath.slice("extensions/".length)}`;
}

/** `extensions/name` | `@workspace-extensions/name` -> `extensions/name`. */
export function workspaceExtensionRepoPath(source: string): string {
  return canonicalUnitRepoPath(source, EXTENSION_UNIT, "extension source");
}

export const WORKSPACE_EXTENSION_PROVIDER_NAMES = ["browserData", "gitInterop"] as const;
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
  for (const key of Object.keys(trust)) {
    if (key !== "clients") {
      throw new Error(`meta/vibestudio.yml: unknown \`trust\` key "${key}"`);
    }
  }
  validateUnitSourceList(trust.clients, CLIENT_UNIT, "trust.clients");
}

function validateClientDefaults(defaults: WorkspaceConfig["clientDefaults"] | undefined): void {
  if (defaults === undefined) return;
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error("meta/vibestudio.yml: `clientDefaults` must be a mapping");
  }
  for (const [host, source] of Object.entries(defaults)) {
    if (!(HOST_KINDS as readonly string[]).includes(host)) {
      throw new Error(
        `meta/vibestudio.yml: unknown \`clientDefaults\` key "${host}" (expected one of ${HOST_KINDS.join(", ")})`
      );
    }
    canonicalUnitRepoPath(source, CLIENT_UNIT, `clientDefaults.${host}`);
  }
}

function validateRuntimeExtensions(
  runtimeExtensions: WorkspaceConfig["runtimeExtensions"] | undefined
): void {
  if (runtimeExtensions === undefined) return;
  if (
    runtimeExtensions === null ||
    typeof runtimeExtensions !== "object" ||
    Array.isArray(runtimeExtensions)
  ) {
    throw new Error("meta/vibestudio.yml: `runtimeExtensions` must be a mapping");
  }
  for (const [runtime, sources] of Object.entries(runtimeExtensions)) {
    if (!(CLIENT_RUNTIMES as readonly string[]).includes(runtime)) {
      throw new Error(
        `meta/vibestudio.yml: unknown \`runtimeExtensions\` key "${runtime}" (expected one of ${CLIENT_RUNTIMES.join(", ")})`
      );
    }
    validateUnitSourceList(sources, EXTENSION_UNIT, `runtimeExtensions.${runtime}`);
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

export function workspaceProviderExtensionRepoPath(
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
    workspaceProviderExtensionRepoPath(config, provider as WorkspaceExtensionProviderName);
  }
}

/**
 * Resolve the manifest's device-level trust grants to canonical repo paths
 * (`clients/name`). Missing `trust` (or a missing list) resolves to an empty
 * grant list — trust is never assumed.
 */
export function resolveWorkspaceTrustGrants(config: WorkspaceConfig): { clients: string[] } {
  return { clients: validateUnitSourceList(config.trust?.clients, CLIENT_UNIT, "trust.clients") };
}

/** The default client of one host (canonical `clients/name`), or null when none is declared. */
export function resolveClientDefault(config: WorkspaceConfig, host: HostKind): string | null {
  const source = config.clientDefaults?.[host];
  return source === undefined
    ? null
    : canonicalUnitRepoPath(source, CLIENT_UNIT, `clientDefaults.${host}`);
}

/**
 * Resolve the declared extensions that are build prerequisites for clients of
 * one runtime, or of every runtime when omitted. The result is deduplicated and
 * retains each extension's declared ref.
 */
export function resolveRuntimeRequiredExtensions(
  config: WorkspaceConfig,
  runtime?: ClientRuntime
): Array<{ source: string; ref: string }> {
  const declaredBySource = new Map(
    resolveDeclaredExtensions(config).map((decl) => [
      canonicalUnitRepoPath(decl.source, EXTENSION_UNIT, "extensions[].source"),
      decl,
    ])
  );
  const seen = new Set<string>();
  const required: Array<{ source: string; ref: string }> = [];
  const runtimes = runtime === undefined ? CLIENT_RUNTIMES : [runtime];
  for (const candidate of runtimes) {
    for (const source of validateUnitSourceList(
      config.runtimeExtensions?.[candidate],
      EXTENSION_UNIT,
      `runtimeExtensions.${candidate}`
    )) {
      if (seen.has(source)) continue;
      seen.add(source);
      required.push(declaredBySource.get(source) ?? { source, ref: "main" });
    }
  }
  return required;
}

/**
 * Resolve the extensions that should run for the currently demanded client
 * runtimes. A runtime prerequisite remains a declaration (and therefore part
 * of launch review) without becoming ambient startup work for hosts that do
 * not run that runtime.
 */
export function resolveExtensionsForRuntimes(
  config: WorkspaceConfig,
  runtimes: readonly ClientRuntime[]
): Array<{ source: string; ref: string }> {
  const allRequired = resolveRuntimeRequiredExtensions(config);
  const requiredSources = new Set(allRequired.map((decl) => decl.source));
  const activeRequired = runtimes.flatMap((runtime) =>
    resolveRuntimeRequiredExtensions(config, runtime)
  );
  const seen = new Set<string>();
  return [...activeRequired, ...resolveDeclaredExtensions(config)].filter((decl) => {
    if (seen.has(decl.source)) return false;
    if (
      requiredSources.has(decl.source) &&
      !activeRequired.some((item) => item.source === decl.source)
    )
      return false;
    seen.add(decl.source);
    return true;
  });
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
