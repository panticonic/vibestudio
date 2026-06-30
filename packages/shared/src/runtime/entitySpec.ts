/**
 * Unified runtime-entity model. Replaces the old PrincipalRegistry record shape.
 *
 * Every runtime principal (panel, app, worker, DO, shell, server) has the same identity
 * shape: { source, contextId, key } (+ className for DOs). Identity columns are
 * write-once; lifecycle (status, retiredAt, cleanupComplete, error) is mutable.
 */

export type EntityKind = "panel" | "app" | "worker" | "do" | "session" | "shell" | "server";

export interface EntitySource {
  repoPath: string;
  effectiveVersion: string;
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
// no build unit). Lives here in @vibez1/shared because every layer depends on
// it; `src/server/gadVcs/repoDiscovery.ts` and `workspace/remotes.ts` re-import
// these rather than re-declaring them.

/** Container sections: each immediate subdir `section/<name>` is its own repo. */
export const CONTAINER_SECTIONS = new Set([
  "packages",
  "panels",
  "workers",
  "extensions",
  "apps",
  "about",
  "skills",
  "templates",
  "projects",
]);
/** Content-only container sections (no build unit; pushes are ungated). */
export const CONTENT_SECTIONS = new Set(["skills", "templates", "projects"]);
/** Flat sections: the section dir itself is one repo (single-segment repoPath). */
export const FLAT_SECTIONS = new Set(["meta"]);

/** Is this section flat (the section dir itself a repo, single-segment path)? */
export function isFlatSection(section: string): boolean {
  return FLAT_SECTIONS.has(section);
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

export interface EntityRecord {
  // ── Identity (immutable after first write) ──
  id: string;
  kind: EntityKind;
  source: EntitySource;
  contextId: string;
  className?: string;
  key: string;
  stateArgs?: unknown;
  /**
   * The entity id of the verified caller that created this entity (its launch
   * parent), or undefined for self/bootstrap-created entities. Server-authoritative
   * (set from `ctx.caller` at `runtime.createEntity`). Used to resolve a runtime's
   * nearest panel ancestor — e.g. eval launched by an agent inherits the agent's
   * owning panel as its `parent`.
   */
  parentId?: string;
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
    }
  | {
      kind: "do";
      source: string;
      ref?: RuntimeEntityBuildRef;
      className: string;
      key?: string;
      contextId?: string | null;
      stateArgs?: unknown;
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
    readonly conflict: { field: string; existing: unknown; attempted: unknown },
  ) {
    super(
      `Identity collision on ${id}: ${conflict.field} existing=${JSON.stringify(
        conflict.existing,
      )} attempted=${JSON.stringify(conflict.attempted)}`,
    );
  }
}

export class EntityNotCreatedError extends Error {
  readonly code = "DO_NOT_CREATED" as const;
  constructor(readonly id: string) {
    super(
      `Entity ${id} is not registered as an active runtime entity. Call runtime.createEntity first.`,
    );
  }
}
