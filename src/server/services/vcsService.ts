/**
 * vcs service — GAD-native version control RPC surface. External Git interop
 * lives in the dedicated gitInterop service.
 *
 * The caller's working tree is resolved from its context registration:
 * runtime entities operating inside a context commit their `.contexts/{id}`
 * folder onto the `ctx:{id}` head; callers with no context (shell, server)
 * operate on the main workspace head.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  vcsMethods,
  vcsApplyEditsInputSchema,
  type VcsRecallInput,
  type VcsMergeSource,
  type VcsPick,
} from "@vibestudio/shared/serviceSchemas/vcs";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/workspace/remotes";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../vcsHost/paths.js";
import type { MainAdvanceApprovalGate } from "./mainAdvanceApproval.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

export interface VcsServiceDeps {
  workspaceVcs: WorkspaceVcs;
  entityCache?: Pick<EntityCache, "resolveContext">;
  getBuildSystem?: () => BuildSystemV2 | null;
  mainAdvanceGate?: MainAdvanceApprovalGate;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  /**
   * Cross-context READ authorization — the DENY-not-prompt dual of the
   * `context.boundary` gate. Returns the contexts a caller may inspect: the
   * lifecycle children it OWNS and the lineage forks off it, from WS-3's runtime
   * relationship registry (`runtime.listOwnedContexts`). Absent ⇒ no
   * cross-context reads are authorized (own-context reads always are).
   */
  listOwnedContexts?: (input: {
    contextId: string;
  }) => Promise<{ contexts: Array<{ contextId: string }> }>;
}

/** The caller's own context id (extensions resolve through their chained caller). */
function callerContextId(ctx: ServiceContext, deps: VcsServiceDeps): string | null {
  if (ctx.caller.runtime.kind === "agent") {
    if (!ctx.caller.agentBinding) {
      throw new Error("vcs: agent caller has no entity binding");
    }
    return ctx.caller.agentBinding.contextId;
  }
  const contextCallerId =
    ctx.caller.runtime.kind === "extension" && ctx.chainCaller
      ? ctx.chainCaller.callerId
      : ctx.caller.runtime.id;
  return deps.entityCache?.resolveContext(contextCallerId) ?? null;
}

/** Resolve the caller's default head: context callers → their ctx head, else main. */
function headForCaller(ctx: ServiceContext, deps: VcsServiceDeps): string {
  const contextId = callerContextId(ctx, deps);
  return contextId ? vcsContextHead(contextId) : VCS_MAIN_HEAD;
}

/** Shell/server are user-level surfaces; everything else (panel,
 *  app, worker, do, extension) is sandboxed code whose writes are confined
 *  to its own context head. */
function isPrivilegedCaller(ctx: ServiceContext, deps: VcsServiceDeps): boolean {
  return isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability });
}

/**
 * Authorization gate for HEAD WRITES (commit, merge target, abortMerge).
 * Policy:
 *
 * - shell / server: may write any head (user-level surfaces).
 * - entity callers (panel, app, worker, do, extension): may write ONLY their
 *   own `ctx:{id}` head. A caller with no context registration gets an
 *   ERROR, never a silent fallthrough to main — main is user-owned; the
 *   publish path for sandboxed code is a privileged merge of its ctx head.
 */
function resolveWriteHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  requestedHead: string | undefined
): string {
  const callerKind = ctx.caller.runtime.kind;
  if (isPrivilegedCaller(ctx, deps)) return requestedHead ?? headForCaller(ctx, deps);
  const contextId = callerContextId(ctx, deps);
  if (!contextId) {
    throw new Error(
      `vcs head writes require a context: caller ${ctx.caller.runtime.id} (${callerKind}) has no ` +
        `context registration. Writes to ${VCS_MAIN_HEAD} are reserved for shell/server callers.`
    );
  }
  const ownHead = vcsContextHead(contextId);
  if (requestedHead && requestedHead !== ownHead) {
    throw new Error(
      `Callers may only write their own context head (${ownHead}), not ${requestedHead}` +
        (requestedHead === VCS_MAIN_HEAD
          ? ` — publishing to ${VCS_MAIN_HEAD} goes through a shell/server merge`
          : "")
    );
  }
  return ownHead;
}

