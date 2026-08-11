import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import type {
  TemplateAddRequest,
  TemplateAuthoringInspection,
  TemplateAuthoringIntent,
  TemplateCatalogSnapshot as ServiceTemplateCatalogSnapshot,
  TemplateLocator,
  TemplatePublication,
} from "@vibestudio/service-schemas/templates";
import type {
  VcsCompareResult,
  VcsMergeResult,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import { templateLocatorSchema } from "@vibestudio/service-schemas/templates";
import {
  WorkspaceConfigTopLayerSchema,
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { migrationFacetsForRepoPaths } from "@vibestudio/workspace/migrationNotes";
import {
  inspectTemplateOperation,
  publishPreparedTemplateOperation,
  stageTemplateOperation,
  templateStatus,
  templateSuggestionDigest,
  type TemplateOperationInspection,
  type TemplateSourcePorts,
  type TemplateWorkspaceObservation,
} from "@workspace/template-composer";
import {
  parseTemplateRegistry,
  TemplateRegistryUnavailableError,
  type TemplateCatalogSnapshot,
  type TemplateRegistryClient,
} from "@workspace/template-registry";
import YAML from "yaml";
import { createAffectedBuildGate, TemplateAuthoringBuildError } from "./build.js";
import type { ExtensionContextLike } from "./context.js";
import {
  catalogPin,
  acquireTemplateSnapshot,
  createPinnedTemplateSourcePorts,
  createRegistryClient,
  createTemplateSourcePorts,
  discoverDirectTemplatePin,
  missingTemplateCredential,
  TemplateCredentialRequired,
} from "./source.js";
import { ensureTemplateOperationIntent } from "./operationRecord.js";
import {
  createTemplateOperationPorts,
  clearTemplateOperationRecordFile,
  ensureTemplateOperationContext,
  isTemplateOperationCancelled,
  OPERATION_CONTEXT_PREFIX,
  readTemplateOperationRecord,
  readTemplateOperationRecordInContext,
  publishTemplateSuggestionTopLayer,
  publishTemplateOperationCancellation,
  TemplateReviewRequired,
  TemplateOperationMainAdvanced,
  updateTemplateOperationRecord,
  writeTemplateOperationRecord,
  type TemplateOperationRecord,
} from "./staging.js";
import {
  observeWorkspace,
  projectBootstrapRuntimeToSource,
  readBootstrapDescriptor,
  type SemanticWorkspaceObservation,
} from "./workspace.js";
import { inspectTemplateAuthoring, listTemplateAuthoringParts } from "./authoring.js";

interface Environment {
  info: Awaited<ReturnType<ExtensionContextLike["workspace"]["getInfo"]>>;
  observation: SemanticWorkspaceObservation;
  catalog?: TemplateCatalogSnapshot;
}

const TEMPLATE_OPERATIONS_CHANGED_EVENT = "operations.changed";

function emitTemplateOperationsChanged(
  ctx: ExtensionContextLike,
  operationId: string,
  state: "pending" | "repairing" | "applied" | "cancelled"
): void {
  ctx.emit(TEMPLATE_OPERATIONS_CHANGED_EVENT, { operationId, state });
}

function migrationFields(facets: readonly string[]): { migration?: { facets: string[] } } {
  return facets.length > 0 ? { migration: { facets: [...facets] } } : {};
}

function migrationRepairFailures(facets: readonly string[]) {
  return facets.map((facet) => ({
    unit: `migrations/${facet}`,
    message:
      "Read the incoming contract notes, repair the retained workspace, run every note verification and the normal gates, then resume",
  }));
}

/** The single staging decision migration notes add to Composer. */
export function preparedMigrationHold(
  record: TemplateOperationRecord,
  prepared: { contextId: string; affectedRepoPaths: string[] }
):
  | {
      record: TemplateOperationRecord;
      repair: { contextId: string; failures: Array<{ unit: string; message: string }> };
    }
  | undefined {
  if (!record.migrationFacets?.length) return undefined;
  return {
    record: {
      ...record,
      preparedAffectedRepoPaths: prepared.affectedRepoPaths,
      buildFailures: undefined,
    },
    repair: {
      contextId: prepared.contextId,
      failures: migrationRepairFailures(record.migrationFacets),
    },
  };
}

export interface TemplateCallerContextIntegration {
  state: "integrated" | "needs-merge" | "unavailable";
  contextId: string;
}

function invokingContextId(ctx: ExtensionContextLike): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

/**
 * Make a successful protected-main publication visible to the context that
 * requested it. Composer may mechanically apply only an already-accounted or
 * unambiguous merge. Genuine overlap remains untouched for the ordinary
 * agentic VCS workflow.
 */
export async function integrateTemplatePublicationIntoCallerContext(
  ctx: ExtensionContextLike,
  operationId: string,
  publicationEventId: string
): Promise<TemplateCallerContextIntegration | undefined> {
  const contextId = invokingContextId(ctx);
  if (!contextId || contextId.startsWith(OPERATION_CONTEXT_PREFIX)) return undefined;
  try {
    const status = await ctx.rpc.call<VcsStatusResult>("main", "vcs.status", { contextId });
    if (status.mainRelation === "at" && status.mainEventId === publicationEventId) {
      return { state: "integrated", contextId };
    }
    const source = { kind: "event" as const, eventId: publicationEventId };
    const compared = await ctx.rpc.call<VcsCompareResult>("main", "vcs.compare", {
      target: status.workingHead,
      source,
      limit: 1,
    });
    if (compared.resolution.concluded) return { state: "integrated", contextId };
    if (!compared.resolution.complete) return { state: "needs-merge", contextId };
    const integrationDigest = sha256HexSyncText(
      canonicalJson({ contextId, publicationEventId, workingHead: status.workingHead })
    ).slice(0, 32);
    const merged = await ctx.rpc.call<VcsMergeResult>("main", "vcs.merge", {
      commandId: `${operationId}:integrate-caller:${integrationDigest}`,
      contextId,
      expectedWorkingHead: status.workingHead,
      source,
      intentSummary: "Bring the installed template into this conversation",
    });
    return {
      state:
        merged.resolution.complete && merged.resolution.concluded ? "integrated" : "needs-merge",
      contextId,
    };
  } catch (error) {
    ctx.log.warn?.("Template publication could not be integrated into its caller context", {
      operationId,
      contextId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { state: "unavailable", contextId };
  }
}

async function operationRecordForMutation(
  ctx: ExtensionContextLike,
  env: Environment,
  operationId: string
): Promise<TemplateOperationRecord | null> {
  if (await isTemplateOperationCancelled(ctx, env.observation.mainEventId, operationId)) {
    throw new Error(`Template operation ${operationId} was cancelled and cannot be reused`);
  }
  return readTemplateOperationRecord(ctx, operationId);
}

async function completedOperationResult(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord | null
) {
  if (!record) return null;
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  const status = await ctx.rpc.call<{
    committed: { kind: "event"; eventId: string };
    mainEventId: string;
    mainRelation: string;
  }>("main", "vcs.status", { contextId });
  if (status.mainRelation !== "at" && status.mainRelation !== "behind") {
    return null;
  }
  const contextIntegration = await integrateTemplatePublicationIntoCallerContext(
    ctx,
    record.operationId,
    status.mainEventId
  );
  return {
    operationId: record.operationId,
    state: "applied" as const,
    publicationEventId: status.mainEventId,
    ...(contextIntegration ? { contextIntegration } : {}),
    affectedParts: record.affectedParts,
    ...migrationFields(record.migrationFacets ?? []),
  };
}

async function environment(
  ctx: ExtensionContextLike,
  options: { refresh?: boolean; requireCatalog?: boolean } = {}
): Promise<Environment> {
  const info = await ctx.workspace.getInfo();
  const observation = await ensureBootstrapAdoption(ctx, info.statePath);
  const registry = observation.top.templates?.registry;
  if (!registry) {
    if (options.requireCatalog) {
      throw new Error("Workspace does not declare templates.registry");
    }
    return { info, observation };
  }
  const client = await createRegistryClient(ctx, {
    statePath: info.statePath,
    systemEpoch: observation.expectedSystemEpoch,
    registry,
  });
  const catalog = await loadTemplateCatalog(client, options);
  return { info, observation, catalog };
}

export async function loadTemplateCatalog(
  client: Pick<TemplateRegistryClient, "catalog" | "refresh">,
  options: { refresh?: boolean; requireCatalog?: boolean } = {}
): Promise<TemplateCatalogSnapshot | undefined> {
  if (options.refresh) return client.refresh();
  try {
    return await client.catalog();
  } catch (error) {
    if (error instanceof TemplateRegistryUnavailableError) {
      return client.refresh();
    }
    throw error;
  }
}

function sourcePortsForEnvironment(
  ctx: ExtensionContextLike,
  env: Environment
): TemplateSourcePorts {
  if (env.catalog) {
    return createTemplateSourcePorts(ctx, env.info.statePath, env.catalog);
  }
  return {
    acquire: (pin, nodeId) => acquireTemplateSnapshot(ctx, env.info.statePath, pin, nodeId),
    resolvePromoted: async (declaration) => {
      throw new Error(
        `Template dependency ${declaration.url} is not locked and requires a configured templates.registry`
      );
    },
  };
}

async function ensureBootstrapAdoption(
  ctx: ExtensionContextLike,
  statePath: string
): Promise<SemanticWorkspaceObservation> {
  let observation = await observeWorkspace(ctx);
  if (!bootstrapNeedsAdoption(observation)) {
    return observation;
  }
  const descriptor = await readBootstrapDescriptor(statePath);
  if (!descriptor) return observation;
  const sources = {
    acquire: (pin: WorkspaceTemplatePin, nodeId: string) =>
      acquireTemplateSnapshot(ctx, statePath, pin, nodeId),
    resolvePromoted: async (declaration: WorkspaceTemplateDeclaration) => {
      throw new Error(
        `Bootstrap root ${descriptor.rootTemplate.url} declares dependency ${declaration.url}; refresh the configured registry before completing adoption`
      );
    },
  };
  const inspection = await inspectTemplateOperation({
    kind: "adopt-bootstrap",
    descriptor,
    workspace: {
      localRepoPaths: new Set(),
      overrides: observation.overrides,
      expectedSystemEpoch: observation.expectedSystemEpoch,
    },
    sources,
  });
  observation = {
    ...observation,
    top: projectBootstrapRuntimeToSource(
      observation.runtimeTop,
      inspection.plan.nodes,
      observation.workspaceId,
      observation.top.templates
    ),
  };
  if (!inspection.nextTemplates) {
    throw new Error("Bootstrap adoption did not produce a template relationship");
  }
  inspection.nextTemplates = {
    ...inspection.nextTemplates,
    bootstrapAdopted: descriptor.rootTemplate,
  };
  const ports = createTemplateOperationPorts(ctx, statePath, observation);
  const operationId = `bootstrap-${descriptor.rootTemplate.commit}`;
  const prepared = await stageTemplateOperation({
    operationId,
    inspection,
    ports,
  });
  try {
    await publishPreparedTemplateOperation(prepared, observation.mainEventId, ports);
  } catch (error) {
    observation = await observeWorkspace(ctx);
    if (observation.top.templates?.bootstrapAdopted) return observation;
    throw error;
  }
  return observeWorkspace(ctx);
}

export function bootstrapNeedsAdoption(
  observation: Pick<SemanticWorkspaceObservation, "roots" | "lock" | "top">
): boolean {
  return (
    observation.roots.length === 0 &&
    !observation.lock &&
    !observation.top.templates?.bootstrapAdopted
  );
}

async function pinForLocator(
  ctx: ExtensionContextLike,
  env: Environment,
  locator: TemplateLocator
): Promise<WorkspaceTemplatePin> {
  if ("catalogId" in locator) {
    if (!env.catalog) throw new Error("Catalog selection requires templates.registry");
    return catalogPin(
      env.catalog,
      locator.catalogId,
      locator.registryCommit,
      locator.registrySnapshot
    );
  }
  if ("alias" in locator) {
    const node = env.observation.lock?.nodes.find((candidate) => candidate.alias === locator.alias);
    if (!node) throw new Error(`Unknown installed template alias: ${locator.alias}`);
    return node.pin;
  }
  const url = normalizeTemplateGitUrl(locator.url);
  const installed = env.observation.lock?.nodes.find(
    (candidate) => normalizeTemplateGitUrl(candidate.pin.url) === url
  );
  if (installed) return installed.pin;
  const entry = env.catalog?.entries.find(
    (candidate) => normalizeTemplateGitUrl(candidate.url) === url
  );
  return entry
    ? WorkspaceTemplatePinSchema.parse({
        url,
        ...entry.promoted,
        ...(locator.credential ? { credential: locator.credential } : {}),
      })
    : discoverDirectTemplatePin(ctx, env.info.statePath, {
        url,
        ...(locator.credential ? { credential: locator.credential } : {}),
      });
}

async function resolveAddSource(
  ctx: ExtensionContextLike,
  request: TemplateAddRequest,
  existing: TemplateOperationRecord | null
): Promise<{
  env: Environment;
  pin: WorkspaceTemplatePin;
  selection?: { catalogId: string; registryCommit: string; registrySnapshot: string };
}> {
  if (existing) {
    const intent = existing.intent as { source?: unknown; target?: unknown };
    if (canonicalJson(intent.source) !== canonicalJson(request)) {
      throw new Error(
        `Template command ${existing.operationId} was reused with a different source`
      );
    }
    return {
      env: await environment(ctx),
      pin: WorkspaceTemplatePinSchema.parse(intent.target),
    };
  }
  if ("catalogId" in request) {
    const env = await environment(ctx, {
      requireCatalog: true,
      refresh: request.refreshCatalog === true,
    });
    const registryCommit = request.registryCommit ?? env.catalog!.coordinates.commit;
    const registrySnapshot = request.registrySnapshot ?? env.catalog!.coordinates.snapshot;
    return {
      env,
      pin: catalogPin(env.catalog!, request.catalogId, registryCommit, registrySnapshot),
      selection: { catalogId: request.catalogId, registryCommit, registrySnapshot },
    };
  }
  const env = await environment(ctx);
  return {
    env,
    pin: await discoverDirectTemplatePin(ctx, env.info.statePath, request),
  };
}

async function inspectLocator(
  ctx: ExtensionContextLike,
  env: Environment,
  locator: TemplateLocator
) {
  const pin = await pinForLocator(ctx, env, locator);
  const preview = await inspectAdd(
    ctx,
    env,
    pin,
    [],
    "catalogId" in locator
      ? {
          catalogId: locator.catalogId,
          registryCommit: locator.registryCommit,
          registrySnapshot: locator.registrySnapshot,
        }
      : undefined
  );
  return inspectionResult(
    preview.inspection,
    env.observation.lock,
    env.observation.top.templates?.suggestionDecisions,
    pin
  );
}

async function adoptionAwareInput(
  ctx: ExtensionContextLike,
  env: Environment
): Promise<{
  workspace: TemplateWorkspaceObservation;
  sources: TemplateSourcePorts;
  descriptor: WorkspaceCreationDescriptor | null;
}> {
  const ordinary = sourcePortsForEnvironment(ctx, env);
  if (
    env.observation.roots.length > 0 ||
    env.observation.lock ||
    env.observation.top.templates?.bootstrapAdopted
  ) {
    return { workspace: env.observation, sources: ordinary, descriptor: null };
  }
  const descriptor = await readBootstrapDescriptor(env.info.statePath);
  if (!descriptor) {
    return { workspace: env.observation, sources: ordinary, descriptor: null };
  }
  const rootUrl = normalizeTemplateGitUrl(descriptor.rootTemplate.url);
  const sources = {
    acquire: ordinary.acquire,
    resolvePromoted: async (declaration: WorkspaceTemplateDeclaration) =>
      normalizeTemplateGitUrl(declaration.url) === rootUrl
        ? descriptor.rootTemplate
        : ordinary.resolvePromoted(declaration),
  };
  const adoption = await inspectTemplateOperation({
    kind: "adopt-bootstrap",
    descriptor,
    workspace: {
      localRepoPaths: new Set(),
      overrides: env.observation.overrides,
      expectedSystemEpoch: env.observation.expectedSystemEpoch,
    },
    sources,
  });
  const localRepoPaths = new Set(env.observation.localRepoPaths);
  for (const repoPath of Object.keys(adoption.plan.repositories)) {
    localRepoPaths.delete(repoPath);
  }
  return {
    workspace: {
      ...env.observation,
      roots: [
        {
          url: rootUrl,
          ...(descriptor.rootTemplate.credential
            ? { credential: descriptor.rootTemplate.credential }
            : {}),
        },
      ],
      localRepoPaths,
    },
    sources,
    descriptor,
  };
}

function inspectionResult(
  inspection: TemplateOperationInspection,
  previous?: SemanticWorkspaceObservation["lock"],
  suggestionDecisions:
    | Record<string, { digest: `v1-sha256:${string}`; decision: "accepted" | "declined" }>
    | undefined = undefined,
  pin?: WorkspaceTemplatePin
) {
  return {
    ...(pin ? { pin } : {}),
    fingerprint: inspection.plan.fingerprint,
    roots: inspection.plan.rootNodeIds,
    templates: inspection.plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      alias: node.alias,
      url: node.pin.url,
      commit: node.pin.commit,
    })),
    affectedParts: affectedTemplateParts(inspection, previous),
    excludedSuggestions: inspection.plan.nodes.flatMap((node) =>
      (["trust", "providers"] as const).flatMap((section) => {
        const value = node.excludedSuggestions[section];
        if (value === undefined) return [];
        const digest = templateSuggestionDigest(node.nodeId, section, value);
        if (suggestionDecisions?.[`${node.nodeId}:${section}`]?.digest === digest) {
          return [];
        }
        return [{ alias: node.alias, section, value }];
      })
    ),
  };
}

export function selectedTemplateName(inspection: ReturnType<typeof inspectionResult>): string {
  if (!inspection.pin) return "Selected template";
  const selectedUrl = normalizeTemplateGitUrl(inspection.pin.url);
  return (
    inspection.templates.find(
      (template) =>
        normalizeTemplateGitUrl(template.url) === selectedUrl &&
        template.commit === inspection.pin!.commit
    )?.alias ?? "Selected template"
  );
}

function affectedTemplateParts(
  inspection: TemplateOperationInspection,
  previous?: SemanticWorkspaceObservation["lock"]
): string[] {
  const previousUrls = new Map(
    (previous?.nodes ?? []).map((node) => [node.nodeId, normalizeTemplateGitUrl(node.pin.url)])
  );
  const nextUrls = new Map(
    inspection.plan.nodes.map((node) => [node.nodeId, normalizeTemplateGitUrl(node.pin.url)])
  );
  const paths = new Set([
    ...Object.keys(previous?.repositories ?? {}),
    ...Object.keys(inspection.plan.repositories),
  ]);
  return [...paths]
    .filter((repoPath) => {
      const before = (previous?.repositories[repoPath]?.contributions ?? []).map(
        ({ nodeId, subtreeDigest }) => ({ url: previousUrls.get(nodeId), subtreeDigest })
      );
      const after = (inspection.plan.repositories[repoPath]?.contributions ?? []).map(
        ({ nodeId, subtreeDigest }) => ({ url: nextUrls.get(nodeId), subtreeDigest })
      );
      return canonicalJson(before) !== canonicalJson(after);
    })
    .sort();
}

export function mergeAcceptedTemplateSuggestion(
  top: SemanticWorkspaceObservation["top"],
  section: "trust" | "providers",
  value: unknown
): SemanticWorkspaceObservation["top"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Template ${section} suggestion must be an object`);
  }
  const suggestion = value as Record<string, unknown>;
  if (section === "trust") {
    const current = (top.trust ?? {}) as Record<string, string[] | undefined>;
    const merged = Object.fromEntries(
      [...new Set([...Object.keys(current), ...Object.keys(suggestion)])].map((key) => {
        const proposed = suggestion[key];
        if (proposed !== undefined && !Array.isArray(proposed)) {
          throw new Error(`Template trust suggestion ${key} must be an array`);
        }
        return [
          key,
          [...new Set([...(current[key] ?? []), ...((proposed as string[] | undefined) ?? [])])],
        ];
      })
    );
    return WorkspaceConfigTopLayerSchema.parse({ ...top, trust: merged });
  }
  const current = (top.providers ?? {}) as Record<string, unknown>;
  const merged = { ...current };
  for (const [key, proposed] of Object.entries(suggestion)) {
    const prior = current[key];
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(proposed)) {
      throw new Error(
        `Template provider suggestion ${key} conflicts with the workspace-authored provider`
      );
    }
    merged[key] = proposed;
  }
  return WorkspaceConfigTopLayerSchema.parse({ ...top, providers: merged });
}

async function inspectAdd(
  ctx: ExtensionContextLike,
  env: Environment,
  selected: WorkspaceTemplatePin,
  pins: readonly WorkspaceTemplatePin[] = [],
  selection?: { catalogId: string; registryCommit: string; registrySnapshot: string }
): Promise<{ inspection: TemplateOperationInspection }> {
  const prepared = await adoptionAwareInput(ctx, env);
  const selectedSources = {
    ...prepared.sources,
    resolvePromoted: async (declaration: WorkspaceTemplateDeclaration) =>
      normalizeTemplateGitUrl(declaration.url) === normalizeTemplateGitUrl(selected.url)
        ? selected
        : prepared.sources.resolvePromoted(declaration),
  };
  const sources = createPinnedTemplateSourcePorts(selectedSources, pins);
  const inspection = await inspectTemplateOperation({
    kind: "add",
    ...(selection ? { selection } : {}),
    template: {
      url: selected.url,
      ...(selected.credential ? { credential: selected.credential } : {}),
    },
    workspace: prepared.workspace,
    sources,
  });
  if (prepared.descriptor && inspection.nextTemplates) {
    inspection.nextTemplates = {
      ...inspection.nextTemplates,
      bootstrapAdopted: prepared.descriptor.rootTemplate,
    };
  }
  return { inspection };
}

async function inspectAdopt(
  ctx: ExtensionContextLike,
  env: Environment,
  selected: WorkspaceTemplatePin,
  pins: readonly WorkspaceTemplatePin[] = []
): Promise<{
  inspection: TemplateOperationInspection;
  observation: SemanticWorkspaceObservation;
}> {
  const prepared = await adoptionAwareInput(ctx, env);
  const selectedSources = {
    ...prepared.sources,
    resolvePromoted: async (declaration: WorkspaceTemplateDeclaration) =>
      normalizeTemplateGitUrl(declaration.url) === normalizeTemplateGitUrl(selected.url)
        ? selected
        : prepared.sources.resolvePromoted(declaration),
  };
  const inspection = await inspectTemplateOperation({
    kind: "adopt",
    pin: selected,
    workspace: prepared.workspace,
    sources: createPinnedTemplateSourcePorts(selectedSources, pins),
  });
  if (prepared.descriptor && inspection.nextTemplates) {
    inspection.nextTemplates = {
      ...inspection.nextTemplates,
      bootstrapAdopted: prepared.descriptor.rootTemplate,
    };
  }
  const templates = {
    ...env.observation.top.templates,
    ...(inspection.nextTemplates ?? { use: [] }),
  };
  return {
    inspection,
    observation: {
      ...env.observation,
      top: projectBootstrapRuntimeToSource(
        env.observation.runtimeTop,
        inspection.plan.nodes,
        env.observation.workspaceId,
        templates
      ),
    },
  };
}

function operationParts(
  operationId: string,
  inspection: TemplateOperationInspection,
  previous?: SemanticWorkspaceObservation["lock"]
) {
  const affectedParts = affectedTemplateParts(inspection, previous);
  const migrationFacets = migrationFacetsForRepoPaths(affectedParts);
  return {
    migrationFacets,
    response: {
      operationId,
      affectedParts,
      ...migrationFields(migrationFacets),
    },
  };
}

interface ProtectedMainBuildFailure {
  code: "BuildGateFailed";
  affectedUnits: string[];
  diagnostics: Array<{ file: string; line: number; column: number; message: string }>;
}

function protectedMainBuildFailure(error: unknown): ProtectedMainBuildFailure | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { errorData?: unknown }).errorData;
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (
    value["code"] !== "BuildGateFailed" ||
    !Array.isArray(value["affectedUnits"]) ||
    !Array.isArray(value["diagnostics"])
  ) {
    return null;
  }
  const affectedUnits = value["affectedUnits"].filter(
    (unit): unit is string => typeof unit === "string" && unit.length > 0
  );
  const diagnostics = value["diagnostics"].flatMap((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return [];
    const item = diagnostic as Record<string, unknown>;
    if (
      typeof item["file"] !== "string" ||
      typeof item["line"] !== "number" ||
      typeof item["column"] !== "number" ||
      typeof item["message"] !== "string"
    ) {
      return [];
    }
    return [
      {
        file: item["file"],
        line: item["line"],
        column: item["column"],
        message: item["message"],
      },
    ];
  });
  return { code: "BuildGateFailed", affectedUnits, diagnostics };
}

async function applyInspection(
  ctx: ExtensionContextLike,
  env: Environment,
  operationId: string,
  inspection: TemplateOperationInspection,
  intent: unknown
) {
  const parts = operationParts(operationId, inspection, env.observation.lock);
  const existing = await readTemplateOperationRecord(ctx, operationId);
  const operation = await ensureTemplateOperationIntent({
    operationId,
    inspection,
    intent,
    existing,
    affectedParts: parts.response.affectedParts,
    migrationFacets: parts.migrationFacets,
    persist: (record) => writeTemplateOperationRecord(ctx, record),
  });
  const ports = createTemplateOperationPorts(
    ctx,
    env.info.statePath,
    env.observation,
    operation.record
  );
  let contextId: string | undefined;
  let preparedAffectedRepoPaths: string[] | undefined;
  try {
    const prepared = await stageTemplateOperation({
      operationId,
      inspection,
      ports,
    });
    contextId = prepared.contextId;
    preparedAffectedRepoPaths = prepared.affectedRepoPaths;
    const migrationHold = preparedMigrationHold(operation.record, prepared);
    if (migrationHold) {
      await updateTemplateOperationRecord(ctx, migrationHold.record);
      emitTemplateOperationsChanged(ctx, operationId, "repairing");
      return {
        ...parts.response,
        state: "repairing" as const,
        repair: migrationHold.repair,
      };
    }
    await clearTemplateOperationRecordFile(ctx, {
      ...operation.record,
      preparedAffectedRepoPaths: prepared.affectedRepoPaths,
      buildFailures: undefined,
    });
    const published = await publishPreparedTemplateOperation(
      prepared,
      env.observation.mainEventId,
      ports
    );
    const contextIntegration = await integrateTemplatePublicationIntoCallerContext(
      ctx,
      operationId,
      published.mainEventId
    );
    return {
      ...parts.response,
      state: "applied" as const,
      publicationEventId: published.mainEventId,
      ...(contextIntegration ? { contextIntegration } : {}),
    };
  } catch (error) {
    const buildFailure = protectedMainBuildFailure(error);
    if (buildFailure && contextId) {
      const failures = buildFailure.diagnostics.length
        ? buildFailure.diagnostics.map((diagnostic) => ({
            unit: diagnostic.file || "workspace",
            message: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
          }))
        : buildFailure.affectedUnits.map((unit) => ({
            unit,
            message: `The protected-main build failed for ${unit}`,
          }));
      await updateTemplateOperationRecord(ctx, {
        ...operation.record,
        preparedAffectedRepoPaths,
        buildFailures: failures,
      });
      if (operation.record.migrationFacets?.length) {
        emitTemplateOperationsChanged(ctx, operationId, "repairing");
      }
      return {
        ...parts.response,
        state: "error" as const,
        blocker: {
          state: "error" as const,
          code: "TemplateBuildFailed",
          message: "The composed workspace needs repair before this template can be installed",
          nextAction: "details" as const,
        },
        repair: { contextId, failures },
      };
    }
    if (error instanceof TemplateCredentialRequired) {
      return {
        ...parts.response,
        state: "waiting-for-credential" as const,
        blocker: {
          state: "waiting-for-credential" as const,
          code: "CredentialRequirementUnsatisfied",
          message: error.message,
          nextAction: "connect-credential" as const,
          credential: error.requirement,
        },
      };
    }
    if (error instanceof TemplateReviewRequired) {
      await updateTemplateOperationRecord(ctx, {
        ...operation.record,
        mainAdvanceEventId: undefined,
        reviews: [...error.items],
        deltaBasis: error.deltaBasis,
      });
      if (operation.record.migrationFacets?.length) {
        emitTemplateOperationsChanged(ctx, operationId, "pending");
      }
      return {
        ...parts.response,
        state: "pending" as const,
        review: {
          operationId,
          contextId: error.contextId,
          approvalGranted: true,
          items: [...error.items],
        },
      };
    }
    if (error instanceof TemplateOperationMainAdvanced) {
      await updateTemplateOperationRecord(ctx, {
        ...operation.record,
        mainAdvanceEventId: error.mainEventId,
      });
      return {
        ...parts.response,
        state: "error" as const,
        blocker: {
          state: "error" as const,
          code: "TemplateMainAdvanced",
          message: error.message,
          nextAction: "details" as const,
        },
        repair: {
          contextId: error.contextId,
          mainEventId: error.mainEventId,
          failures: [
            {
              unit: "workspace-main",
              message: `Merge protected-main event ${error.mainEventId} into this context, resolve any semantic conflicts, then resume`,
            },
          ],
        },
      };
    }
    throw error;
  }
}

async function resumePreparedOperation(
  ctx: ExtensionContextLike,
  env: Environment,
  record: TemplateOperationRecord
) {
  const affectedRepoPaths = record.preparedAffectedRepoPaths;
  if (!affectedRepoPaths) {
    throw new Error(`Template operation ${record.operationId} has not finished staging`);
  }
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  const ports = createTemplateOperationPorts(ctx, env.info.statePath, env.observation, record);
  await clearTemplateOperationRecordFile(ctx, {
    ...record,
    preparedAffectedRepoPaths: affectedRepoPaths,
    buildFailures: undefined,
  });
  let published: { mainEventId: string };
  try {
    published = await publishPreparedTemplateOperation(
      { contextId, affectedRepoPaths },
      env.observation.mainEventId,
      ports
    );
  } catch (error) {
    if (!(error instanceof TemplateOperationMainAdvanced)) throw error;
    await updateTemplateOperationRecord(ctx, {
      ...record,
      mainAdvanceEventId: error.mainEventId,
    });
    return {
      operationId: record.operationId,
      state: "error" as const,
      affectedParts: record.affectedParts,
      ...migrationFields(record.migrationFacets ?? []),
      blocker: {
        state: "error" as const,
        code: "TemplateMainAdvanced",
        message: error.message,
        nextAction: "details" as const,
      },
      repair: {
        contextId,
        mainEventId: error.mainEventId,
        failures: [
          {
            unit: "workspace-main",
            message: `Merge protected-main event ${error.mainEventId} into this context, resolve any semantic conflicts, then resume`,
          },
        ],
      },
    };
  }
  const contextIntegration = await integrateTemplatePublicationIntoCallerContext(
    ctx,
    record.operationId,
    published.mainEventId
  );
  emitTemplateOperationsChanged(ctx, record.operationId, "applied");
  return {
    operationId: record.operationId,
    state: "applied" as const,
    affectedParts: record.affectedParts,
    ...migrationFields(record.migrationFacets ?? []),
    publicationEventId: published.mainEventId,
    ...(contextIntegration ? { contextIntegration } : {}),
  };
}

export async function cancelTemplateOperation(input: {
  operationId: string;
  findContext(): Promise<{ contextId: string; applied: boolean; mainEventId: string } | null>;
  publishCancellation(expectedMainEventId: string): Promise<void>;
  destroy(contextId: string): Promise<void>;
}): Promise<{ operationId: string; state: "cancelled" }> {
  const target = await input.findContext();
  if (!target) return { operationId: input.operationId, state: "cancelled" };
  if (target.applied) {
    throw new Error(`Template operation ${input.operationId} is already applied`);
  }
  try {
    await input.publishCancellation(target.mainEventId);
  } catch (error) {
    const latest = await input.findContext();
    if (latest?.applied) {
      throw new Error(`Template operation ${input.operationId} is already applied`);
    }
    throw error;
  }
  const latest = await input.findContext();
  if (latest?.applied) {
    throw new Error(`Template operation ${input.operationId} is already applied`);
  }
  if (latest) await input.destroy(latest.contextId);
  return { operationId: input.operationId, state: "cancelled" };
}

async function activeTemplateOperations(
  ctx: ExtensionContextLike,
  mainEventId: string
): Promise<Array<{ contextId: string; record: TemplateOperationRecord }>> {
  const listed = await ctx.rpc.call<{ contexts: string[] }>("main", "runtime.listContexts", {
    prefix: OPERATION_CONTEXT_PREFIX,
  });
  const result: Array<{ contextId: string; record: TemplateOperationRecord }> = [];
  for (const contextId of listed.contexts) {
    const record = await readTemplateOperationRecordInContext(ctx, contextId);
    if (!record) continue;
    if (await isTemplateOperationCancelled(ctx, mainEventId, record.operationId)) continue;
    if (record.authoringPublication) continue;
    if (await completedOperationResult(ctx, record)) continue;
    result.push({ contextId, record });
  }
  return result;
}

export function operationReviewForTemplate(
  active: ReadonlyArray<{ contextId: string; record: TemplateOperationRecord }>,
  node: { alias: string; pin: { url: string } }
): { contextId: string; record: TemplateOperationRecord } | undefined {
  return active.find(({ record }) => {
    const intent = record.intent as { alias?: unknown; target?: { url?: unknown } };
    if (intent.alias === node.alias) return true;
    return (
      typeof intent.target?.url === "string" &&
      normalizeTemplateGitUrl(intent.target.url) === normalizeTemplateGitUrl(node.pin.url)
    );
  });
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("template-composer activating");
  const api = {
    async status() {
      const observation = await observeWorkspace(ctx);
      const projected = templateStatus(
        observation.roots,
        observation.lock,
        observation.top.templates?.suggestionDecisions
      );
      const active = await activeTemplateOperations(ctx, observation.mainEventId);
      return Promise.all(
        (observation.lock?.nodes ?? []).map(async (node) => {
          const pending = operationReviewForTemplate(active, node);
          const reviews = pending?.record.reviews ?? [];
          const missingCredential = await missingTemplateCredential(ctx, {
            url: node.pin.url,
            credential: node.pin.credential,
          });
          return {
            nodeId: node.nodeId,
            alias: node.alias,
            url: node.pin.url,
            ref: node.pin.ref,
            commit: node.pin.commit,
            direct: observation.roots.some(
              (root) => normalizeTemplateGitUrl(root.url) === normalizeTemplateGitUrl(node.pin.url)
            ),
            state: missingCredential
              ? ("waiting-for-credential" as const)
              : reviews.length
                ? ("reviewing" as const)
                : ("current" as const),
            contributedParts: Object.values(observation.lock?.repositories ?? {}).filter(
              (repository) =>
                repository.contributions.some((contribution) => contribution.nodeId === node.nodeId)
            ).length,
            pendingReviews: reviews.length,
            verification: observation.lock?.verification ?? "deferred",
            ...(missingCredential
              ? {
                  blocker: {
                    state: "waiting-for-credential" as const,
                    code: "CredentialRequirementUnsatisfied",
                    message: missingCredential.message,
                    nextAction: "connect-credential" as const,
                    credential: missingCredential.requirement,
                  },
                }
              : {}),
            ...(reviews.length && pending
              ? {
                  review: {
                    operationId: pending.record.operationId,
                    contextId: pending.contextId,
                    approvalGranted: true,
                    items: reviews,
                  },
                }
              : {}),
            suggestions: projected.excludedSuggestions
              .filter((suggestion) => suggestion.alias === node.alias)
              .flatMap((suggestion) =>
                (["trust", "providers"] as const).flatMap((section) =>
                  suggestion[section] === undefined ? [] : [{ section, value: suggestion[section] }]
                )
              ),
          };
        })
      );
    },

    async catalog(options: { refresh?: boolean } = {}) {
      const env = await environment(ctx, {
        ...options,
        requireCatalog: options.refresh === true,
      });
      return env.catalog ?? null;
    },

    async operations() {
      const observation = await observeWorkspace(ctx);
      const active = await activeTemplateOperations(ctx, observation.mainEventId);
      const result = [];
      for (const { contextId, record } of active) {
        const operationId = record.operationId;
        result.push({
          operationId,
          kind: record.kind,
          contextId,
          state: record.reviews?.length
            ? ("reviewing" as const)
            : record.preparedAffectedRepoPaths || record.mainAdvanceEventId
              ? ("repairing" as const)
              : ("pending" as const),
          fingerprint: record.fingerprint,
          ...migrationFields(record.migrationFacets ?? []),
          ...(record.reviews?.length
            ? {
                review: {
                  operationId,
                  contextId,
                  approvalGranted: true,
                  items: record.reviews,
                },
              }
            : {}),
          ...(record.preparedAffectedRepoPaths || record.mainAdvanceEventId
            ? {
                repair: {
                  contextId,
                  ...(record.mainAdvanceEventId ? { mainEventId: record.mainAdvanceEventId } : {}),
                  failures:
                    record.buildFailures ??
                    (record.mainAdvanceEventId
                      ? [
                          {
                            unit: "workspace-main",
                            message: `Merge protected-main event ${record.mainAdvanceEventId} into this context, resolve any semantic conflicts, then resume`,
                          },
                        ]
                      : migrationRepairFailures(record.migrationFacets ?? [])),
                },
              }
            : {}),
        });
      }
      return result;
    },

    async cancel(input: { operationId: string }) {
      const result = await cancelTemplateOperation({
        operationId: input.operationId,
        findContext: async () => {
          const listed = await ctx.rpc.call<{ contexts: string[] }>(
            "main",
            "runtime.listContexts",
            { prefix: OPERATION_CONTEXT_PREFIX }
          );
          for (const contextId of listed.contexts) {
            const record = await readTemplateOperationRecordInContext(ctx, contextId);
            if (record?.operationId !== input.operationId) continue;
            return {
              contextId,
              applied: Boolean(
                record.authoringPublication ?? (await completedOperationResult(ctx, record))
              ),
              mainEventId: (
                await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.status", { contextId })
              ).mainEventId,
            };
          }
          return null;
        },
        publishCancellation: (expectedMainEventId) =>
          publishTemplateOperationCancellation(ctx, input.operationId, expectedMainEventId).then(
            () => undefined
          ),
        destroy: (contextId) =>
          ctx.rpc.call("main", "runtime.destroyContext", {
            contextId,
            recursive: false,
          }),
      });
      emitTemplateOperationsChanged(ctx, input.operationId, "cancelled");
      return result;
    },

    async resume(input: { operationId: string }) {
      const env = await environment(ctx);
      if (await isTemplateOperationCancelled(ctx, env.observation.mainEventId, input.operationId)) {
        throw new Error(
          `Template operation ${input.operationId} was cancelled and cannot be resumed`
        );
      }
      const record = await readTemplateOperationRecord(ctx, input.operationId);
      if (!record) throw new Error(`Unknown template operation ${input.operationId}`);
      const completed = await completedOperationResult(ctx, record);
      if (completed) return completed;
      if (record.preparedAffectedRepoPaths) {
        return resumePreparedOperation(ctx, env, record);
      }
      const intent = record.intent as {
        kind?: string;
        target?: unknown;
        source?: TemplateAddRequest;
        alias?: string;
      };
      if (intent.kind === "add") {
        if (!intent.source)
          throw new Error(`Template operation ${input.operationId} has no source`);
        return api.add({
          commandId: input.operationId,
          source: intent.source,
        });
      }
      if (intent.kind === "adopt") {
        return api.adopt({
          commandId: input.operationId,
          pin: WorkspaceTemplatePinSchema.parse(intent.target),
        });
      }
      if (intent.kind === "pull" && intent.alias) {
        return api.pull({
          commandId: input.operationId,
          alias: intent.alias,
        });
      }
      if (intent.kind === "remove" && intent.alias) {
        return api.remove({
          commandId: input.operationId,
          alias: intent.alias,
        });
      }
      throw new Error(`Template operation ${input.operationId} has unsupported intent`);
    },

    async check(options: { alias?: string } = {}) {
      const env = await environment(ctx, { requireCatalog: true });
      return (env.observation.lock?.nodes ?? [])
        .filter((node) => !options.alias || node.alias === options.alias)
        .flatMap((node) => {
          const entry = env.catalog!.entries.find(
            (candidate) =>
              normalizeTemplateGitUrl(candidate.url) === normalizeTemplateGitUrl(node.pin.url)
          );
          if (!entry || entry.promoted.commit === node.pin.commit) return [];
          return [
            {
              nodeId: node.nodeId,
              alias: node.alias,
              currentRef: node.pin.ref,
              currentCommit: node.pin.commit,
              candidateRef: entry.promoted.ref,
              candidateCommit: entry.promoted.commit,
              candidateSnapshot: entry.promoted.snapshot,
            },
          ];
        });
    },

    async inspect(locator: TemplateLocator) {
      const env = await environment(ctx);
      return inspectLocator(ctx, env, locator);
    },

    async inspectAuthoring(input: TemplateAuthoringIntent) {
      return inspectTemplateAuthoring(ctx, await observeWorkspace(ctx), input);
    },

    async authoringParts() {
      return listTemplateAuthoringParts(ctx, await observeWorkspace(ctx));
    },

    async publishAuthoring(input: {
      commandId: string;
      intent: TemplateAuthoringIntent;
      expectedFingerprint: string;
      version: string;
      destination: {
        provider: string;
        owner: string;
        name: string;
      };
      credentialId?: string;
      creation?: {
        private?: boolean;
        description?: string;
      };
    }) {
      const existing = await readTemplateOperationRecord(ctx, input.commandId);
      const observation = await observeWorkspace(ctx);
      const creation = {
        private: input.creation?.private ?? true,
        description: input.creation?.description ?? input.intent.description,
      };
      const publicationIntent = {
        protocol: "vibestudio-template-authoring-publication/v1",
        destination: input.destination,
        version: input.version,
        credentialId: input.credentialId ?? null,
        creation,
        intent: input.intent,
        expectedFingerprint: input.expectedFingerprint,
      };
      let current: TemplateAuthoringInspection;
      if (existing) {
        if (
          existing.kind !== "publish-authoring" ||
          canonicalJson(existing.intent) !== canonicalJson(publicationIntent)
        ) {
          throw new Error(
            `Template publication command ${input.commandId} was already bound to a different request`
          );
        }
        if (!existing.authoringInspection) {
          throw new Error(`Template publication command ${input.commandId} has no authoring state`);
        }
        if (existing.authoringPublication) return existing.authoringPublication;
        current = existing.authoringInspection;
      } else {
        current = await inspectTemplateAuthoring(ctx, observation, input.intent);
        if (current.fingerprint !== input.expectedFingerprint) {
          throw new Error(
            "The workspace, dependency resolution, or authoring selection changed after inspection; inspect authoring again"
          );
        }
        await writeTemplateOperationRecord(ctx, {
          version: 1,
          operationId: input.commandId,
          kind: "publish-authoring",
          fingerprint: current.fingerprint,
          intent: publicationIntent,
          pins: [],
          affectedParts: [...current.includedParts],
          authoringInspection: current,
        });
      }
      const contextId = await ensureTemplateOperationContext(ctx, input.commandId);
      const build = await createAffectedBuildGate(ctx, observation.localRepoPaths)(
        contextId,
        current.includedParts
      );
      if (build.failures.length > 0) {
        throw new TemplateAuthoringBuildError(build.failures);
      }
      const publication = await ctx.extensions.invoke<TemplatePublication>(
        "@workspace-extensions/git-bridge",
        "publishTemplate",
        [
          {
            operationId: input.commandId,
            expectedMainEventId: current.mainEventId,
            templateName: current.request.name,
            version: input.version,
            manifest: current.manifest,
            manifestDigest: current.manifestDigest,
            parts: current.includedParts.map((repoPath) => ({ repoPath, subdir: repoPath })),
            destination: input.destination,
            ...(input.credentialId ? { credentialId: input.credentialId } : {}),
            creation,
          },
        ]
      );
      const record = await readTemplateOperationRecord(ctx, input.commandId);
      if (!record) {
        throw new Error(`Template publication ${input.commandId} lost its durable operation state`);
      }
      await updateTemplateOperationRecord(ctx, {
        ...record,
        authoringPublication: publication,
      });
      return publication;
    },

    async suggestRegistryEntry(input: {
      commandId: string;
      catalog: ServiceTemplateCatalogSnapshot;
      publication: TemplatePublication;
      credential?: string;
      entry: {
        id: string;
        name: string;
        description: string;
        tags: string[];
        recommended: boolean;
      };
      revision: string;
    }) {
      const env = await environment(ctx, { requireCatalog: true });
      const current = env.catalog!;
      if (input.catalog.stale || input.catalog.source !== "verified") {
        throw new Error("Refresh the template registry before preparing a contribution");
      }
      const reviewedCatalog = {
        version: input.catalog.version,
        revision: input.catalog.revision,
        systemEpoch: input.catalog.systemEpoch,
        entries: input.catalog.entries,
        coordinates: input.catalog.coordinates,
      };
      const currentCatalog = {
        version: current.version,
        revision: current.revision,
        systemEpoch: current.systemEpoch,
        entries: current.entries,
        coordinates: current.coordinates,
      };
      if (canonicalJson(reviewedCatalog) !== canonicalJson(currentCatalog)) {
        throw new Error(
          "The template registry changed after it was reviewed; refresh and review it again"
        );
      }
      const registrySource = env.observation.top.templates?.registry;
      if (!registrySource) throw new Error("Workspace does not declare templates.registry");
      if (normalizeTemplateGitUrl(registrySource.url) !== current.coordinates.url) {
        throw new Error("The configured template registry does not match the reviewed catalog");
      }
      const publicationUrl = normalizeTemplateGitUrl(input.publication.templateUrl);
      await acquireTemplateSnapshot(
        ctx,
        env.info.statePath,
        WorkspaceTemplatePinSchema.parse({
          url: publicationUrl,
          ref: input.publication.ref,
          commit: input.publication.commit,
          snapshot: input.publication.snapshot,
          ...(input.credential ? { credential: input.credential } : {}),
        }),
        canonicalTemplateNodeId(publicationUrl, input.publication.commit)
      );
      const idCollision = current.entries.find(
        (candidate) => candidate.id === input.entry.id && candidate.url !== publicationUrl
      );
      if (idCollision) {
        throw new Error(`Registry id ${input.entry.id} already belongs to ${idCollision.url}`);
      }
      const urlCollision = current.entries.find(
        (candidate) => candidate.url === publicationUrl && candidate.id !== input.entry.id
      );
      if (urlCollision) {
        throw new Error(`Published template URL already belongs to registry id ${urlCollision.id}`);
      }
      const entry = {
        ...input.entry,
        tags: [...new Set(input.entry.tags)].sort(),
        url: publicationUrl,
        promoted: {
          ref: input.publication.ref,
          commit: input.publication.commit,
          snapshot: input.publication.snapshot,
        },
      };
      const entries = current.entries
        .filter((candidate) => candidate.id !== entry.id)
        .concat(entry)
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const semanticallyChanged = canonicalJson(entries) !== canonicalJson(current.entries);
      if (semanticallyChanged && input.revision === current.revision) {
        throw new Error("A changed registry entry requires a new promotion revision");
      }
      if (!semanticallyChanged && input.revision === current.revision) {
        return {
          operationId: input.commandId,
          outcome: "nothing-to-suggest" as const,
          registryUrl: current.coordinates.url,
          baseCommit: current.coordinates.commit,
          branch: null,
          headCommit: null,
          revision: input.revision,
          entry,
        };
      }
      const registry = parseTemplateRegistry({
        version: 1,
        revision: input.revision,
        systemEpoch: current.systemEpoch,
        entries,
      });
      const registryDocument = YAML.stringify(registry, { lineWidth: 0 });
      const result = await ctx.extensions.invoke<{
        outcome: "pushed" | "already-at-remote" | "nothing-to-suggest";
        registryUrl: string;
        baseCommit: string;
        branch: string | null;
        headCommit: string | null;
      }>("@workspace-extensions/git-bridge", "suggestRegistryEntry", [
        {
          operationId: input.commandId,
          registryUrl: current.coordinates.url,
          baseCommit: current.coordinates.commit,
          baseSnapshot: current.coordinates.snapshot,
          registryDocument,
          entryId: entry.id,
          ...(registrySource.credential ? { credential: registrySource.credential } : {}),
        },
      ]);
      return {
        operationId: input.commandId,
        ...result,
        revision: registry.revision,
        entry: registry.entries.find((candidate) => candidate.id === entry.id)!,
      };
    },

    async add(input: { commandId: string; source: TemplateAddRequest }) {
      const existing = await readTemplateOperationRecord(ctx, input.commandId);
      const resolved = await resolveAddSource(ctx, input.source, existing);
      const env = resolved.env;
      const record = await operationRecordForMutation(ctx, env, input.commandId);
      const completed = await completedOperationResult(ctx, record);
      if (completed) return completed;
      const preview = await inspectAdd(
        ctx,
        env,
        resolved.pin,
        record?.pins ?? [],
        resolved.selection
      );
      return applyInspection(
        ctx,
        env,
        input.commandId,
        preview.inspection,
        record?.intent ?? {
          kind: "add",
          source: input.source,
          target: resolved.pin,
        }
      );
    },

    async adopt(input: { commandId: string; pin: WorkspaceTemplatePin }) {
      const env = await environment(ctx);
      const record = await operationRecordForMutation(ctx, env, input.commandId);
      const completed = await completedOperationResult(ctx, record);
      if (completed) return completed;
      const requestedPin = WorkspaceTemplatePinSchema.parse(input.pin);
      const recordedPin = record
        ? WorkspaceTemplatePinSchema.parse((record.intent as { target?: unknown }).target)
        : null;
      if (recordedPin && canonicalJson(recordedPin) !== canonicalJson(requestedPin)) {
        throw new Error(
          `Template command ${input.commandId} was already bound to a different exact version`
        );
      }
      const selectedPin = recordedPin ?? requestedPin;
      const preview = await inspectAdopt(ctx, env, selectedPin, record?.pins ?? []);
      return applyInspection(
        ctx,
        { ...env, observation: preview.observation },
        input.commandId,
        preview.inspection,
        record?.intent ?? {
          kind: "adopt",
          target: selectedPin,
        }
      );
    },

    async pull(input: {
      commandId: string;
      alias: string;
      toRef?: string;
      pin?: WorkspaceTemplatePin;
    }) {
      let env = await environment(ctx);
      const record = await operationRecordForMutation(ctx, env, input.commandId);
      const completed = await completedOperationResult(ctx, record);
      if (completed) return completed;
      const requestedPin = input.pin ? WorkspaceTemplatePinSchema.parse(input.pin) : null;
      if (!record && !requestedPin && !env.catalog) {
        env = await environment(ctx, { requireCatalog: true });
      }
      const node = env.observation.lock?.nodes.find((candidate) => candidate.alias === input.alias);
      if (!node) throw new Error(`Unknown installed template alias: ${input.alias}`);
      if (
        requestedPin &&
        normalizeTemplateGitUrl(requestedPin.url) !== normalizeTemplateGitUrl(node.pin.url)
      ) {
        throw new Error(
          `Exact pull target ${requestedPin.url} does not match installed template ${node.pin.url}`
        );
      }
      const entry = env.catalog?.entries.find(
        (candidate) =>
          normalizeTemplateGitUrl(candidate.url) === normalizeTemplateGitUrl(node.pin.url)
      );
      if (!entry && !record && !requestedPin) {
        throw new Error(`Template ${input.alias} is absent from the registry`);
      }
      const recordedPin = record
        ? WorkspaceTemplatePinSchema.parse((record.intent as { target?: unknown }).target)
        : null;
      if (
        recordedPin &&
        requestedPin &&
        canonicalJson(recordedPin) !== canonicalJson(requestedPin)
      ) {
        throw new Error(
          `Template command ${input.commandId} was already bound to a different exact version`
        );
      }
      const promotedRef = recordedPin?.ref ?? requestedPin?.ref ?? entry!.promoted.ref;
      if (input.toRef && input.toRef !== promotedRef) {
        throw new Error(
          `Template updates use the selected exact target ref ${promotedRef}, not ${input.toRef}`
        );
      }
      const pin: WorkspaceTemplatePin =
        recordedPin ??
        requestedPin ??
        WorkspaceTemplatePinSchema.parse({
          url: node.pin.url,
          ...entry!.promoted,
        });
      const ordinarySources = sourcePortsForEnvironment(ctx, env);
      const inspection = await inspectTemplateOperation({
        kind: "pull",
        pin,
        workspace: env.observation,
        sources: createPinnedTemplateSourcePorts(ordinarySources, record?.pins ?? []),
      });
      return applyInspection(
        ctx,
        env,
        input.commandId,
        inspection,
        record?.intent ?? {
          kind: "pull",
          alias: input.alias,
          target: pin,
        }
      );
    },

    async remove(input: { commandId: string; alias: string }) {
      const env = await environment(ctx);
      const record = await operationRecordForMutation(ctx, env, input.commandId);
      const completed = await completedOperationResult(ctx, record);
      if (completed) return completed;
      const node = env.observation.lock?.nodes.find((candidate) => candidate.alias === input.alias);
      if (!node) throw new Error(`Unknown installed template alias: ${input.alias}`);
      if (
        !env.observation.roots.some(
          (root) => normalizeTemplateGitUrl(root.url) === normalizeTemplateGitUrl(node.pin.url)
        )
      ) {
        throw new Error(`Inherited template ${input.alias} cannot be removed directly`);
      }
      const inspection = await inspectTemplateOperation({
        kind: "remove",
        templateUrl: node.pin.url,
        workspace: env.observation,
        sources: sourcePortsForEnvironment(ctx, env),
      });
      return applyInspection(
        ctx,
        env,
        input.commandId,
        inspection,
        record?.intent ?? {
          kind: "remove",
          alias: input.alias,
          templateUrl: node.pin.url,
        }
      );
    },

    async decideSuggestion(input: {
      commandId: string;
      alias: string;
      section: "trust" | "providers";
      decision: "accept" | "decline";
    }) {
      const env = await environment(ctx);
      const inspection = await inspectTemplateOperation({
        kind: "recompose",
        workspace: env.observation,
        sources: sourcePortsForEnvironment(ctx, env),
      });
      const node = inspection.plan.nodes.find((candidate) => candidate.alias === input.alias);
      if (!node) throw new Error(`Unknown installed template alias: ${input.alias}`);
      const value = node.excludedSuggestions[input.section];
      if (value === undefined) {
        throw new Error(`Template ${input.alias} has no exact ${input.section} suggestion`);
      }
      const digest = templateSuggestionDigest(node.nodeId, input.section, value);
      const decisionKey = `${node.nodeId}:${input.section}`;
      const recorded = env.observation.top.templates?.suggestionDecisions?.[decisionKey];
      const normalizedDecision =
        input.decision === "accept" ? ("accepted" as const) : ("declined" as const);
      if (recorded?.digest === digest && recorded.decision === normalizedDecision) {
        return {
          operationId: input.commandId,
          state: normalizedDecision,
          section: input.section,
        };
      }
      const merged =
        input.decision === "accept"
          ? mergeAcceptedTemplateSuggestion(env.observation.top, input.section, value)
          : env.observation.top;
      const top = WorkspaceConfigTopLayerSchema.parse({
        ...merged,
        templates: {
          ...merged.templates,
          use: merged.templates?.use ?? [],
          suggestionDecisions: {
            ...(merged.templates?.suggestionDecisions ?? {}),
            [decisionKey]: { digest, decision: normalizedDecision },
          },
        },
      });
      const publicationEventId = await publishTemplateSuggestionTopLayer(
        ctx,
        input.commandId,
        env.observation,
        top,
        inspection
      );
      return {
        operationId: input.commandId,
        state: normalizedDecision,
        section: input.section,
        publicationEventId,
      };
    },

    async suggest(input: { commandId: string; alias: string; parts?: string[] }) {
      const observation = await observeWorkspace(ctx);
      const node = observation.lock?.nodes.find((candidate) => candidate.alias === input.alias);
      if (!node) throw new Error(`Unknown installed template alias: ${input.alias}`);
      const contributed = Object.entries(observation.lock?.repositories ?? {})
        .filter(([, repository]) =>
          repository.contributions.some((contribution) => contribution.nodeId === node.nodeId)
        )
        .map(([repoPath]) => repoPath);
      const selected = input.parts ?? contributed;
      for (const repoPath of selected) {
        if (!observation.localRepoPaths.has(repoPath)) {
          throw new Error(`Unknown workspace repository ${repoPath}`);
        }
      }
      const result = await ctx.extensions.invoke<{
        branch: string | null;
        url?: string;
      }>("@workspace-extensions/git-bridge", "suggestTemplateContribution", [
        {
          operationId: input.commandId,
          nodeId: node.nodeId,
          alias: node.alias,
          url: node.pin.url,
          baseCommit: node.pin.commit,
          expectedMainEventId: observation.mainEventId,
          parts: selected.map((repoPath) => ({ repoPath, subdir: repoPath })),
          ...(node.pin.credential ? { credential: node.pin.credential } : {}),
        },
      ]);
      return {
        operationId: input.commandId,
        state: "applied" as const,
        contribution: result.branch
          ? { branch: result.branch, ...(result.url ? { url: result.url } : {}) }
          : undefined,
        affectedParts: [...selected].sort(),
      };
    },
  };
  return api;
}

export type Api = Awaited<ReturnType<typeof activate>>;
