/**
 * Unified runtime-entity model. Replaces the old PrincipalRegistry record shape.
 *
 * Every runtime principal (panel, app, worker, DO, shell, server) has the same identity
 * shape: { source, contextId, key } (+ className for DOs). Identity columns are
 * write-once; lifecycle (status, retiredAt, cleanupComplete, error) is mutable.
 */

import { WORKSPACE_SOURCE_DIRS } from "../workspace/sourceDirs.js";

export type EntityKind = "panel" | "app" | "worker" | "do" | "session" | "shell" | "server";

export interface EntitySource {
  repoPath: string;
  effectiveVersion: string;
}

/**
 * Host-owned binding for a runtime entity that is allowed to relay work for an
 * external agent/session. The host records this at entity creation time and
 * downstream services derive authority from it instead of trusting request args.
 */
export interface RuntimeAgentBinding {
  entityId: string;
  contextId: string;
  channelId: string;
}

export interface RuntimeAgentBindingInput {
  entityId: string;
  channelId: string;
}

export type EntityStatus = "active" | "retired";

/** A workspace-relative repo path (`packages/foo`, `panels/chat`, `meta`). */
export type RepoPath = string;

/** Per-repo context head name (`ctx:{contextId}`) on `vcs:repo:{repoPath}`. */
export function contextHeadName(contextId: string): string {
  return `ctx:${contextId}`;
}

/**
 * A runtime context is a full logical workspace branch. The VCS layer presents
 * the same workspace tree to every context and records per-repo ctx heads lazily
 * as that context edits repos. Repo membership is not part of the runtime
 * context contract; callers inspect changes through VCS status APIs.
 */
export interface WorkspaceContext {
  contextId: string;
}

export function buildWorkspaceContext(contextId: string): WorkspaceContext {
  return { contextId };
}

// Section taxonomy — the SINGLE source of truth for which workspace dirs are
// repos and how (container sections = `section/<name>` is a repo; flat sections
// = the section dir itself is one repo; content sections = container repos with
// no build unit). Lives here in @vibestudio/shared because every layer depends on
// it; `src/server/vcsHost/repoDiscovery.ts` and `workspace/remotes.ts` re-import
// these rather than re-declaring them.

/** Flat sections: the section dir itself is one repo (single-segment repoPath). */
export const FLAT_SECTIONS = new Set<string>(["meta"]);
/** Content-only container sections (no build unit; pushes are ungated). */
export const CONTENT_SECTIONS = new Set<string>(["skills", "templates", "projects"]);
/**
 * Workspace source dirs that are NOT part of the repo taxonomy: present in the
 * source tree but neither a flat repo nor a container of per-name repos.
 */
const NON_REPO_SECTIONS = new Set<string>(["agents"]);
/**
 * Container sections: each immediate subdir `section/<name>` is its own repo.
 * Derived from WORKSPACE_SOURCE_DIRS (the canonical dir list) minus the flat and
 * non-repo sections, so the taxonomy can never drift from the dir list. A new
 * source dir added to WORKSPACE_SOURCE_DIRS becomes a container section by
 * default unless it is explicitly classified as flat or non-repo here.
 */
export const CONTAINER_SECTIONS = new Set<string>(
  WORKSPACE_SOURCE_DIRS.filter((d) => !FLAT_SECTIONS.has(d) && !NON_REPO_SECTIONS.has(d))
);

/** One repo path segment: no separators, no control chars, no whitespace. */
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._@-]+$/;
const MAX_REPO_PATH_LENGTH = 256;

/** Is this section flat (the section dir itself a repo, single-segment path)? */
export function isFlatSection(section: string): boolean {
  return FLAT_SECTIONS.has(section);
}

/**
 * Canonical workspace repo identity. A repo path is either:
 * - `meta`, the only flat repo; or
 * - exactly `section/name`, where `section` is a container section.
 *
 * Source roots such as `packages`, non-repo sections such as `agents/foo`, and
 * deeper paths such as `packages/foo/bar` are workspace paths, not repo ids.
 */
