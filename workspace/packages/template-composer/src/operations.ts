import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplateLock,
  WorkspaceTemplatePin,
  WorkspaceTemplatesConfig,
} from "@vibestudio/workspace-contracts/types";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import {
  emptyTemplateComposition,
  resolveTemplateComposition,
  TemplateRepoConflictError,
  type TemplateCompositionPlan,
  type TemplateSourcePorts,
} from "./resolver.js";

export interface TemplateRepositoryConflict {
  kind: "repository";
  repoPath: string;
  claimants: string[];
}

export interface TemplateOperationConflictPreview {
  inspection: TemplateOperationInspection;
  conflicts: TemplateRepositoryConflict[];
}

export interface TemplateCatalogSelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface TemplateWorkspaceObservation {
  roots: readonly WorkspaceTemplateDeclaration[];
  lock?: WorkspaceTemplateLock;
  localRepoPaths: ReadonlySet<string>;
  externallyOwnedRepoPaths: ReadonlySet<string>;
  conflicts?: Readonly<Record<string, string>>;
  overrides?: Readonly<Record<string, WorkspaceTemplatePin>>;
  expectedSystemEpoch: number;
}

export interface InspectTemplateAddInput {
  kind: "add";
  /** Present only for a registry card; direct URLs have an exact discovery proof. */
  selection?: TemplateCatalogSelection;
  template: WorkspaceTemplateDeclaration;
  workspace: TemplateWorkspaceObservation;
  sources: TemplateSourcePorts;
}

export interface InspectTemplatePullInput {
  kind: "pull";
  /** Exact promoted replacement selected by an explicit pull. */
  pin: WorkspaceTemplatePin;
  workspace: TemplateWorkspaceObservation;
  sources: TemplateSourcePorts;
}

export interface InspectTemplateRemoveInput {
  kind: "remove";
  /** Normalized by the core before filtering the current direct roots. */
  templateUrl: string;
  workspace: TemplateWorkspaceObservation;
  sources: TemplateSourcePorts;
}

export interface InspectTemplateRecompositionInput {
  kind: "recompose";
  workspace: TemplateWorkspaceObservation;
  sources: TemplateSourcePorts;
}

export interface InspectBootstrapAdoptionInput {
  kind: "adopt-bootstrap";
  /**
   * Read from `state/workspace-creation/v1.json`. Bootstrap imported this exact
   * tree but intentionally produced no template declaration or lock.
   */
  descriptor: WorkspaceCreationDescriptor;
  workspace: Omit<TemplateWorkspaceObservation, "roots" | "lock">;
  sources: TemplateSourcePorts;
}

export type InspectTemplateOperationInput =
  | InspectTemplateAddInput
  | InspectTemplatePullInput
  | InspectTemplateRemoveInput
  | InspectTemplateRecompositionInput
  | InspectBootstrapAdoptionInput;

export interface TemplateOperationInspection {
  kind: InspectTemplateOperationInput["kind"];
  plan: TemplateCompositionPlan;
  /** Complete next top-layer `templates` value; null removes the final relationship. */
  nextTemplates: WorkspaceTemplatesConfig | null;
  selection?: TemplateCatalogSelection;
}

function reachablePreviousUrls(
  lock: WorkspaceTemplateLock,
  roots: readonly WorkspaceTemplateDeclaration[]
): Set<string> {
  const nodeById = new Map(lock.nodes.map((node) => [node.nodeId, node]));
  const nodeByUrl = new Map(
    lock.nodes.map((node) => [normalizeTemplateGitUrl(node.pin.url), node])
  );
  const pending = roots
    .map((root) => nodeByUrl.get(normalizeTemplateGitUrl(root.url))?.nodeId)
    .filter((nodeId): nodeId is string => nodeId !== undefined);
  const urls = new Set<string>();
  while (pending.length > 0) {
    const node = nodeById.get(pending.pop()!);
    if (!node || urls.has(node.pin.url)) continue;
    urls.add(node.pin.url);
    pending.push(...node.parents);
  }
  return urls;
}

/**
 * Produce the complete review payload for add, pull, ordinary recomposition,
 * or first-run bootstrap adoption. No workspace mutation occurs.
 */