/**
 * Cross-context READ authorization — the DENY-not-prompt dual of the
 * `context.boundary` PROMPT gate (which is control-plane only). A caller may
 * inspect ONLY its own context, or a context it OWNS (lifecycle child) / FORKED
 * (lineage descendant) per the runtime relationship registry. Unauthorized
 * access THROWS (never prompts): a read is non-mutating and a foreign read has
 * no legitimate consent flow. Own-context and privileged (shell/server)
 * callers short-circuit before touching the registry, so the hot path is free.
 */
async function authorizeContextRead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  targetContextId: string
): Promise<void> {
  if (callerContextId(ctx, deps) === targetContextId) return;
  // Shell/server are user-level surfaces — the user owns every context.
  if (isPrivilegedCaller(ctx, deps)) return;
  const own = callerContextId(ctx, deps);
  if (!own) {
    throw new Error(
      `vcs: caller ${ctx.caller.runtime.id} (${ctx.caller.runtime.kind}) has no context — ` +
        `cross-context inspection of ${targetContextId} is denied`
    );
  }
  const owned = await deps.listOwnedContexts?.({ contextId: own });
  if (owned?.contexts.some((c) => c.contextId === targetContextId)) return;
  throw new Error(
    `vcs: context ${targetContextId} is not owned or forked by ${own} — cross-context inspection denied`
  );
}

/** Authorize a resolved read head: `ctx:*` heads gate through
 *  {@link authorizeContextRead}; `main`/`state:` refs are not context-scoped. */
async function authorizeReadHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  head: string
): Promise<void> {
  if (!head.startsWith("ctx:")) return;
  await authorizeContextRead(ctx, deps, head.slice("ctx:".length));
}

function routeWorkspacePath(filePath: string): { repoPath: string; repoRelPath: string } | null {
  const split = splitRepoPath(filePath);
  if (!split) return null;
  if (!split.repoRelPath) {
    throw new Error(
      `vcs.edit path ${JSON.stringify(filePath)} names a workspace repo root. ` +
        repoRootWriteHint(split.repoPath)
    );
  }
  // Validate the routed repo name (segment safety) — vcs edits gate on `main`,
  // so this is the authoritative boundary check.
  return { repoPath: normalizeWorkspaceRepoPath(split.repoPath), repoRelPath: split.repoRelPath };
}

function pathTrackingHint(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const first = normalized.split("/")[0] ?? "";
  const platform = new Set([
    ".tmp",
    ".vibestudio",
    ".testkit",
    ".git",
    ".gad",
    ".contexts",
    "node_modules",
    "dist",
  ]);
  if (platform.has(first)) {
    return (
      `${JSON.stringify(filePath)} is scratch/platform state and is intentionally outside VCS. ` +
      `VCS commits only workspace source under repo paths like projects/<name>/..., ` +
      `panels/<name>/..., packages/<name>/..., or meta/... . ` +
      `Move or rename the file into a repo path before committing it.`
    );
  }
  return (
    `Use a workspace source path under a repo section such as projects/<name>/..., ` +
    `panels/<name>/..., packages/<name>/..., or meta/... .`
  );
}

function routeWorkspacePathOrThrow(
  kind: string,
  filePath: string
): {
  repoPath: string;
  repoRelPath: string;
} {
  const routed = routeWorkspacePath(filePath);
  if (!routed) {
    throw new Error(
      `${kind} could not infer a repo for ${JSON.stringify(filePath)}. ${pathTrackingHint(filePath)}`
    );
  }
  return routed;
}

