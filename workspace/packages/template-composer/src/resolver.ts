import YAML from "yaml";
import {
  canonicalJson,
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
  sha256HexSyncText,
  sortForCanonicalJson,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import type { ExactGitSnapshot, ExactSnapshotFile } from "@vibestudio/git";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  WorkspaceConfigFragmentSchema,
  WorkspaceConfigTopLayerSchema,
  WorkspaceTemplateDeclarationSchema,
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceTemplateDeclaration,
  WorkspaceTemplateLock,
  WorkspaceTemplateLockNode,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  TEMPLATE_SOURCE_MANIFEST_PATH,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import {
  assertTemplateLockIntegrityForRead,
  normalizeTemplateLockDeclaration,
  templateLockFingerprint,
  templateSuggestionDigest,
} from "@vibestudio/workspace/templateLock";

const TEMPLATE_FRAGMENT_DIR = "meta/templates";
const TEMPLATE_LOCK_PATH = "meta/templates.lock.yml";
const CONTAINER_SECTIONS = new Set([
  "panels",
  "apps",
  "packages",
  "workers",
  "extensions",
  "skills",
  "about",
  "templates",
  "projects",
]);

type ParsedTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
export type TemplateManifestFragment = ReturnType<typeof WorkspaceConfigFragmentSchema.parse>;

export class TemplateResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TemplateCycleError extends TemplateResolutionError {
  constructor(readonly aliases: readonly string[]) {
    super("template-cycle", `Template dependency cycle: ${aliases.join(" -> ")}`);
  }
}

export class TemplateManifestError extends TemplateResolutionError {
  constructor(
    readonly nodeId: string,
    message: string
  ) {
    super("template-manifest-invalid", `Invalid manifest for template ${nodeId}: ${message}`);
  }
}

export class TemplateCredentialConflictError extends TemplateResolutionError {
  constructor(
    readonly url: string,
    readonly credentials: readonly string[]
  ) {
    super(
      "template-credential-conflict",
      `Template ${url} is declared with incompatible logical credentials: ${credentials.join(", ")}`
    );
  }
}

export class TemplateRepoConflictError extends TemplateResolutionError {
  constructor(
    readonly repoPath: string,
    readonly claimants: readonly string[]
  ) {
    super(
      "template-repo-conflict",
      `Unrelated templates ${claimants.join(" and ")} both provide ${repoPath}; ` +
        `set templates.conflicts.${repoPath} to a claimant alias or ignore`
    );
  }
}

export class TemplateConflictResolutionError extends TemplateResolutionError {
  constructor(
    readonly repoPath: string,
    readonly resolution: string,
    readonly claimants: readonly string[]
  ) {
    super(
      "template-conflict-resolution-invalid",
      `Template conflict resolution ${JSON.stringify(resolution)} for ${repoPath} ` +
        `does not name one of its current claimants (${claimants.join(", ") || "none"})`
    );
  }
}

export class TemplateExternalRepoCollisionError extends TemplateResolutionError {
  constructor(
    readonly repoPath: string,
    readonly claimantAliases: readonly string[]
  ) {
    super(
      "template-external-repo-collision",
      `${repoPath} is declared as a unit-level Git upstream and is also vendored by ` +
        `${claimantAliases.join(", ")}; exactly one source may own a repository`
    );
  }
}

export interface TemplateSourcePorts {
  /**
   * Resolve the registry's exact promoted coordinate. Called at most once for
   * a URL, and never called for a URL already present in the lock or overrides.
   */
  resolvePromoted(declaration: WorkspaceTemplateDeclaration): Promise<WorkspaceTemplatePin>;
  /** Acquire and verify one exact snapshot. Blob/CAS storage lives behind this port. */
  acquire(pin: WorkspaceTemplatePin, nodeId: string): Promise<ExactGitSnapshot>;
}

export interface ResolvedTemplateNode {
  nodeId: string;
  alias: string;
  pin: WorkspaceTemplatePin;
  /** Direct dependency node ids. */
  parents: string[];
  fragment: TemplateManifestFragment;
  fragmentYaml: string;
  fragmentDigest: CanonicalSnapshotDigest;
  excludedSuggestions: {
    trust?: unknown;
    providers?: unknown;
  };
}

export interface TemplateRepositoryContribution {
  repoPath: string;
  nodeId: string;
  alias: string;
  subdir: string;
  subtreeDigest: CanonicalSnapshotDigest;
  files: ExactSnapshotFile[];
}

export interface TemplateOwnershipChange {
  repoPath: string;
  fromNodeId: string | null;
  toNodeId: string | null;
  reason: "orphaned" | "transferred" | "explicit-resolution";
}

export interface TemplateGeneratedArtifact {
  path: string;
  bytes: Uint8Array;
  contentHash: string;
  size: number;
  mode: 0o644;
}

export interface TemplateCompositionPlan {
  version: 1;
  fingerprint: CanonicalSnapshotDigest;
  rootNodeIds: string[];
  nodes: ResolvedTemplateNode[];
  repositories: Record<string, TemplateRepositoryContribution>;
  localRepoPaths: string[];
  ownershipChanges: TemplateOwnershipChange[];
  lock: WorkspaceTemplateLock | null;
  artifacts: TemplateGeneratedArtifact[];
  /** Previously generated files that must be removed in this composition. */
  removedArtifactPaths: string[];
}

export interface ResolveTemplateCompositionInput {
  roots: readonly WorkspaceTemplateDeclaration[];
  /** Exact, deliberate source replacements keyed by normalized URL. */
  pinOverrides?: Readonly<Record<string, WorkspaceTemplatePin>>;
  conflicts?: Readonly<Record<string, string>>;
  localRepoPaths?: ReadonlySet<string>;
  externallyOwnedRepoPaths?: ReadonlySet<string>;
  previousLock?: WorkspaceTemplateLock;
  expectedSystemEpoch: number;
  ports: TemplateSourcePorts;
}

interface MutableNode extends ResolvedTemplateNode {
  snapshot: ExactGitSnapshot;
}

interface ParsedTemplateManifest {
  dependencies: WorkspaceTemplateDeclaration[];
  fragment: TemplateManifestFragment;
  fragmentYaml: string;
  fragmentDigest: CanonicalSnapshotDigest;
  excludedSuggestions: ResolvedTemplateNode["excludedSuggestions"];
}

function canonicalYaml(value: unknown): string {
  return YAML.stringify(sortForCanonicalJson(value), {
    lineWidth: 0,
    sortMapEntries: true,
  });
}

function digestBytes(bytes: Uint8Array): CanonicalSnapshotDigest {
  return `v1-sha256:${sha256Hex(bytes)}`;
}

export { templateSuggestionDigest } from "@vibestudio/workspace/templateLock";

function normalizeDeclaration(value: WorkspaceTemplateDeclaration): WorkspaceTemplateDeclaration {
  const declaration = WorkspaceTemplateDeclarationSchema.parse(value);
  return { ...declaration, url: normalizeTemplateGitUrl(declaration.url) };
}

function normalizePin(value: WorkspaceTemplatePin): WorkspaceTemplatePin {
  const pin = WorkspaceTemplatePinSchema.parse(value);
  return { ...pin, url: normalizeTemplateGitUrl(pin.url) };
}

function sanitizeTemplateManifest(top: ParsedTopLayer): TemplateManifestFragment {
  const {
    templates: _templates,
    disable: _disable,
    trust: _trust,
    providers: _providers,
    git,
    ...accepted
  } = top;
  const upstreams =
    git?.upstreams === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(git.upstreams).map(([section, repositories]) => [
            section,
            Object.fromEntries(
              Object.entries(repositories).map(([repo, upstream]) => {
                const {
                  authorEmail: _authorEmail,
                  authorName: _authorName,
                  ...portable
                } = upstream;
                return [repo, portable];
              })
            ),
          ])
        );
  return WorkspaceConfigFragmentSchema.parse({
    ...accepted,
    ...(git === undefined
      ? {}
      : {
          git: {
            ...(git.remotes === undefined ? {} : { remotes: git.remotes }),
            ...(upstreams === undefined ? {} : { upstreams }),
          },
        }),
  });
}

