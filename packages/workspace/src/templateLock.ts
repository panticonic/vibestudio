import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256Hex,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import {
  WorkspaceTemplateLockSchema,
  WorkspaceTemplateDeclarationSchema,
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceTemplateLock,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
  WorkspaceTemplatesConfig,
} from "@vibestudio/workspace-contracts/types";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "./templateCoordinates.js";

/** A generated lock is only useful when it still realizes this exact declaration. */
export interface TemplateLockDeclaration {
  roots: WorkspaceTemplateDeclaration[];
  overrides: Record<string, WorkspaceTemplatePin>;
}

export interface TemplateLockDeclarationInput {
  use?: readonly WorkspaceTemplateDeclaration[];
  overrides?: Readonly<Record<string, WorkspaceTemplatePin>>;
}

export class TemplateLockIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateLockIntegrityError";
  }
}

function normalizedPin(input: WorkspaceTemplatePin): WorkspaceTemplatePin {
  const pin = WorkspaceTemplatePinSchema.parse(input);
  return { ...pin, url: normalizeTemplateGitUrl(pin.url) };
}

function normalizedDeclaration(input: WorkspaceTemplateDeclaration): WorkspaceTemplateDeclaration {
  const declaration = WorkspaceTemplateDeclarationSchema.parse(input);
  return { ...declaration, url: normalizeTemplateGitUrl(declaration.url) };
}

export function templateSuggestionDigest(
  nodeId: string,
  section: "trust" | "providers",
  value: unknown
): `v1-sha256:${string}` {
  return `v1-sha256:${sha256HexSyncText(
    canonicalJson({ protocol: "template-suggestion-v1", nodeId, section, value })
  )}`;
}

/**
 * Normalize the sole set of workspace-authored inputs to template resolution.
 * The lock persists this exact normalized value, rather than trying to infer
 * roots or overrides from the resolved closure.
 */
export function normalizeTemplateLockDeclaration(
  templates: TemplateLockDeclarationInput | WorkspaceTemplatesConfig | undefined
): TemplateLockDeclaration {
  const rootsByUrl = new Map<string, WorkspaceTemplateDeclaration>();
  for (const raw of templates?.use ?? []) {
    const declaration = normalizedDeclaration(raw);
    const existing = rootsByUrl.get(declaration.url);
    if (existing && canonicalJson(existing) !== canonicalJson(declaration)) {
      throw new TemplateLockIntegrityError(
        `Template roots declare incompatible credentials for ${declaration.url}`
      );
    }
    rootsByUrl.set(declaration.url, declaration);
  }
  const roots = [...rootsByUrl.values()].sort((left, right) =>
    compareUtf16CodeUnits(left.url, right.url)
  );

  const overrideEntries: [string, WorkspaceTemplatePin][] = [];
  for (const [declaredUrl, raw] of Object.entries(templates?.overrides ?? {})) {
    const url = normalizeTemplateGitUrl(declaredUrl);
    const pin = normalizedPin(raw);
    if (url !== pin.url) {
      throw new TemplateLockIntegrityError(
        `Template override key ${declaredUrl} does not match pin URL ${raw.url}`
      );
    }
    overrideEntries.push([url, pin]);
  }
  overrideEntries.sort(([left], [right]) => compareUtf16CodeUnits(left, right));

  return { roots, overrides: Object.fromEntries(overrideEntries) };
}

/**
 * Commit to the closure a lock encodes. `verification` is deliberately NOT
 * hashed even though the parameter carries it: it records whether this host has
 * re-derived the closure from its pinned sources yet, which is local progress
 * rather than part of the closure's identity. Hashing it would give the same
 * closure two fingerprints and make `assertTemplateLockAnchoredToSource` — which
 * normalizes `verification` before comparing — unable to match a deferred lock
 * against its verified source.
 */
export function templateLockFingerprint(
  lock: Omit<WorkspaceTemplateLock, "fingerprint">
): `v1-sha256:${string}` {
  return `v1-sha256:${sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-lock-v1",
      version: lock.version,
      roots: lock.roots,
      overrides: lock.overrides,
      nodes: lock.nodes,
      repositories: lock.repositories,
    })
  )}`;
}