function uniqueRepoPaths(repoPaths: string[], owner: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of repoPaths) {
    const repoPath = normalizeWorkspaceRepoPath(raw);
    if (seen.has(repoPath)) duplicates.add(repoPath);
    else {
      seen.add(repoPath);
      out.push(repoPath);
    }
  }
  if (duplicates.size > 0) {
    throw new Error(
      `${owner} received duplicate repo path(s): ${[...duplicates].join(", ")}. ` +
        `Pass each repo once; multi-repo operations already handle groups atomically.`
    );
  }
  return out;
}

function noUncommittedCommitMessage(head: string, repoPaths?: string[]): string {
  const scope = repoPaths && repoPaths.length > 0 ? ` in ${repoPaths.join(", ")}` : "";
  return (
    `vcs.commit refused to no-op: no uncommitted VCS working edits${scope} on ${head}. ` +
    `Only edits recorded through edit/write/vcs.edit are commit-able. Direct fs.writeFile, ` +
    `fs.mktemp, .tmp, .vibestudio, node_modules, dist, and other scratch/platform paths are ` +
    `outside VCS and will not be committed. Record a source edit under a repo path first, ` +
    `or use vcs.status/contextStatus to inspect the current head.`
  );
}

function repoRootWriteHint(repoPath: string): string {
  const segments = repoPath.split("/");
  const leaf = segments.at(-1) ?? repoPath;
  if (segments.length >= 2 && /\.[^/.]+$/.test(leaf)) {
    const repoName = leaf.replace(/\.[^/.]+$/, "");
    const section = segments.slice(0, -1).join("/");
    return `Write a file inside a repo-shaped path instead, e.g. ${section}/${repoName}/${leaf}.`;
  }
  return `Write a file inside the repo instead, e.g. ${repoPath}/README.md.`;
}

function stripRepoPath(filePath: string, repoPath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const repo = normalizeWorkspaceRepoPath(repoPath);
  return normalized === repo
    ? ""
    : normalized.startsWith(`${repo}/`)
      ? normalized.slice(repo.length + 1)
      : normalized;
}

function looksLikeWorkspacePath(value: string): boolean {
  return (
    value === "." ||
    value === "/" ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("/")
  );
}

function resolveReadHeadArg(
  method: "status" | "pendingMerge",
  requested: string | undefined,
  ctx: ServiceContext,
  deps: VcsServiceDeps
): string {
  if (!requested) return headForCaller(ctx, deps);
  if (looksLikeWorkspacePath(requested)) {
    throw new Error(
      `vcs.${method} expects an optional materialized VCS head, not a filesystem path (${JSON.stringify(requested)}). ` +
        `Omit the argument for the current context head. Use vcs.resolveHead(ref) for arbitrary refs.`
    );
  }
  if (requested !== VCS_MAIN_HEAD && !requested.startsWith("ctx:")) {
    throw new Error(
      `vcs.${method} expects an optional materialized VCS head ("main" or "ctx:..."), not ${JSON.stringify(requested)}. ` +
        `Omit the argument for the current context head. Use vcs.resolveHead(ref) for arbitrary refs or vcs.diff(leftStateHash, rightStateHash) for state comparisons.`
    );
  }
  return requested;
}

function assertStateHashArg(method: string, value: string, position: string): void {
  if (!value.startsWith("state:")) {
    throw new Error(
      `vcs.${method} expects ${position} to be a GAD state hash such as "state:...", not ${JSON.stringify(value)}. ` +
        `Use vcs.resolveHead(head).stateHash or the stateHash returned by vcs.edit before diffing.`
    );
  }
}