export function normalizeWorkspaceRepoPath(repoPath: string): RepoPath {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("Invalid workspace repo path: empty");
  }
  if (repoPath.length > MAX_REPO_PATH_LENGTH) {
    throw new Error(`Invalid workspace repo path: exceeds ${MAX_REPO_PATH_LENGTH} characters`);
  }
  if (repoPath.includes("\\") || repoPath.includes("\0")) {
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)}`);
  }
  const segments = repoPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || !SAFE_REPO_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)}`);
  }
  if (segments.length === 1) {
    if (FLAT_SECTIONS.has(segments[0]!)) return segments[0]!;
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)} is not a flat repo`);
  }
  if (segments.length === 2) {
    const [section, name] = segments as [string, string];
    if (CONTAINER_SECTIONS.has(section)) return `${section}/${name}`;
  }
  throw new Error(
    `Invalid workspace repo path: ${JSON.stringify(
      repoPath
    )} (expected "meta" or "<container-section>/<name>")`
  );
}

export function isWorkspaceRepoPath(repoPath: string): boolean {
  try {
    normalizeWorkspaceRepoPath(repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The owning repo of a workspace-relative path BY SECTION TAXONOMY (not a fixed
 * list) — used by full workspace contexts where any repo path is editable,
 * including a brand-new repo that has no `main` yet. Returns null for a path
 * that isn't inside any workspace repo.
 */
export function taxonomyRepoForPath(editPath: string): RepoPath | null {
  const segs = editPath.replace(/^\/+/, "").split("/");
  const section = segs[0];
  if (!section) return null;
  if (FLAT_SECTIONS.has(section)) return section;
  if (CONTAINER_SECTIONS.has(section) && segs.length >= 2 && segs[1]) {
    return `${section}/${segs[1]}`;
  }
  return null;
}

/**
 * Split a workspace-relative path into its owning repo (by section taxonomy) and
 * the repo-relative remainder. Returns null when the path is not inside any
 * workspace repo. The single home for the `taxonomyRepoForPath` + prefix-strip
 * pattern that fs edit routing and vcs edit routing both need (callers that also
 * want segment validation wrap the `repoPath` in `normalizeWorkspaceRepoPath`).
 * Input is slash-normalized and leading-slash-stripped first.
 */
export function splitRepoPath(
  wsRelPath: string
): { repoPath: RepoPath; repoRelPath: string } | null {
  const normalized = wsRelPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const repoPath = taxonomyRepoForPath(normalized);
  if (repoPath === null) return null;
  return {
    repoPath,
    repoRelPath: normalized === repoPath ? "" : normalized.slice(repoPath.length + 1),
  };
}

/**
 * Expand a file-looking path that would otherwise collide with a container
 * repo root into one canonical repo + file path.
 *
 * `projects/note.txt` cannot be represented literally because
 * `projects/<name>` is a repo identity. Treating the dotted segment as a file
 * is nevertheless the natural user intent, so every high-level file/VCS
 * surface resolves it to `projects/note/note.txt`. Hidden dotted repo names are
 * left untouched because they are commonly intentional platform/repo ids.
 */
export function canonicalizeWorkspaceFilePath(wsRelPath: string): string {
  const normalized = wsRelPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const split = splitRepoPath(normalized);
  if (!split || split.repoRelPath || split.repoPath.split("/").length !== 2) {
    return normalized;
  }
  const [section, leaf] = split.repoPath.split("/") as [string, string];
  if (leaf.startsWith(".")) return normalized;
  const match = /^(.+)\.([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(leaf);
  if (!match?.[1]) return normalized;
  return `${section}/${match[1]}/${leaf}`;
}

export interface EntityRecord {
  // ── Identity (immutable after first write) ──
  id: string;
  kind: EntityKind;
  source: EntitySource;
  contextId: string;
  className?: string;
  key: string;
  stateArgs?: unknown;
  agentBinding?: RuntimeAgentBinding;
  /**
   * The entity id of the verified caller that created this entity (its launch
   * parent), or undefined for self/bootstrap-created entities. Server-authoritative
   * (set from `ctx.caller` at `runtime.createEntity`). Used to resolve a runtime's
   * nearest panel ancestor — e.g. eval launched by an agent inherits the agent's
   * owning panel as its `parent`.
   */
  parentId?: string;
  /**
   * Owning-user id — the `subject.userId` of the verified caller that created
   * this entity (WP0 §6). Server-authoritative, write-once (stamped onto
   * `entities.owner_user_id` at `entityActivate`). Lets an agent/worker/DO/panel
   * attribute to the human whose subject launched its lineage; because a child
   * entity is created FROM a caller whose subject already carries the inherited
   * userId, the stamp propagates lineage without recursion. Absent for
   * bootstrap-created entities that have no subject (WP0 §5.4).
   */
  ownerUserId?: string;
  createdAt: number;

  // ── Lifecycle (mutable) ──
  status: EntityStatus;
  retiredAt?: number;
  cleanupComplete: boolean;
  error?: string;
}

/**
 * Optional code build selector for runtime entities.
 *
 * `contextId` selects the entity's filesystem/state context. It does not select
 * code provenance. Omit `ref` to launch the workspace's current main build; pass
 * `"ctx:<contextId>"` or `"state:<stateHash>"` only for an intentional targeted
 * branch/state build.
 */
export type RuntimeEntityBuildRef = string;

export type RuntimeEntityCreateSpec =
  | {
      kind: "panel";
      source: string;
      ref?: RuntimeEntityBuildRef;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
    }
  | {
      kind: "app";
      source: string;
      ref?: RuntimeEntityBuildRef;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
    }
  | {
      kind: "worker";
      source: string;
      ref?: RuntimeEntityBuildRef;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
      env?: Record<string, string>;
      agentBinding?: RuntimeAgentBindingInput;
    }
  | {
      kind: "do";
      source: string;
      ref?: RuntimeEntityBuildRef;
      className: string;
      key?: string;
      contextId?: string | null;
      stateArgs?: unknown;
      agentBinding?: RuntimeAgentBindingInput;
    }
  | {
      /** Inert session entity: no workerd/panel runtime, just identity + context. */
      kind: "session";
      source: string;
      contextId?: string | null;
      key?: string;
      title?: string;
    };

export interface RuntimeEntityHandle {
  id: string;
  kind: "panel" | "app" | "worker" | "do" | "session";
  source: EntitySource;
  contextId: string;
  targetId: string;
}

/**
 * Build canonical entity id from identity components.
 * - panel: `panel:<key>` (key is historyEntryKey)
 * - app: `app:<source>:<key>`
 * - worker: `worker:<source>:<key>`
 * - do: `do:<source>:<className>:<key>`
 * - session: `session:<key>`
 */
export function canonicalEntityId(args: {
  kind: EntityKind;
  source?: string;
  className?: string;
  key: string;
}): string {
  switch (args.kind) {
    case "panel":
      return `panel:${args.key}`;
    case "app":
      if (!args.source) throw new Error("app entity requires source");
      return `app:${args.source}:${args.key}`;
    case "worker":
      if (!args.source) throw new Error("worker entity requires source");
      return `worker:${args.source}:${args.key}`;
    case "do":
      if (!args.source) throw new Error("do entity requires source");
      if (!args.className) throw new Error("do entity requires className");
      return `do:${args.source}:${args.className}:${args.key}`;
    case "session":
      return `session:${args.key}`;
    case "shell":
      return `shell:${args.key}`;
    case "server":
      return `server:${args.key}`;
  }
}

export class IdentityCollisionError extends Error {
  readonly code = "IDENTITY_COLLISION" as const;
  constructor(
    readonly id: string,
    readonly conflict: { field: string; existing: unknown; attempted: unknown }
  ) {
    super(
      `Identity collision on ${id}: ${conflict.field} existing=${JSON.stringify(
        conflict.existing
      )} attempted=${JSON.stringify(conflict.attempted)}`
    );
  }
}

export class EntityNotCreatedError extends Error {
  readonly code = "DO_NOT_CREATED" as const;
  constructor(readonly id: string) {
    super(
      `Entity ${id} is not registered as an active runtime entity. Call runtime.createEntity first.`
    );
  }
}