function parseTemplateManifest(
  nodeId: string,
  snapshot: ExactGitSnapshot,
  expectedSystemEpoch: number
): ParsedTemplateManifest {
  const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
  if (!bytes) {
    throw new TemplateManifestError(nodeId, `missing required ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const top = WorkspaceConfigTopLayerSchema.parse(YAML.parse(text) as unknown);
    if (top.systemEpoch !== expectedSystemEpoch) {
      throw new Error(
        `systemEpoch ${top.systemEpoch} is incompatible with workspace epoch ${expectedSystemEpoch}`
      );
    }
    if (top.templates?.overrides && Object.keys(top.templates.overrides).length > 0) {
      throw new Error("template manifests cannot impose exact template overrides");
    }
    if (top.templates?.conflicts && Object.keys(top.templates.conflicts).length > 0) {
      throw new Error("template manifests cannot impose repository conflict decisions");
    }
    if (top.templates?.registry) {
      throw new Error("template manifests cannot replace the workspace template registry");
    }
    const fragment = sanitizeTemplateManifest(top);
    const fragmentYaml = canonicalYaml(fragment);
    return {
      dependencies: (top.templates?.use ?? []).map(normalizeDeclaration),
      fragment,
      fragmentYaml,
      fragmentDigest: digestBytes(new TextEncoder().encode(fragmentYaml)),
      excludedSuggestions: {
        ...(top.trust === undefined ? {} : { trust: top.trust }),
        ...(top.providers === undefined ? {} : { providers: top.providers }),
      },
    };
  } catch (error) {
    if (error instanceof TemplateManifestError) throw error;
    throw new TemplateManifestError(nodeId, error instanceof Error ? error.message : String(error));
  }
}

function enumerateRepoFiles(node: MutableNode): Map<string, ExactSnapshotFile[]> {
  const repositories = new Map<string, ExactSnapshotFile[]>();
  for (const file of node.snapshot.files) {
    const parts = file.path.split("/");
    const section = parts[0];
    if (!section || !CONTAINER_SECTIONS.has(section)) continue;
    if (parts.length === 2) {
      throw new TemplateManifestError(
        node.nodeId,
        `${file.path} sits at the root of container section ${section}; ` +
          `template units must live under ${section}/<name>/`
      );
    }
    const unit = parts[1];
    if (!unit || parts.length < 3) continue;
    const repoPath = normalizeWorkspaceRepoPath(`${section}/${unit}`);
    const list = repositories.get(repoPath) ?? [];
    list.push({ ...file, path: parts.slice(2).join("/") });
    repositories.set(repoPath, list);
  }
  for (const files of repositories.values()) {
    files.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  }
  return repositories;
}

function subtreeDigest(files: readonly ExactSnapshotFile[]): CanonicalSnapshotDigest {
  return canonicalSnapshotDigest(
    files.map((file) => ({
      path: file.path,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
      size: file.size,
      contentHash: file.contentHash,
    }))
  );
}

function fragmentUpstreamPaths(fragment: TemplateManifestFragment): string[] {
  const paths: string[] = [];
  for (const [section, repositories] of Object.entries(fragment.git?.upstreams ?? {})) {
    for (const repo of Object.keys(repositories)) {
      paths.push(normalizeWorkspaceRepoPath(`${section}/${repo}`));
    }
  }
  return paths;
}

function requireNode(nodes: ReadonlyMap<string, MutableNode>, nodeId: string): MutableNode {
  const node = nodes.get(nodeId);
  if (!node) {
    throw new TemplateResolutionError(
      "template-graph-integrity",
      `Resolved template graph is missing node ${nodeId}`
    );
  }
  return node;
}

function topologicalNodes(nodes: ReadonlyMap<string, MutableNode>): MutableNode[] {
  const remainingParents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    remainingParents.set(node.nodeId, new Set(node.parents));
    for (const parent of node.parents) {
      const dependants = children.get(parent) ?? new Set<string>();
      dependants.add(node.nodeId);
      children.set(parent, dependants);
    }
  }
  const ready = [...nodes.keys()]
    .filter((nodeId) => remainingParents.get(nodeId)?.size === 0)
    .sort(compareUtf16CodeUnits);
  const ordered: MutableNode[] = [];
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    ordered.push(requireNode(nodes, nodeId));
    for (const child of children.get(nodeId) ?? []) {
      const parents = remainingParents.get(child);
      if (!parents) continue;
      parents.delete(nodeId);
      if (parents.size === 0) {
        ready.push(child);
        ready.sort(compareUtf16CodeUnits);
      }
    }
  }
  if (ordered.length !== nodes.size) {
    throw new TemplateResolutionError(
      "template-cycle",
      "Template graph is cyclic and cannot be topologically ordered"
    );
  }
  return ordered;
}

function ancestorSets(nodes: readonly MutableNode[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const node of nodes) {
    const ancestors = new Set<string>();
    for (const parent of node.parents) {
      ancestors.add(parent);
      for (const ancestor of result.get(parent) ?? []) ancestors.add(ancestor);
    }
    result.set(node.nodeId, ancestors);
  }
  return result;
}

function maximalClaimants(
  claimants: readonly string[],
  ancestors: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  return claimants.filter(
    (candidate) =>
      !claimants.some((other) => other !== candidate && ancestors.get(other)?.has(candidate))
  );
}

function normalizedPaths(paths: ReadonlySet<string> | undefined): Set<string> {
  return new Set([...(paths ?? [])].map(normalizeWorkspaceRepoPath));
}

function previousOwnerSuccessor(
  repoPath: string,
  previousLock: WorkspaceTemplateLock | undefined,
  currentNodeByUrl: ReadonlyMap<string, string>,
  claims: ReadonlyMap<string, ReadonlyMap<string, TemplateRepositoryContribution>>
): string | null {
  const previousNodeId = previousLock?.repositories[repoPath]?.nodeId;
  if (!previousNodeId) return null;
  if (claims.get(repoPath)?.has(previousNodeId)) return previousNodeId;
  const previousNode = previousLock?.nodes.find((node) => node.nodeId === previousNodeId);
  if (!previousNode) return null;
  const successor = currentNodeByUrl.get(normalizeTemplateGitUrl(previousNode.pin.url));
  return successor && claims.get(repoPath)?.has(successor) ? successor : null;
}

function lockNodeUrl(
  lock: WorkspaceTemplateLock | undefined,
  nodeId: string | null
): string | null {
  if (!lock || !nodeId) return null;
  const node = lock.nodes.find((candidate) => candidate.nodeId === nodeId);
  return node ? normalizeTemplateGitUrl(node.pin.url) : null;
}

function artifact(path: string, text: string): TemplateGeneratedArtifact {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    bytes,
    contentHash: sha256Hex(bytes),
    size: bytes.byteLength,
    mode: 0o644,
  };
}

function normalizedOverrides(
  overrides: Readonly<Record<string, WorkspaceTemplatePin>> | undefined
): Map<string, WorkspaceTemplatePin> {
  const result = new Map<string, WorkspaceTemplatePin>();
  for (const [declaredUrl, value] of Object.entries(overrides ?? {})) {
    const url = normalizeTemplateGitUrl(declaredUrl);
    const pin = normalizePin(value);
    if (pin.url !== url) {
      throw new TemplateResolutionError(
        "template-override-invalid",
        `Template override key ${declaredUrl} does not match pin URL ${value.url}`
      );
    }
    result.set(url, pin);
  }
  return result;
}

/**
 * Resolve and slice a complete template closure without mutating workspace
 * state. Every external effect is behind `TemplateSourcePorts`.
 */
export async function resolveTemplateComposition(
  input: ResolveTemplateCompositionInput
): Promise<TemplateCompositionPlan> {
  if (input.roots.length === 0) {
    throw new TemplateResolutionError(
      "template-root-missing",
      "Template composition requires at least one URL root"
    );
  }

  const declaration = normalizeTemplateLockDeclaration({
    use: input.roots,
    overrides: input.pinOverrides,
    conflicts: input.conflicts,
  });
  const rootsByUrl = new Map(declaration.roots.map((root) => [root.url, root]));
  const overrides = normalizedOverrides(declaration.overrides);
  const usedOverrides = new Set<string>();
  const previousLock = input.previousLock
    ? assertTemplateLockIntegrityForRead(input.previousLock)
    : undefined;
  const lockedByUrl = new Map(
    (previousLock?.nodes ?? []).map((node) => [normalizeTemplateGitUrl(node.pin.url), node.pin])
  );
  const selectedPins = new Map<string, WorkspaceTemplatePin>();
  const declaredCredentials = new Map<string, string | undefined>();
  const nodes = new Map<string, MutableNode>();
  const nodeByUrl = new Map<string, string>();
  const visiting: string[] = [];

  const selectPin = async (raw: WorkspaceTemplateDeclaration): Promise<WorkspaceTemplatePin> => {
    const dependency = normalizeDeclaration(raw);
    const root = rootsByUrl.get(dependency.url);
    const requestedCredential = root?.credential ?? dependency.credential;
    if (!root && declaredCredentials.has(dependency.url)) {
      const priorCredential = declaredCredentials.get(dependency.url);
      if (priorCredential !== requestedCredential) {
        throw new TemplateCredentialConflictError(
          dependency.url,
          [priorCredential ?? "<anonymous>", requestedCredential ?? "<anonymous>"].sort(
            compareUtf16CodeUnits
          )
        );
      }
    }
    declaredCredentials.set(dependency.url, requestedCredential);
    const selected = selectedPins.get(dependency.url);
    if (selected) return selected;

    const override = overrides.get(dependency.url);
    const locked = lockedByUrl.get(dependency.url);
    const resolved = override ?? locked ?? (await input.ports.resolvePromoted(dependency));
    if (override) usedOverrides.add(dependency.url);
    const pin = normalizePin({
      ...resolved,
      url: dependency.url,
      ...(requestedCredential === undefined
        ? { credential: undefined }
        : { credential: requestedCredential }),
    });
    if (normalizeTemplateGitUrl(resolved.url) !== dependency.url) {
      throw new TemplateResolutionError(
        "template-resolution-coordinate-mismatch",
        `Exact resolution for ${dependency.url} returned coordinates for ${resolved.url}`
      );
    }
    selectedPins.set(dependency.url, pin);
    return pin;
  };

  const visit = async (
    raw: WorkspaceTemplateDeclaration,
    path: readonly string[]
  ): Promise<string> => {
    const dependency = normalizeDeclaration(raw);
    const cycleAt = visiting.indexOf(dependency.url);
    if (cycleAt >= 0) {
      throw new TemplateCycleError(
        [...visiting.slice(cycleAt), dependency.url].map(templateAliasFromUrl)
      );
    }
    const existingId = nodeByUrl.get(dependency.url);
    if (existingId) {
      await selectPin(dependency);
      return existingId;
    }

    const pin = await selectPin(dependency);
    const nodeId = canonicalTemplateNodeId(pin.url, pin.commit);
    const alias = templateAliasFromUrl(pin.url);
    visiting.push(dependency.url);
    try {
      const snapshot = await input.ports.acquire(pin, nodeId);
      if (snapshot.commit.toLowerCase() !== pin.commit || snapshot.snapshot !== pin.snapshot) {
        throw new TemplateResolutionError(
          "template-snapshot-integrity",
          `Acquirer returned coordinates that do not match exact pin for ${pin.url}`
        );
      }
      const parsed = parseTemplateManifest(nodeId, snapshot, input.expectedSystemEpoch);
      const node: MutableNode = {
        nodeId,
        alias,
        pin,
        parents: [],
        snapshot,
        fragment: parsed.fragment,
        fragmentYaml: parsed.fragmentYaml,
        fragmentDigest: parsed.fragmentDigest,
        excludedSuggestions: parsed.excludedSuggestions,
      };
      nodes.set(nodeId, node);
      nodeByUrl.set(dependency.url, nodeId);
      const parents: string[] = [];
      const dependencies = [...parsed.dependencies].sort((left, right) =>
        compareUtf16CodeUnits(left.url, right.url)
      );
      for (const parent of dependencies) {
        parents.push(await visit(parent, [...path, alias]));
      }
      node.parents = [...new Set(parents)].sort(compareUtf16CodeUnits);
      return nodeId;
    } catch (error) {
      nodes.delete(nodeId);
      nodeByUrl.delete(dependency.url);
      throw error;
    } finally {
      visiting.pop();
    }
  };

  const rootNodeIds: string[] = [];
  for (const root of declaration.roots) rootNodeIds.push(await visit(root, []));
  for (const url of overrides.keys()) {
    if (!usedOverrides.has(url)) {
      throw new TemplateResolutionError(
        "template-override-unused",
        `Template override for ${url} is not reachable from the selected roots`
      );
    }
  }

  const ordered = topologicalNodes(nodes);
  const ancestors = ancestorSets(ordered);
  const claims = new Map<string, Map<string, TemplateRepositoryContribution>>();
  const externalPaths = normalizedPaths(input.externallyOwnedRepoPaths);
  for (const node of ordered) {
    for (const repoPath of fragmentUpstreamPaths(node.fragment)) externalPaths.add(repoPath);
    for (const [repoPath, files] of enumerateRepoFiles(node)) {
      const repoClaims = claims.get(repoPath) ?? new Map();
      repoClaims.set(node.nodeId, {
        repoPath,
        nodeId: node.nodeId,
        alias: node.alias,
        subdir: repoPath,
        subtreeDigest: subtreeDigest(files),
        files,
      });
      claims.set(repoPath, repoClaims);
    }
  }
  for (const repoPath of externalPaths) {
    const repoClaims = claims.get(repoPath);
    if (repoClaims) {
      throw new TemplateExternalRepoCollisionError(
        repoPath,
        [...repoClaims.values()].map((claim) => claim.alias).sort(compareUtf16CodeUnits)
      );
    }
  }

  const localPaths = normalizedPaths(input.localRepoPaths);
  const currentNodeByUrl = new Map(ordered.map((node) => [node.pin.url, node.nodeId]));
  const conflicts = Object.fromEntries(
    Object.entries(declaration.conflicts).map(([repoPath, resolution]) => [
      normalizeWorkspaceRepoPath(repoPath),
      resolution,
    ])
  );
  const repositories: Record<string, TemplateRepositoryContribution> = {};
  const ownershipChanges: TemplateOwnershipChange[] = [];
  const allPaths = [
    ...new Set([
      ...claims.keys(),
      ...Object.keys(previousLock?.repositories ?? {}),
      ...Object.keys(conflicts),
    ]),
  ].sort(compareUtf16CodeUnits);

  for (const repoPath of allPaths) {
    const pathClaims = claims.get(repoPath) ?? new Map();
    const claimantIds = [...pathClaims.keys()].sort(compareUtf16CodeUnits);
    const claimantAliases = claimantIds
      .map((nodeId) => requireNode(nodes, nodeId).alias)
      .sort(compareUtf16CodeUnits);
    const previousNodeId = previousLock?.repositories[repoPath]?.nodeId ?? null;
    const successor = previousOwnerSuccessor(repoPath, previousLock, currentNodeByUrl, claims);
    const resolution = conflicts[repoPath];
    let selected: string | null = null;

    if (resolution !== undefined) {
      if (resolution !== "ignore") {
        selected = claimantIds.find((nodeId) => nodes.get(nodeId)?.alias === resolution) ?? null;
        if (!selected) {
          throw new TemplateConflictResolutionError(repoPath, resolution, claimantAliases);
        }
      }
    } else if (successor) {
      selected = successor;
    } else if (localPaths.has(repoPath) || previousNodeId) {
      selected = null;
    } else if (claimantIds.length === 1) {
      selected = claimantIds[0] ?? null;
    } else if (claimantIds.length > 1) {
      const maximal = maximalClaimants(claimantIds, ancestors);
      if (maximal.length !== 1) {
        throw new TemplateRepoConflictError(
          repoPath,
          maximal.map((nodeId) => requireNode(nodes, nodeId).alias).sort(compareUtf16CodeUnits)
        );
      }
      selected = maximal[0] ?? null;
    }

    if (selected) {
      const contribution = pathClaims.get(selected);
      if (!contribution) {
        throw new TemplateResolutionError(
          "template-assignment-integrity",
          `Selected template ${selected} does not contribute ${repoPath}`
        );
      }
      repositories[repoPath] = contribution;
    }
    const previousUrl = lockNodeUrl(previousLock, previousNodeId);
    const selectedUrl = selected ? requireNode(nodes, selected).pin.url : null;
    const sameOwner = previousUrl !== null && selectedUrl !== null && previousUrl === selectedUrl;
    if (previousNodeId && previousNodeId !== selected && !sameOwner) {
      ownershipChanges.push({
        repoPath,
        fromNodeId: previousNodeId,
        toNodeId: selected,
        reason:
          resolution !== undefined ? "explicit-resolution" : selected ? "transferred" : "orphaned",
      });
    } else if (!previousNodeId && resolution !== undefined && selected) {
      ownershipChanges.push({
        repoPath,
        fromNodeId: null,
        toNodeId: selected,
        reason: "explicit-resolution",
      });
    }
  }

  const lockNodes: WorkspaceTemplateLockNode[] = ordered.map((node) => ({
    nodeId: node.nodeId,
    alias: node.alias,
    pin: node.pin,
    parents: node.parents,
    fragmentDigest: node.fragmentDigest,
    suggestions: Object.fromEntries(
      (["trust", "providers"] as const).flatMap((section) => {
        const value = node.excludedSuggestions[section];
        return value === undefined
          ? []
          : [[section, { digest: templateSuggestionDigest(node.nodeId, section, value), value }]];
      })
    ),
  }));
  const lockRepositories = Object.fromEntries(
    Object.entries(repositories)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([repoPath, contribution]) => [
        repoPath,
        { nodeId: contribution.nodeId, subtreeDigest: contribution.subtreeDigest },
      ])
  );
  const lockWithoutFingerprint: Omit<WorkspaceTemplateLock, "fingerprint"> = {
    version: 1,
    roots: declaration.roots,
    overrides: declaration.overrides,
    conflicts: declaration.conflicts,
    nodes: lockNodes,
    repositories: lockRepositories,
    verification: "verified",
  };
  const lock: WorkspaceTemplateLock = {
    ...lockWithoutFingerprint,
    fingerprint: templateLockFingerprint(lockWithoutFingerprint),
  };
  const fingerprint: CanonicalSnapshotDigest = `v1-sha256:${sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-composition-v1",
      roots: [...new Set(rootNodeIds)].sort(compareUtf16CodeUnits),
      lock: {
        roots: lock.roots,
        overrides: lock.overrides,
        conflicts: lock.conflicts,
        nodes: lock.nodes,
        repositories: lock.repositories,
      },
    })
  )}`;
  const resolvedNodes: ResolvedTemplateNode[] = ordered.map(
    ({ snapshot: _snapshot, ...node }) => node
  );
  const artifacts = [
    ...resolvedNodes.map((node) =>
      artifact(`${TEMPLATE_FRAGMENT_DIR}/${node.nodeId}.yml`, node.fragmentYaml)
    ),
    artifact(TEMPLATE_LOCK_PATH, canonicalYaml(lock)),
  ].sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const currentNodeIds = new Set(resolvedNodes.map((node) => node.nodeId));
  const removedArtifactPaths = (previousLock?.nodes ?? [])
    .filter((node) => !currentNodeIds.has(node.nodeId))
    .map((node) => `${TEMPLATE_FRAGMENT_DIR}/${node.nodeId}.yml`)
    .sort(compareUtf16CodeUnits);

  return {
    version: 1,
    fingerprint,
    rootNodeIds: [...new Set(rootNodeIds)].sort(compareUtf16CodeUnits),
    nodes: resolvedNodes,
    repositories,
    localRepoPaths: [...localPaths].sort(compareUtf16CodeUnits),
    ownershipChanges,
    lock,
    artifacts,
    removedArtifactPaths,
  };
}

/** The canonical result of removing the final direct root. */
export function emptyTemplateComposition(
  previousLock: WorkspaceTemplateLock | null | undefined,
  localRepoPaths: ReadonlySet<string> = new Set()
): TemplateCompositionPlan {
  const checked = previousLock ? assertTemplateLockIntegrityForRead(previousLock) : null;
  return {
    version: 1,
    fingerprint: `v1-sha256:${sha256HexSyncText(
      canonicalJson({ protocol: "vibestudio-template-composition-v1", roots: [], lock: null })
    )}`,
    rootNodeIds: [],
    nodes: [],
    repositories: {},
    localRepoPaths: [...normalizedPaths(localRepoPaths)].sort(compareUtf16CodeUnits),
    ownershipChanges: Object.entries(checked?.repositories ?? {})
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([repoPath, repository]) => ({
        repoPath,
        fromNodeId: repository.nodeId,
        toNodeId: null,
        reason: "orphaned" as const,
      })),
    lock: null,
    artifacts: [],
    removedArtifactPaths: [
      ...(checked?.nodes ?? []).map((node) => `${TEMPLATE_FRAGMENT_DIR}/${node.nodeId}.yml`),
      TEMPLATE_LOCK_PATH,
    ].sort(compareUtf16CodeUnits),
  };
}
