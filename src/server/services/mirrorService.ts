/**
 * mirror service — the read-side of the context projector over the wire.
 * It exposes two pure reads:
 *
 *   targets({ contextId })  → [{ repoPath, stateHash }]   (WorkspaceVcs.contextRepoTargets)
 *   objects({ stateHash })  → size-bounded pages of CAS tree content
 *
 * so a remote CLI (`vibestudio context mirror`) can materialize a context's
 * repos into a local working tree without a server-side context folder. It
 * holds no write/merge semantics — local edits ride the existing `vcs.edit`
 * writeback and inbound updates re-fetch by state hash.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { mirrorMethods, MIRROR_POLICY } from "@vibestudio/service-schemas/mirror";

export interface MirrorServiceDeps {
  /** Per-repo content-addressed targets for a context (no disk projection). */
  contextRepoTargets(contextId: string): Promise<Array<{ repoPath: string; stateHash: string }>>;
  /** The CAS file list for a state (mirrors the tree in first if needed). */
  listStateFiles(
    stateHash: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>>;
  /** Read a blob's raw bytes by content hash (null when absent). */
  readBlob(contentHash: string): Promise<Buffer | null>;
}

/** Page ceilings — keep a single `objects` response well under RPC envelope
 *  limits. Bytes are measured pre-base64; a page also stops after MAX_FILES. */
const MAX_PAGE_BYTES = 3_000_000;
const MAX_PAGE_FILES = 500;

export function createMirrorService(deps: MirrorServiceDeps): ServiceDefinition {
  const authorizedAgentStates = new Map<string, string>();

  function contextIdForTargets(ctx: ServiceContext, requestedContextId: string): string {
    if (ctx.caller.runtime.kind !== "agent") return requestedContextId;
    const binding = ctx.caller.agentBinding;
    if (!binding) {
      throw new Error("mirror: agent caller has no entity binding");
    }
    if (requestedContextId !== binding.contextId) {
      throw new Error("mirror.targets contextId must match the connection's entity binding");
    }
    return binding.contextId;
  }

  function authorizeObjects(ctx: ServiceContext, stateHash: string): void {
    if (ctx.caller.runtime.kind !== "agent") return;
    const binding = ctx.caller.agentBinding;
    if (!binding) {
      throw new Error("mirror: agent caller has no entity binding");
    }
    if (authorizedAgentStates.get(stateHash) !== binding.contextId) {
      throw new Error("mirror.objects stateHash is not authorized for this agent context");
    }
  }

  return {
    name: "mirror",
    description:
      "Read-side of the context projector: `targets` returns a context's per-repo content-addressed states, `objects` streams the CAS tree content for a state in size-bounded pages. Powers `vibestudio context mirror`.",
    authority: MIRROR_POLICY,
    methods: mirrorMethods,
    handler: defineServiceHandler("mirror", mirrorMethods, {
      targets: async (ctx, [{ contextId }]) => {
        const scopedContextId = contextIdForTargets(ctx, contextId);
        const targets = await deps.contextRepoTargets(scopedContextId);
        if (ctx.caller.runtime.kind === "agent") {
          for (const target of targets) {
            authorizedAgentStates.set(target.stateHash, scopedContextId);
          }
        }
        return targets;
      },
      objects: async (ctx, [input]) => {
        authorizeObjects(ctx, input.stateHash);
        let files = await deps.listStateFiles(input.stateHash);
        files.sort((a, b) => a.path.localeCompare(b.path));
        if (input.paths && input.paths.length > 0) {
          const want = new Set(input.paths);
          files = files.filter((f) => want.has(f.path));
        }
        const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
        const from = Number.isFinite(start) && start >= 0 ? start : 0;

        const page: Array<{ path: string; mode: number; content: string; size: number }> = [];
        let bytes = 0;
        let index = from;
        for (; index < files.length; index++) {
          const file = files[index];
          if (!file) {
            throw new Error(`mirror.objects file index ${index} is unexpectedly absent`);
          }
          // Always include at least one file per page so a single oversized
          // file still transfers (as its own page).
          if (page.length > 0 && bytes >= MAX_PAGE_BYTES) break;
          if (page.length >= MAX_PAGE_FILES) break;
          const buf = await deps.readBlob(file.contentHash);
          if (!buf) {
            throw new Error(
              `mirror.objects missing blob ${file.contentHash} for ${file.path} in state ${input.stateHash}`
            );
          }
          page.push({
            path: file.path,
            mode: file.mode,
            content: buf.toString("base64"),
            size: buf.length,
          });
          bytes += buf.length;
        }
        const next = index < files.length ? String(index) : undefined;
        return { files: page, ...(next ? { next } : {}) };
      },
    }),
  };
}