export async function inspectTemplateOperation(
  input: InspectTemplateOperationInput
): Promise<TemplateOperationInspection> {
  if (input.kind === "adopt-bootstrap") {
    const root = input.descriptor.rootTemplate;
    const rootUrl = normalizeTemplateGitUrl(root.url);
    const plan = await resolveTemplateComposition({
      roots: [{ url: rootUrl, ...(root.credential ? { credential: root.credential } : {}) }],
      localRepoPaths: new Set(),
      externallyOwnedRepoPaths: input.workspace.externallyOwnedRepoPaths,
      conflicts: input.workspace.conflicts,
      expectedSystemEpoch: input.workspace.expectedSystemEpoch,
      ports: {
        acquire: input.sources.acquire,
        resolvePromoted: async (declaration) =>
          normalizeTemplateGitUrl(declaration.url) === rootUrl
            ? root
            : input.sources.resolvePromoted(declaration),
      },
    });
    return {
      kind: input.kind,
      plan,
      nextTemplates: {
        use: plan.lock!.roots,
        overrides: plan.lock!.overrides,
        conflicts: plan.lock!.conflicts,
      },
    };
  }

  const roots =
    input.kind === "add"
      ? [...input.workspace.roots, input.template]
      : input.kind === "remove"
        ? input.workspace.roots.filter(
            (root) =>
              normalizeTemplateGitUrl(root.url) !== normalizeTemplateGitUrl(input.templateUrl)
          )
        : [...input.workspace.roots];
  const reachableUrls =
    input.kind === "remove" && input.workspace.lock
      ? reachablePreviousUrls(input.workspace.lock, roots)
      : undefined;
  const retainedOverrides = Object.fromEntries(
    Object.entries(input.workspace.overrides ?? {}).filter(
      ([url]) => !reachableUrls || reachableUrls.has(normalizeTemplateGitUrl(url))
    )
  );
  const pinOverrides =
    input.kind === "pull"
      ? { ...retainedOverrides, [normalizeTemplateGitUrl(input.pin.url)]: input.pin }
      : retainedOverrides;
  const plan =
    roots.length === 0
      ? emptyTemplateComposition(input.workspace.lock, input.workspace.localRepoPaths)
      : await resolveTemplateComposition({
          roots,
          pinOverrides,
          conflicts: input.workspace.conflicts,
          localRepoPaths: input.workspace.localRepoPaths,
          externallyOwnedRepoPaths: input.workspace.externallyOwnedRepoPaths,
          previousLock: input.workspace.lock,
          expectedSystemEpoch: input.workspace.expectedSystemEpoch,
          ports: input.sources,
        });
  return {
    kind: input.kind,
    plan,
    nextTemplates:
      plan.lock === null
        ? null
        : {
            use: plan.lock.roots,
            overrides: plan.lock.overrides,
            conflicts: plan.lock.conflicts,
          },
    ...(input.kind === "add" && input.selection ? { selection: input.selection } : {}),
  };
}

/**
 * Produce a complete preview even when unrelated templates claim one path.
 * Each discovered conflict is provisionally ignored only for purposes of
 * finishing the dry run; the returned inspection is never directly applied
 * while `conflicts` is non-empty.
 */
export async function inspectTemplateOperationWithConflicts(
  input: InspectTemplateOperationInput
): Promise<TemplateOperationConflictPreview> {
  if (input.kind === "adopt-bootstrap") {
    return { inspection: await inspectTemplateOperation(input), conflicts: [] };
  }
  const conflicts: TemplateRepositoryConflict[] = [];
  const provisional = { ...(input.workspace.conflicts ?? {}) };
  for (;;) {
    try {
      return {
        inspection: await inspectTemplateOperation({
          ...input,
          workspace: { ...input.workspace, conflicts: provisional },
        }),
        conflicts,
      };
    } catch (error) {
      if (!(error instanceof TemplateRepoConflictError)) throw error;
      if (provisional[error.repoPath] !== undefined) throw error;
      conflicts.push({
        kind: "repository",
        repoPath: error.repoPath,
        claimants: [...error.claimants],
      });
      provisional[error.repoPath] = "ignore";
    }
  }
}

export interface TemplateBuildFailure {
  unit: string;
  message: string;
}

export class TemplateBuildGateError extends Error {
  constructor(readonly failures: readonly TemplateBuildFailure[]) {
    super(
      `Template composition did not build: ${failures.map((failure) => failure.unit).join(", ")}`
    );
    this.name = "TemplateBuildGateError";
  }
}

/**
 * Runtime-neutral adapters owned by the userland broker/extension. The
 * operation context is the only journal; implementations must make
 * `openContext` resume an existing context with the same operation id.
 */
export interface TemplateOperationPorts {
  openContext(operationId: string): Promise<{ contextId: string }>;
  /**
   * Import exact repository contributions and generated meta artifacts into
   * the operation context. Returns repository paths whose effective content
   * changed, including removals and ownership transfers.
   */
  stageComposition(
    contextId: string,
    inspection: TemplateOperationInspection
  ): Promise<{ affectedRepoPaths: string[] }>;
  /** Build the affected unit closure at `ctx:<contextId>`. */
  buildAffected(
    contextId: string,
    affectedRepoPaths: readonly string[]
  ): Promise<{ failures: TemplateBuildFailure[] }>;
  /** Publish the already-reviewed context atomically to protected main. */
  publish(contextId: string, expectedMainEventId: string): Promise<{ mainEventId: string }>;
  discard(contextId: string): Promise<void>;
}