export function createVcsService(deps: VcsServiceDeps): ServiceDefinition {
  return {
    name: "vcs",
    description:
      "Workspace version control (GAD-native): commit, status, log, diff. Publishing is not a public host vcs.push RPC; use vibestudio vcs push / runtime VcsClient.push, which dispatch userland to the gad-store DO's vcsPush.",
    policy: {
      allowed: ["shell", "panel", "app", "server", "worker", "do", "extension", "agent"],
    },
    methods: vcsMethods,
    handler: async (ctx, method, args) => {
      const vcs = deps.workspaceVcs;
      const actor = { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind };
      switch (method) {
        case "edit": {
          // Working edit — tracked, NOT a commit. Actor is the verified caller.
          // Per-repo: edits route by path to their owning repo's ctx head.
          const input = vcsApplyEditsInputSchema.parse(args[0]);
          if (input.edits.length === 0) {
            throw new Error(
              "vcs.edit requires at least one edit op. An empty edit batch would be a no-op; " +
                "check the path or replacement text before calling vcs.edit."
            );
          }
          const head = resolveWriteHead(ctx, deps, input.head);
          const repoPath = input.repoPath ? normalizeWorkspaceRepoPath(input.repoPath) : undefined;
          const groups = new Map<string, typeof input.edits>();
          if (repoPath) {
            groups.set(repoPath, input.edits);
          } else {
            for (const edit of input.edits) {
              const routed = routeWorkspacePathOrThrow("vcs.edit", edit.path);
              const list = groups.get(routed.repoPath) ?? [];
              list.push({ ...edit, path: routed.repoRelPath } as (typeof input.edits)[number]);
              groups.set(routed.repoPath, list);
            }
          }
          if (groups.size > 1 && input.baseStateHash !== undefined) {
            throw new Error(
              "vcs.edit cannot enforce baseStateHash across multiple repos; " +
                "split the edit by repo or omit baseStateHash"
            );
          }
          const results: Awaited<ReturnType<typeof vcs.recordEdit>>[] = [];
          for (const [editRepoPath, repoEdits] of groups) {
            results.push(
              await vcs.recordEdit({
                head,
                edits: repoEdits,
                actor,
                repoPath: editRepoPath,
                ...(groups.size === 1 && input.baseStateHash
                  ? { baseStateHash: input.baseStateHash }
                  : {}),
                // Provenance edge into the agentic trajectory (self-asserted by
                // the calling agent runtime; the edit tool passes its toolCallId).
                ...(input.invocationId ? { invocationId: input.invocationId } : {}),
              })
            );
          }
          if (results.length === 1) {
            const [result] = results;
            if (!result) {
              throw new Error("vcs.edit failed internally: expected one edit result, found none");
            }
            return result;
          }
          // Aggregate a multi-repo edit into one working result.
          return {
            head,
            stateHash: head.startsWith("ctx:")
              ? await vcs.resolveContextView(head.slice("ctx:".length))
              : (await vcs.workspaceView()).stateHash,
            committed: false as const,
            status: "uncommitted" as const,
            editSeq: results.reduce((m, r) => Math.max(m, r.editSeq), 0),
            changedPaths: results.flatMap((r) => r.changedPaths),
          };
        }
        case "commit": {
          const [input] = args as [import("@vibestudio/shared/serviceSchemas/vcs").VcsCommitInput];
          if (!input.message || !input.message.trim()) {
            throw new Error("vcs.commit requires a message");
          }
          const head = resolveWriteHead(ctx, deps, input.head);
          if (head === VCS_MAIN_HEAD) {
            throw new Error("vcs.commit: main advances only via push; commit a ctx:* head");
          }
          const contextId = head.startsWith("ctx:") ? head.slice("ctx:".length) : null;
          if (!contextId) {
            throw new Error(`vcs.commit targets a ctx:* head, not ${head}`);
          }
          const contextRows = await vcs.contextStatus(contextId);
          const uncommittedRepos = new Set(
            contextRows.filter((r) => r.uncommitted).map((r) => r.repoPath)
          );
          // Repos to commit: explicit, else every repo with uncommitted edits.
          let repoPaths: string[];
          if (input.repoPaths && input.repoPaths.length > 0) {
            repoPaths = uniqueRepoPaths(input.repoPaths, "vcs.commit");
            const clean = repoPaths.filter((repoPath) => !uncommittedRepos.has(repoPath));
            if (clean.length > 0) {
              throw new Error(noUncommittedCommitMessage(head, clean));
            }
          } else {
            repoPaths = [...uncommittedRepos].sort();
            if (repoPaths.length === 0) {
              throw new Error(noUncommittedCommitMessage(head));
            }
          }
          // Exclude paths route to their repo (repo-relative) for filtering.
          const excludeByRepo = new Map<string, string[]>();
          const targetRepos = new Set(repoPaths);
          for (const p of input.exclude ?? []) {
            const routed = routeWorkspacePathOrThrow("vcs.commit exclude", p);
            if (!targetRepos.has(routed.repoPath)) {
              throw new Error(
                `vcs.commit exclude path ${JSON.stringify(p)} belongs to ${routed.repoPath}, ` +
                  `but this commit targets ${repoPaths.join(", ")}. ` +
                  `Either include that repo in repoPaths or remove the exclude.`
              );
            }
            const list = excludeByRepo.get(routed.repoPath) ?? [];
            list.push(routed.repoRelPath);
            excludeByRepo.set(routed.repoPath, list);
          }
          const out = [];
          for (const repoPath of repoPaths) {
            const exclude = excludeByRepo.get(repoPath);
            const result = await vcs.commit({
              head,
              repoPath,
              message: input.message,
              actor,
              ...(exclude ? { exclude } : {}),
              // A2/T1: self-asserted sealing tool-call id, recorded on the commit event.
              ...(input.invocationId ? { invocationId: input.invocationId } : {}),
            });
            if (result.status === "unchanged") {
              throw new Error(
                `vcs.commit refused to report a no-op success for ${repoPath}: no included edits ` +
                  `were committed. Check exclude paths; excluding every working edit leaves ` +
                  `nothing to seal.`
              );
            }
            out.push({ repoPath: normalizeWorkspaceRepoPath(repoPath), ...result });
          }
          return out;
        }
        case "discardEdits": {
          const [repoArg, headArg] = args as [string, string | undefined];
          const head = resolveWriteHead(ctx, deps, headArg);
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return await vcs.discardEdits({ head, repoPath });
        }
        // History/read traversals (commitEdits, fileHistory, commitAncestors,
        // editsByActor/Turn/Invocation, log) are USERLAND-dispatched since
        // P5c: consumers resolve the `vcs` manifest service (workers.
        // resolveService → gad-store DO) and call its `vcs*` read methods.
        case "previewBuild": {
          const [input] = args as [{ repoPaths?: string[]; units?: string[]; head?: string }];
          const head = input.head
            ? resolveWriteHead(ctx, deps, input.head)
            : headForCaller(ctx, deps);
          return await vcs.previewBuild({
            head,
            ...(input.repoPaths
              ? { repoPaths: input.repoPaths.map((r) => normalizeWorkspaceRepoPath(r)) }
              : {}),
            ...(input.units ? { units: input.units } : {}),
            getBuildSystem: () => deps.getBuildSystem?.() ?? null,
          });
        }
        case "readFile": {
          const [ref, filePath, repoArg, scope] = args as [
            string,
            string,
            string | undefined,
            { contextId: string } | undefined,
          ];
          const resolvedRef =
            ref || (scope ? vcsContextHead(scope.contextId) : headForCaller(ctx, deps));
          await authorizeReadHead(ctx, deps, resolvedRef);
          if (repoArg) {
            const repoPath = normalizeWorkspaceRepoPath(repoArg);
            const repoRelPath = stripRepoPath(filePath, repoPath);
            if (resolvedRef.startsWith("ctx:")) {
              const stateHash = await vcs.contextRepoState(
                resolvedRef.slice("ctx:".length),
                repoPath
              );
              return stateHash ? await vcs.readFile(stateHash, repoRelPath) : null;
            }
            return await vcs.readFile(resolvedRef, repoRelPath, repoPath);
          }
          const routed = routeWorkspacePath(filePath);
          if (routed && resolvedRef.startsWith("ctx:")) {
            const stateHash = await vcs.contextRepoState(
              resolvedRef.slice("ctx:".length),
              routed.repoPath
            );
            return stateHash ? await vcs.readFile(stateHash, routed.repoRelPath) : null;
          }
          if (routed && !resolvedRef.startsWith("state:")) {
            return await vcs.readFile(resolvedRef, routed.repoRelPath, routed.repoPath);
          }
          const stateRef = resolvedRef.startsWith("ctx:")
            ? await vcs.resolveContextView(resolvedRef.slice("ctx:".length))
            : resolvedRef === VCS_MAIN_HEAD
              ? (await vcs.workspaceView()).stateHash
              : resolvedRef;
          return await vcs.readFile(stateRef, filePath);
        }
        case "listFiles": {
          const [ref, repoArg, scope] = args as [
            string | undefined,
            string | undefined,
            { contextId: string } | undefined,
          ];
          const resolvedRef =
            ref || (scope ? vcsContextHead(scope.contextId) : headForCaller(ctx, deps));
          await authorizeReadHead(ctx, deps, resolvedRef);
          if (repoArg) {
            const repoPath = normalizeWorkspaceRepoPath(repoArg);
            if (resolvedRef.startsWith("ctx:")) {
              const stateHash = await vcs.contextRepoState(
                resolvedRef.slice("ctx:".length),
                repoPath
              );
              return stateHash ? await vcs.listFiles(stateHash) : [];
            }
            return await vcs.listFiles(resolvedRef, repoPath);
          }
          const stateRef = resolvedRef.startsWith("ctx:")
            ? await vcs.resolveContextView(resolvedRef.slice("ctx:".length))
            : resolvedRef === VCS_MAIN_HEAD
              ? (await vcs.workspaceView()).stateHash
              : resolvedRef;
          return await vcs.listFiles(stateRef);
        }
        case "revert": {
          // A revert lands as a WORKING edit (inverse patch) — no commit, no
          // build; the caller commits it later. Rejects a `main` head.
          const [target] = args as [
            { stateHash?: string; eventId?: string; head?: string; repoPath: string },
          ];
          const head = resolveWriteHead(ctx, deps, target.head);
          const repoPath = normalizeWorkspaceRepoPath(target.repoPath);
          return await vcs.revert({
            head,
            target: { stateHash: target.stateHash, eventId: target.eventId },
            actor,
            repoPath,
          });
        }
        case "status": {
          const [repoArg, headArg, scope] = args as [
            string,
            string | undefined,
            { contextId: string } | undefined,
          ];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = scope
            ? vcsContextHead(scope.contextId)
            : resolveReadHeadArg("status", headArg, ctx, deps);
          await authorizeReadHead(ctx, deps, head);
          return await vcs.statusHead(head, repoPath);
        }
        case "diff": {
          const [left, right] = args as [string, string];
          assertStateHashArg("diff", left, "left");
          assertStateHashArg("diff", right, "right");
          // Content-store Merkle diff (diffTrees) — the gad DO is not consulted.
          return await vcs.diffStates(left, right);
        }
        case "resolveHead": {
          const [requested, repoArg] = args as [string | undefined, string];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = requested ?? headForCaller(ctx, deps);
          await authorizeReadHead(ctx, deps, head);
          return { head, stateHash: await vcs.resolveHead(head, repoPath) };
        }
        case "workspaceViewWithRepoAt": {
          const [repoArg, stateHash] = args as [string, string | null];
          if (stateHash !== null)
            assertStateHashArg("workspaceViewWithRepoAt", stateHash, "stateHash");
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return { stateHash: await vcs.workspaceViewWithRepoAt(repoPath, stateHash) };
        }
        case "merge": {
          // Explicit reconcile: pull a SOURCE (`main`, or a context the caller
          // owns/forked) into the caller's context head, one merge commit per
          // repo. The merge ENGINE is source-generic in the gad-store DO
          // (`vcsMerge`), which owns the commit-gate on BOTH sides; this host
          // side resolves the source head, loops repos, and surfaces the DO's
          // source-side dirty-gate error verbatim.
          const [input] = args as [{ source: VcsMergeSource; repoPaths?: string[]; head?: string }];
          const targetHead = resolveWriteHead(ctx, deps, input.head);
          if (targetHead === VCS_MAIN_HEAD) {
            throw new Error(
              "vcs.merge targets a ctx:* head (pulls a source into it); main advances via push"
            );
          }
          let sourceHead: string;
          // The context whose touched repos default the merge scope: a `main`
          // merge reconciles the TARGET's own diverged repos; a context merge
          // takes the SOURCE context's touched repos (e.g. a subagent's work).
          let defaultScopeContextId: string;
          if (!input.source || input.source === "main") {
            // Pull-main (explicit `"main"` or omitted): reconcile the TARGET's
            // own diverged repos. No source context to read.
            sourceHead = VCS_MAIN_HEAD;
            defaultScopeContextId = targetHead.slice("ctx:".length);
          } else {
            // Merging another context's committed head IN reads that context.
            await authorizeContextRead(ctx, deps, input.source.contextId);
            sourceHead = vcsContextHead(input.source.contextId);
            defaultScopeContextId = input.source.contextId;
          }
          const repoPaths =
            input.repoPaths && input.repoPaths.length > 0
              ? uniqueRepoPaths(input.repoPaths, "vcs.merge")
              : (await vcs.contextStatus(defaultScopeContextId)).map((r) => r.repoPath);
          if (repoPaths.length === 0) {
            throw new Error(
              `vcs.merge refused to no-op: no repos were selected for reconciliation. ` +
                `Pass repoPaths explicitly, or use vcs.contextStatus to confirm the source/target context has repos to merge.`
            );
          }
          const out = [];
          for (const repoPath of repoPaths) {
            const result = await vcs.mergeHeads(targetHead, sourceHead, { actor, repoPath });
            out.push({ repoPath, ...result });
          }
          return out;
        }
        case "pick": {
          // Cherry-pick selected changes from a SOURCE onto the caller's context
          // head as UNCOMMITTED working edits (never a head advance). Commit
          // picks 3-way-apply a commit's patch (routed per pick's repoPath);
          // path picks inject the source context's working content (routed to
          // the paths' owning repos). Each lands via the DO `vcsPick`.
          const [input] = args as [{ source: VcsMergeSource; picks: VcsPick[]; head?: string }];
          const targetHead = resolveWriteHead(ctx, deps, input.head);
          if (targetHead === VCS_MAIN_HEAD) {
            throw new Error("vcs.pick targets a ctx:* head; main advances via push");
          }
          let sourceContextId: string | null = null;
          if (input.source && input.source !== "main") {
            await authorizeContextRead(ctx, deps, input.source.contextId);
            sourceContextId = input.source.contextId;
          }
          if (!input.picks || input.picks.length === 0) {
            throw new Error(
              "vcs.pick requires at least one pick. An empty pick list would be a no-op."
            );
          }
          const results = [];
          for (const p of input.picks) {
            if (p.kind === "commit") {
              results.push(
                await vcs.pick({
                  head: targetHead,
                  repoPath: normalizeWorkspaceRepoPath(p.repoPath),
                  actor,
                  pick: { kind: "commit", eventId: p.eventId },
                })
              );
              continue;
            }
            if (!sourceContextId) {
              throw new Error(
                "vcs.pick: a `paths` pick requires source:{contextId} — there is no working " +
                  "content to inject from main"
              );
            }
            // Route paths to their owning repos (path picks are per-repo in the DO).
            const byRepo = new Map<string, string[]>();
            if (p.paths.length === 0) {
              throw new Error(
                "vcs.pick paths requires at least one path. An empty path list would be a no-op."
              );
            }
            for (const path of p.paths) {
              const routed = routeWorkspacePathOrThrow("vcs.pick", path);
              const list = byRepo.get(routed.repoPath) ?? [];
              list.push(routed.repoRelPath);
              byRepo.set(routed.repoPath, list);
            }
            for (const [repoPath, repoRelPaths] of byRepo) {
              results.push(
                await vcs.pick({
                  head: targetHead,
                  repoPath,
                  actor,
                  pick: { kind: "paths", sourceContextId, paths: repoRelPaths },
                })
              );
            }
          }
          return results;
        }
        case "contextDiff": {
          // A convenience projection: diff a context you own/forked against its
          // fork-base (default) or main. Read-authorized like the cross-context
          // reads; NOT a head write.
          const [input] = args as [{ contextId: string; against?: "fork-base" | "main" }];
          await authorizeContextRead(ctx, deps, input.contextId);
          return await vcs.contextDiff(input.contextId, input.against ?? "fork-base");
        }
        case "abortMerge": {
          const [repoArg, headArg] = args as [string | undefined, string | undefined];
          const targetHead = resolveWriteHead(ctx, deps, headArg);
          const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
          if (!repoPath) {
            throw new Error("vcs.abortMerge requires repoPath in the per-repo VCS model");
          }
          // Aborting a pending merge restores the pre-merge tree; it never
          // advances a head ref, so no main-advance gate applies (even on main).
          return await vcs.abortMerge(targetHead, { actor, repoPath });
        }
        case "pendingMerge": {
          const [repoArg, headArg, scope] = args as [
            string | undefined,
            string | undefined,
            { contextId: string } | undefined,
          ];
          const targetHead = scope
            ? vcsContextHead(scope.contextId)
            : resolveReadHeadArg("pendingMerge", headArg, ctx, deps);
          await authorizeReadHead(ctx, deps, targetHead);
          const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
          if (!repoPath) {
            throw new Error("vcs.pendingMerge requires repoPath in the per-repo VCS model");
          }
          return await vcs.pendingMerge(targetHead, repoPath);
        }
        case "pushStatus": {
          const [repoArgs] = args as [string[]];
          const repoPaths = repoArgs.map((r) => normalizeWorkspaceRepoPath(r));
          const head = headForCaller(ctx, deps);
          return await Promise.all(repoPaths.map((repoPath) => vcs.pushStatus(repoPath, head)));
        }
        case "recall": {
          const [input] = args as [VcsRecallInput];
          return await vcs.recallMemory(input);
        }
        // forkRepo / deleteRepo / restoreRepo are no longer host-serviced:
        // Phase 4 moved the sagas into the gad-store DO (`vcsForkRepo` /
        // `vcsDeleteRepo` / `vcsRestoreRepo`) and userland routes to them
        // DIRECTLY (like `vcs.push` → `vcsPush`) so the relay mints the
        // on-behalf-of token attributing the severe prompt to the originating
        // caller (D3). A host forward would erase that attribution.
        case "contextStatus": {
          const [scope] = args as [{ contextId: string } | undefined];
          if (scope) {
            await authorizeContextRead(ctx, deps, scope.contextId);
            return await vcs.contextStatus(scope.contextId);
          }
          const contextId = callerContextId(ctx, deps);
          if (!contextId) throw new Error("vcs.contextStatus requires an active context");
          return await vcs.contextStatus(contextId);
        }
        case "rebaseContext": {
          const contextId = callerContextId(ctx, deps);
          if (!contextId) throw new Error("vcs.rebaseContext requires an active context");
          return await vcs.rebaseContext(contextId, actor);
        }
        default:
          throw new Error(`Unknown vcs method: ${method}`);
      }
    },
  };
}