function assertCanonicalDeclaration(lock: WorkspaceTemplateLock): TemplateLockDeclaration {
  const declaration = normalizeTemplateLockDeclaration({
    use: lock.roots,
    overrides: lock.overrides,
  });
  if (
    canonicalJson(declaration.roots) !== canonicalJson(lock.roots) ||
    canonicalJson(declaration.overrides) !== canonicalJson(lock.overrides)
  ) {
    throw new TemplateLockIntegrityError(
      "Template lock declaration is not normalized; regenerate the template lock"
    );
  }
  return declaration;
}

/** Verify both lock bytes and the closure encoded by a generated lock. */
export function assertTemplateLockIntegrityForRead(input: unknown): WorkspaceTemplateLock {
  const lock = WorkspaceTemplateLockSchema.parse(input) as WorkspaceTemplateLock;
  const expected = templateLockFingerprint({
    version: lock.version,
    roots: lock.roots,
    overrides: lock.overrides,
    nodes: lock.nodes,
    repositories: lock.repositories,
    verification: lock.verification,
  });
  if (lock.fingerprint !== expected) {
    throw new TemplateLockIntegrityError(
      `Template lock fingerprint mismatch: expected ${expected}, observed ${lock.fingerprint}`
    );
  }
  const declaration = assertCanonicalDeclaration(lock);
  const ids = new Set(lock.nodes.map((node) => node.nodeId));
  if (ids.size !== lock.nodes.length)
    throw new TemplateLockIntegrityError("Template lock contains duplicate node ids");
  const positions = new Map(lock.nodes.map((node, index) => [node.nodeId, index]));
  const aliases = new Set<string>();
  const urls = new Set<string>();
  for (const [index, node] of lock.nodes.entries()) {
    if (aliases.has(node.alias))
      throw new TemplateLockIntegrityError(
        `Template lock contains duplicate alias ${JSON.stringify(node.alias)}`
      );
    aliases.add(node.alias);
    for (const section of ["trust", "providers"] as const) {
      const evidence = node.suggestions[section];
      if (
        evidence &&
        evidence.digest !== templateSuggestionDigest(node.nodeId, section, evidence.value)
      ) {
        throw new TemplateLockIntegrityError(
          `Template lock node ${node.nodeId} has invalid ${section} suggestion evidence`
        );
      }
    }
    const normalizedUrl = normalizeTemplateGitUrl(node.pin.url);
    if (urls.has(normalizedUrl)) {
      throw new TemplateLockIntegrityError(
        `Template lock contains more than one exact resolution for ${normalizedUrl}`
      );
    }
    urls.add(normalizedUrl);
    if (canonicalTemplateNodeId(node.pin.url, node.pin.commit) !== node.nodeId) {
      throw new TemplateLockIntegrityError(
        `Template lock node ${node.nodeId} does not match its exact pin`
      );
    }
    if (normalizedUrl !== node.pin.url) {
      throw new TemplateLockIntegrityError(
        `Template lock node ${node.nodeId} does not use a normalized template URL`
      );
    }
    if (node.alias !== templateAliasFromUrl(node.pin.url)) {
      throw new TemplateLockIntegrityError(
        `Template lock node ${node.nodeId} does not use its URL-derived alias`
      );
    }
    for (const parent of node.parents) {
      if (!ids.has(parent) || (positions.get(parent) ?? Infinity) >= index) {
        throw new TemplateLockIntegrityError(
          `Template lock node ${node.nodeId} has invalid parent ${parent}`
        );
      }
    }
  }
  const nodeById = new Map(lock.nodes.map((node) => [node.nodeId, node]));
  const rootIds = new Set<string>();
  for (const root of declaration.roots) {
    const node = lock.nodes.find(
      (candidate) => normalizeTemplateGitUrl(candidate.pin.url) === root.url
    );
    if (!node) {
      throw new TemplateLockIntegrityError(
        `Template lock root ${root.url} is absent from its exact closure`
      );
    }
    if (root.credential !== node.pin.credential) {
      throw new TemplateLockIntegrityError(
        `Template lock root ${root.url} does not use its declared credential`
      );
    }
    rootIds.add(node.nodeId);
  }
  const reachable = new Set<string>();
  const pending = [...rootIds];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const parent of nodeById.get(nodeId)?.parents ?? []) pending.push(parent);
  }
  if (reachable.size !== lock.nodes.length) {
    throw new TemplateLockIntegrityError(
      "Template lock contains nodes outside its declared root closure"
    );
  }
  for (const [url, override] of Object.entries(declaration.overrides)) {
    const node = lock.nodes.find((candidate) => normalizeTemplateGitUrl(candidate.pin.url) === url);
    if (!node || canonicalJson(node.pin) !== canonicalJson(override)) {
      throw new TemplateLockIntegrityError(
        `Template lock override for ${url} is absent from its exact closure`
      );
    }
  }
  for (const [repoPath, repository] of Object.entries(lock.repositories)) {
    normalizeWorkspaceRepoPath(repoPath);
    if (repository.contributions.length === 0) {
      throw new TemplateLockIntegrityError(
        `Template lock repository ${repoPath} has no contributions`
      );
    }
    const contributionIds = repository.contributions.map(({ nodeId }) => nodeId);
    if (new Set(contributionIds).size !== contributionIds.length) {
      throw new TemplateLockIntegrityError(
        `Template lock repository ${repoPath} repeats a contribution`
      );
    }
    for (const nodeId of contributionIds) {
      if (!ids.has(nodeId)) {
        throw new TemplateLockIntegrityError(
          `Template lock repository ${repoPath} names missing node ${nodeId}`
        );
      }
    }
    for (let index = 1; index < contributionIds.length; index += 1) {
      if (
        (positions.get(contributionIds[index - 1]!) ?? Infinity) >=
        (positions.get(contributionIds[index]!) ?? -1)
      ) {
        throw new TemplateLockIntegrityError(
          `Template lock repository ${repoPath} contributions are not in closure order`
        );
      }
    }
  }
  return lock;
}