export interface ApplyTemplateOperationInput {
  operationId: string;
  expectedMainEventId: string;
  inspection: TemplateOperationInspection;
  ports: TemplateOperationPorts;
}

export interface PreparedTemplateOperation {
  contextId: string;
  affectedRepoPaths: string[];
}

export type TemplateOperationPreparation =
  | { status: "ready"; prepared: PreparedTemplateOperation }
  | {
      status: "build-failed";
      prepared: PreparedTemplateOperation;
      failures: TemplateBuildFailure[];
    };

/** Stage and build while retaining the context for an agentic repair on failure. */
async function prepareInContext(
  contextId: string,
  inspection: TemplateOperationInspection,
  ports: TemplateOperationPorts
): Promise<TemplateOperationPreparation> {
  const staged = await ports.stageComposition(contextId, inspection);
  const prepared = { contextId, affectedRepoPaths: staged.affectedRepoPaths };
  const build = await ports.buildAffected(contextId, staged.affectedRepoPaths);
  return build.failures.length === 0
    ? { status: "ready", prepared }
    : { status: "build-failed", prepared, failures: build.failures };
}

/** Stage and build while retaining the context for an agentic repair on failure. */
export async function prepareTemplateOperation(
  input: Pick<ApplyTemplateOperationInput, "operationId" | "inspection" | "ports">
): Promise<TemplateOperationPreparation> {
  const { contextId } = await input.ports.openContext(input.operationId);
  return prepareInContext(contextId, input.inspection, input.ports);
}

/** Re-run the gate after ordinary semantic edits repaired a retained context. */
export async function rebuildPreparedTemplateOperation(
  prepared: PreparedTemplateOperation,
  ports: TemplateOperationPorts
): Promise<TemplateOperationPreparation> {
  const build = await ports.buildAffected(prepared.contextId, prepared.affectedRepoPaths);
  return build.failures.length === 0
    ? { status: "ready", prepared }
    : { status: "build-failed", prepared, failures: build.failures };
}

export function publishPreparedTemplateOperation(
  prepared: PreparedTemplateOperation,
  expectedMainEventId: string,
  ports: TemplateOperationPorts
): Promise<{ mainEventId: string }> {
  return ports.publish(prepared.contextId, expectedMainEventId);
}

/**
 * Non-interactive convenience path. A failed build is discarded and can never
 * advance protected main. Interactive callers use `prepareTemplateOperation`,
 * repair the retained context, rebuild, then publish.
 */
export async function applyTemplateOperation(
  input: ApplyTemplateOperationInput
): Promise<{ mainEventId: string }> {
  let contextId: string | undefined;
  try {
    ({ contextId } = await input.ports.openContext(input.operationId));
    const preparation = await prepareInContext(contextId, input.inspection, input.ports);
    if (preparation.status === "build-failed") {
      throw new TemplateBuildGateError(preparation.failures);
    }
    return await publishPreparedTemplateOperation(
      preparation.prepared,
      input.expectedMainEventId,
      input.ports
    );
  } catch (error) {
    if (contextId) await input.ports.discard(contextId);
    throw error;
  }
}

export interface TemplateStatus {
  roots: Array<{
    url: string;
    nodeId: string | null;
    alias: string | null;
    pin: WorkspaceTemplatePin | null;
  }>;
  excludedSuggestions: Array<{
    nodeId: string;
    alias: string;
    trust?: unknown;
    providers?: unknown;
  }>;
}

/** Status is a pure local projection of the committed declaration and lock. */
export function templateStatus(
  roots: readonly WorkspaceTemplateDeclaration[],
  lock: WorkspaceTemplateLock | undefined,
  suggestionDecisions?: Readonly<
    Record<string, { digest: `v1-sha256:${string}`; decision: "accepted" | "declined" }>
  >
): TemplateStatus {
  const nodes = lock?.nodes ?? [];
  return {
    roots: roots.map((root) => {
      const url = normalizeTemplateGitUrl(root.url);
      const node = nodes.find((candidate) => normalizeTemplateGitUrl(candidate.pin.url) === url);
      return {
        url,
        nodeId: node?.nodeId ?? null,
        alias: node?.alias ?? null,
        pin: node?.pin ?? null,
      };
    }),
    excludedSuggestions: nodes.flatMap((node) => {
      const unresolved = Object.fromEntries(
        (["trust", "providers"] as const).flatMap((section) => {
          const evidence = node.suggestions[section];
          if (
            !evidence ||
            suggestionDecisions?.[`${node.nodeId}:${section}`]?.digest === evidence.digest
          ) {
            return [];
          }
          return [[section, evidence.value]];
        })
      );
      return Object.keys(unresolved).length > 0
        ? [{ nodeId: node.nodeId, alias: node.alias, ...unresolved }]
        : [];
    }),
  };
}
