import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplateState,
  WorkspaceTemplatePin,
  WorkspaceTemplatesConfig,
} from "@vibestudio/workspace-contracts/types";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import {
  emptyTemplateComposition,
  resolveTemplateComposition,
  type TemplateCompositionPlan,
  type TemplateSourcePorts,
} from "./resolver.js";

export interface TemplateCatalogSelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface TemplateWorkspaceObservation {
  roots: readonly WorkspaceTemplateDeclaration[];
  state?: WorkspaceTemplateState;
  installedLayers?: Readonly<Record<string, string>>;
  localRepoPaths: ReadonlySet<string>;
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

export interface InspectTemplateAdoptInput {
  kind: "adopt";
  /** Exact release whose contribution history the current workspace claims. */
  pin: WorkspaceTemplatePin;
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
   * tree but intentionally produced no template declaration or state.
   */
  descriptor: WorkspaceCreationDescriptor;
  workspace: Omit<TemplateWorkspaceObservation, "roots" | "state">;
  sources: TemplateSourcePorts;
}

export type InspectTemplateOperationInput =
  | InspectTemplateAddInput
  | InspectTemplateAdoptInput
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
  state: WorkspaceTemplateState,
  roots: readonly WorkspaceTemplateDeclaration[]
): Set<string> {
  const nodeById = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const nodeByUrl = new Map(
    state.nodes.map((node) => [normalizeTemplateGitUrl(node.pin.url), node])
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
 * Produce the complete review payload for add, lineage adoption, pull,
 * ordinary recomposition, or first-run bootstrap adoption. No workspace
 * mutation occurs.
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
        use: plan.state!.roots,
        overrides: plan.state!.overrides,
      },
    };
  }

  const roots =
    input.kind === "add" || input.kind === "adopt"
      ? [
          ...input.workspace.roots,
          input.kind === "add"
            ? input.template
            : {
                url: input.pin.url,
                ...(input.pin.credential ? { credential: input.pin.credential } : {}),
              },
        ]
      : input.kind === "remove"
        ? input.workspace.roots.filter(
            (root) =>
              normalizeTemplateGitUrl(root.url) !== normalizeTemplateGitUrl(input.templateUrl)
          )
        : [...input.workspace.roots];
  const reachableUrls =
    input.kind === "remove" && input.workspace.state
      ? reachablePreviousUrls(input.workspace.state, roots)
      : undefined;
  const retainedOverrides = Object.fromEntries(
    Object.entries(input.workspace.overrides ?? {}).filter(
      ([url]) => !reachableUrls || reachableUrls.has(normalizeTemplateGitUrl(url))
    )
  );
  const pinOverrides =
    input.kind === "pull" || input.kind === "adopt"
      ? { ...retainedOverrides, [normalizeTemplateGitUrl(input.pin.url)]: input.pin }
      : retainedOverrides;
  const plan =
    roots.length === 0
      ? emptyTemplateComposition(input.workspace.state, input.workspace.localRepoPaths)
      : await resolveTemplateComposition({
          roots,
          pinOverrides,
          localRepoPaths: input.workspace.localRepoPaths,
          previousState: input.workspace.state,
          installedLayers: input.workspace.installedLayers,
          expectedSystemEpoch: input.workspace.expectedSystemEpoch,
          ports: input.sources,
        });
  return {
    kind: input.kind,
    plan,
    nextTemplates:
      plan.state === null
        ? null
        : {
            use: plan.state.roots,
            overrides: plan.state.overrides,
          },
    ...(input.kind === "add" && input.selection ? { selection: input.selection } : {}),
  };
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
  /** Publish atomically through protected main's canonical validation and review gate. */
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

/** Stage the exact composition in a retained semantic context. */
async function stageInContext(
  contextId: string,
  inspection: TemplateOperationInspection,
  ports: TemplateOperationPorts
): Promise<PreparedTemplateOperation> {
  const staged = await ports.stageComposition(contextId, inspection);
  return { contextId, affectedRepoPaths: staged.affectedRepoPaths };
}

/** Stage while retaining the context for protected publication or agentic repair. */
export async function stageTemplateOperation(
  input: Pick<ApplyTemplateOperationInput, "operationId" | "inspection" | "ports">
): Promise<PreparedTemplateOperation> {
  const { contextId } = await input.ports.openContext(input.operationId);
  return stageInContext(contextId, input.inspection, input.ports);
}

export function publishPreparedTemplateOperation(
  prepared: PreparedTemplateOperation,
  expectedMainEventId: string,
  ports: TemplateOperationPorts
): Promise<{ mainEventId: string }> {
  return ports.publish(prepared.contextId, expectedMainEventId);
}

/**
 * Non-interactive convenience path. Protected main owns the one canonical
 * build/typecheck/schema/authority gate; this layer only stages and publishes.
 */
export async function applyTemplateOperation(
  input: ApplyTemplateOperationInput
): Promise<{ mainEventId: string }> {
  let contextId: string | undefined;
  try {
    ({ contextId } = await input.ports.openContext(input.operationId));
    const prepared = await stageInContext(contextId, input.inspection, input.ports);
    return await publishPreparedTemplateOperation(prepared, input.expectedMainEventId, input.ports);
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

/** Status is a pure local projection of the committed declaration and state. */
export function templateStatus(
  roots: readonly WorkspaceTemplateDeclaration[],
  state: WorkspaceTemplateState | undefined,
  suggestionDecisions?: Readonly<
    Record<string, { digest: `v1-sha256:${string}`; decision: "accepted" | "declined" }>
  >
): TemplateStatus {
  const nodes = state?.nodes ?? [];
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