/** Reject a committed lock whenever the workspace-authored declaration moved. */
export function assertTemplateLockMatchesTopLayer(
  lock: WorkspaceTemplateLock,
  templates: WorkspaceTemplatesConfig | undefined
): WorkspaceTemplateLock {
  const checked = assertTemplateLockIntegrityForRead(lock);
  const declared = normalizeTemplateLockDeclaration(templates);
  if (declared.roots.length === 0) {
    throw new TemplateLockIntegrityError(
      "Template lock is stale because the top layer declares no template roots; remove the template lock"
    );
  }
  if (
    canonicalJson({
      roots: checked.roots,
      overrides: checked.overrides,
    }) !== canonicalJson(declared)
  ) {
    throw new TemplateLockIntegrityError(
      "Template lock does not match the top-layer roots and overrides; regenerate the template lock"
    );
  }
  return checked;
}

export function verifyTemplateFragmentsForRead(
  lock: WorkspaceTemplateLock,
  fragments: ReadonlyMap<string, string>
): void {
  const fragmentPrefix = "meta/templates/";
  const expectedPaths = new Set(lock.nodes.map((node) => `${fragmentPrefix}${node.nodeId}.yml`));
  for (const fragmentPath of fragments.keys()) {
    if (fragmentPath.startsWith(fragmentPrefix) && !expectedPaths.has(fragmentPath)) {
      throw new TemplateLockIntegrityError(`Unexpected template fragment ${fragmentPath}`);
    }
  }
  for (const node of lock.nodes) {
    const content = fragments.get(`meta/templates/${node.nodeId}.yml`);
    if (content === undefined)
      throw new TemplateLockIntegrityError(
        `meta/templates/${node.nodeId}.yml is required by meta/templates.lock.yml`
      );
    const digest = `v1-sha256:${sha256Hex(new TextEncoder().encode(content))}`;
    if (digest !== node.fragmentDigest)
      throw new TemplateLockIntegrityError(
        `Template fragment ${node.nodeId} differs from its lock`
      );
  }
}
