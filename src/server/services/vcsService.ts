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
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { vcsMethods, type VcsEditOp } from "@vibestudio/service-schemas/vcs";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../vcsHost/paths.js";
import type { MainAdvanceApprovalGate } from "./mainAdvanceApproval.js";

export interface VcsServiceDeps {
  workspaceVcs: WorkspaceVcs;
  entityCache?: Pick<EntityCache, "resolveContext">;
  /** Live workspace policy for resolving bare tracked paths. */
  getDefaultRepo?: () => string | undefined;
  getBuildSystem?: () => BuildSystemV2 | null;
  mainAdvanceGate?: MainAdvanceApprovalGate;
  /**
   * Cross-context READ authorization — the DENY-not-prompt dual of the
   * `context.boundary` gate. Returns the contexts a caller may inspect: the
   * lifecycle children it OWNS and the lineage forks off it, from WS-3's runtime
   * relationship registry (`runtime.listOwnedContexts`). Absent ⇒ no
   * cross-context reads are authorized (own-context reads always are).
   */
  listOwnedContexts?: (input: {
    contextId: string;
  }) => Promise<{ contexts: Array<{ contextId: string; ownerEntityId?: string | null }> }>;
}

type ContextReadScope = { contextId: string; ownerContextId?: string };

function contextCallerId(ctx: ServiceContext): string {
  return ctx.caller.runtime.kind === "extension" && ctx.chainCaller
    ? ctx.chainCaller.callerId
    : ctx.caller.runtime.id;
}

/** The caller's own context id (extensions resolve through their chained caller). */
function callerContextId(ctx: ServiceContext, deps: VcsServiceDeps): string | null {
  // Agent callers carry a host-verified entity binding — their context comes
  // from the credential, never from an entity-cache lookup.
  if (ctx.caller.runtime.kind === "agent") {
    if (!ctx.caller.agentBinding) {
      throw new Error("vcs: agent caller has no entity binding");
    }
    return ctx.caller.agentBinding.contextId;
  }
  return deps.entityCache?.resolveContext(contextCallerId(ctx)) ?? null;
}

/** Resolve the caller's default head: context callers → their ctx head, else main. */
function headForCaller(ctx: ServiceContext, deps: VcsServiceDeps): string {
  const contextId = callerContextId(ctx, deps);
  return contextId ? vcsContextHead(contextId) : VCS_MAIN_HEAD;
}

/** Shell/server are user-level surfaces; everything else (panel,
 *  app, worker, do, extension) is sandboxed code whose writes are confined
 *  to its own context head. */
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
async function resolveWriteHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  requestedHead: string | undefined
): Promise<string> {
  const callerKind = ctx.caller.runtime.kind;
  if (await hasPanelHostingAuthority(ctx)) return requestedHead ?? headForCaller(ctx, deps);
  // Via callerContextId so agent callers (credential-bound context) can write
  // their own ctx head like any other sandboxed caller.
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
  targetContextId: string,
  ownerContextId?: string
): Promise<void> {
  if (callerContextId(ctx, deps) === targetContextId) return;
  // Shell/server are user-level surfaces — the user owns every context.
  if (await hasPanelHostingAuthority(ctx)) return;
  if (ownerContextId) {
    const ownedByHint = await deps.listOwnedContexts?.({ contextId: ownerContextId });
    const edge = ownedByHint?.contexts.find((c) => c.contextId === targetContextId);
    if (edge?.ownerEntityId && edge.ownerEntityId === ctx.caller.runtime.id) return;
  }
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

async function authorizeScopedReadHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  head: string,
  scope?: ContextReadScope
): Promise<void> {
  if (scope && head === vcsContextHead(scope.contextId)) {
    await authorizeContextRead(ctx, deps, scope.contextId, scope.ownerContextId);
    return;
  }
  await authorizeReadHead(ctx, deps, head);
}

function routeWorkspacePath(
  filePath: string,
  operation = "vcs",
  defaultRepo?: string
): { repoPath: string; repoRelPath: string } | null {
  const normalized = canonicalizeWorkspaceFilePath(filePath);
  if (normalized && !normalized.includes("/")) {
    return defaultRepo
      ? { repoPath: normalizeWorkspaceRepoPath(defaultRepo), repoRelPath: normalized }
      : null;
  }
  const split = splitRepoPath(normalized);
  if (!split) return null;
  if (!split.repoRelPath) {
    throw new Error(
      `${operation} path ${JSON.stringify(filePath)} names a workspace repo root. ` +
        repoRootWriteHint(split.repoPath)
    );
  }
  // Validate the routed repo name (segment safety) — vcs edits gate on `main`,
  // so this is the authoritative boundary check.
  return { repoPath: normalizeWorkspaceRepoPath(split.repoPath), repoRelPath: split.repoRelPath };
}

function pathTrackingHint(filePath: string, defaultRepo?: string): string {
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
  if (!filePath.replace(/\\/g, "/").replace(/^\/+/, "").includes("/")) {
    return defaultRepo
      ? `The workspace default repo is ${defaultRepo}; pass a non-empty relative file path.`
      : `This workspace does not declare defaultRepo in meta/vibestudio.yml. Use a full workspace path such as projects/<name>/<file>, or declare a default repo for bare tracked paths.`;
  }
  return (
    `Use a workspace source path ` +
    `under a repo section such as projects/<name>/..., ` +
    `panels/<name>/..., packages/<name>/..., or meta/... .`
  );
}

function routeWorkspacePathOrThrow(
  kind: string,
  filePath: string,
  defaultRepo?: string
): {
  repoPath: string;
  repoRelPath: string;
} {
  const routed = routeWorkspacePath(filePath, kind, defaultRepo);
  if (!routed) {
    throw new Error(
      `${kind} could not infer a repo for ${JSON.stringify(filePath)}. ${pathTrackingHint(filePath, defaultRepo)}`
    );
  }
  return routed;
}

function defaultRepo(deps: VcsServiceDeps): string | undefined {
  const value = deps.getDefaultRepo?.();
  return value ? normalizeWorkspaceRepoPath(value) : undefined;
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
    `vcs.commit refused to no-op: no uncommitted VCS working edits (and no pending merge to ` +
    `seal)${scope} on ${head}. ` +
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
  method: "status" | "pendingMerge" | "diffContent",
  requested: string | undefined,
  ctx: ServiceContext,
  deps: VcsServiceDeps
): string {
  if (!requested) return headForCaller(ctx, deps);
  // Head prefixes FIRST: context ids may legitimately contain slashes
  // (historical panel ids), so `ctx:panels/foo` must never be mistaken for a
  // filesystem path by the slash heuristic below.
  if (requested === VCS_MAIN_HEAD || requested.startsWith("ctx:")) return requested;
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
  const vcs = deps.workspaceVcs;
  const actorFor = (ctx: ServiceContext) => ({
    id: ctx.caller.runtime.id,
    kind: ctx.caller.runtime.kind,
    ...(ctx.caller.subject?.userId ? { subject: { userId: ctx.caller.subject.userId } } : {}),
  });

  return {
    name: "vcs",
    description:
      "Workspace version control (GAD-native): commit, status, log, diff. Publishing is not a public host vcs.push RPC; use vibestudio vcs push / runtime VcsClient.push, which dispatch userland to the gad-store DO's vcsPush.",
    authority: {
      principals: ["user", "code", "host", "entity"],
    },
    methods: vcsMethods,
    handler: defineServiceHandler("vcs", vcsMethods, {
      edit: async (ctx, [input]) => {
        // Provenance actor: the verified runtime principal PLUS the host-verified
        // account subject (WP0 §3.4) when present — edits/commits attribute to the
        // human, not just the device/panel that carried them.
        const actor = actorFor(ctx);
        // Working edit — tracked, NOT a commit. Actor is the verified caller.
        // Per-repo: edits route by path to their owning repo's ctx head.
        if (input.edits.length === 0) {
          throw new Error(
            "vcs.edit requires at least one edit op. An empty edit batch would be a no-op; " +
              "check the path or replacement text before calling vcs.edit."
          );
        }
        const head = await resolveWriteHead(ctx, deps, input.head);
        const repoPath = input.repoPath ? normalizeWorkspaceRepoPath(input.repoPath) : undefined;
        const groups = new Map<string, typeof input.edits>();
        if (repoPath) {
          groups.set(repoPath, input.edits);
        } else {
          for (const edit of input.edits) {
            const routed = routeWorkspacePathOrThrow("vcs.edit", edit.path, defaultRepo(deps));
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
        const repoOrder = [...groups.keys()];
        const results: Awaited<ReturnType<typeof vcs.recordEdit>>[] = [];
        for (const [editRepoPath, repoEdits] of groups) {
          // A ctx head is created lazily per repo. Resolve its composed
          // WORKING state before edit preflight instead of reading the raw
          // per-repo head: a brand-new repo correctly resolves to null, and
          // an idempotent retry observes prior uncommitted edits.
          let currentStateRef: string | null | undefined;
          const readCurrentFile = async (filePath: string) => {
            if (currentStateRef === undefined) {
              currentStateRef =
                input.baseStateHash ??
                (head.startsWith("ctx:")
                  ? await vcs.contextRepoState(head.slice("ctx:".length), editRepoPath)
                  : head);
            }
            return currentStateRef
              ? await vcs.readFile(currentStateRef, filePath, editRepoPath)
              : null;
          };
          const expandedEdits: Array<Exclude<VcsEditOp, { kind: "replaceText" }>> = [];
          for (const edit of repoEdits) {
            if (edit.kind === "create") {
              const current = await readCurrentFile(edit.path);
              const sameContent =
                current?.content.kind === edit.content.kind &&
                (edit.content.kind === "text"
                  ? current.content.kind === "text" && current.content.text === edit.content.text
                  : current?.content.kind === "bytes" &&
                    current.content.base64 === edit.content.base64);
              const sameMode =
                current !== null && (edit.mode === undefined || edit.mode === current.mode);
              if (sameContent && sameMode) {
                // Create is intentionally exclusive when content differs. An
                // identical retry, however, is a completed idempotent action
                // (common after a model/runtime retry) rather than a tool
                // failure. A write preserves provenance and lets the engine
                // produce an unchanged result without overwriting anything.
                expandedEdits.push({ ...edit, kind: "write" });
                continue;
              }
            }
            if (edit.kind !== "replaceText") {
              expandedEdits.push(edit);
              continue;
            }
            const current = await readCurrentFile(edit.path);
            if (!current) {
              throw new Error(`vcs.edit replaceText: no such path ${edit.path}`);
            }
            if (current.content.kind !== "text") {
              throw new Error(
                `vcs.edit replaceText: cannot replace text in binary file ${edit.path}`
              );
            }
            const text = current.content.text;
            const starts: number[] = [];
            for (let at = text.indexOf(edit.oldText); at >= 0; ) {
              starts.push(at);
              at = text.indexOf(edit.oldText, at + edit.oldText.length);
            }
            if (starts.length === 0) {
              throw new Error(
                `vcs.edit replaceText: oldText was not found in ${edit.path}; read the current file and retry`
              );
            }
            if (starts.length > 1 && edit.all !== true) {
              throw new Error(
                `vcs.edit replaceText: oldText occurs ${starts.length} times in ${edit.path}; ` +
                  "make oldText unique, pass all:true, or use positional replace hunks"
              );
            }
            expandedEdits.push({
              kind: "replace",
              path: edit.path,
              hunks: (edit.all === true ? starts : starts.slice(0, 1)).map((start) => ({
                start,
                end: start + edit.oldText.length,
                oldText: edit.oldText,
                newText: edit.newText,
              })),
            });
          }
          results.push(
            await vcs.recordEdit({
              head,
              edits: expandedEdits,
              actor,
              repoPath: editRepoPath,
              ...(groups.size === 1 && input.baseStateHash
                ? { baseStateHash: input.baseStateHash }
                : {}),
              // Provenance edge into the agentic trajectory (self-asserted by
              // the calling agent runtime; the edit tool passes its toolCallId).
              ...(input.invocationId ? { invocationId: input.invocationId } : {}),
              ...(input.clientEditId ? { clientEditId: input.clientEditId } : {}),
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
        // Aggregate a multi-repo edit: per-repo REPO-ROOTED results (each a
        // valid CAS base for a follow-up single-repo edit) plus the composed
        // context view under its OWN field — `contextStateHash` is a
        // different identity space and is never a valid `baseStateHash`.
        return {
          head,
          contextStateHash: head.startsWith("ctx:")
            ? await vcs.resolveContextView(head.slice("ctx:".length))
            : (await vcs.repositories.workspaceView()).stateHash,
          repos: results.map((r, i) => ({
            repoPath: repoOrder[i] ?? "",
            stateHash: r.stateHash,
            editSeq: r.editSeq,
            changedPaths: r.changedPaths,
          })),
          committed: false as const,
          status: "uncommitted" as const,
          editSeq: results.reduce((m, r) => Math.max(m, r.editSeq), 0),
          changedPaths: results.flatMap((r) => r.changedPaths),
        };
      },
      commit: async (ctx, [input]) => {
        const actor = actorFor(ctx);
        if (!input.message || !input.message.trim()) {
          throw new Error("vcs.commit requires a message");
        }
        const head = await resolveWriteHead(ctx, deps, input.head);
        if (head === VCS_MAIN_HEAD) {
          throw new Error("vcs.commit: main advances only via push; commit a ctx:* head");
        }
        const contextId = head.startsWith("ctx:") ? head.slice("ctx:".length) : null;
        if (!contextId) {
          throw new Error(`vcs.commit targets a ctx:* head, not ${head}`);
        }
        if (input.paths && input.paths.length > 0 && input.exclude && input.exclude.length > 0) {
          throw new Error(
            "vcs.commit takes `paths` (commit only these) OR `exclude` (commit all but these), " +
              "not both — pick one selector."
          );
        }
        // Sealable repos: uncommitted working edits OR a pending merge (a
        // conflicted merge that needed zero manual edits still needs its
        // sealing commit — the pending merge alone makes the repo committable).
        const contextRows = await vcs.contextStatus(contextId);
        const sealableRepos = new Set(
          contextRows.filter((r) => r.uncommitted || r.pendingMerge).map((r) => r.repoPath)
        );
        // Route path selectors to their repo (repo-relative) for filtering.
        const pathsByRepo = new Map<string, string[]>();
        for (const p of input.paths ?? []) {
          const routed = routeWorkspacePathOrThrow("vcs.commit paths", p, defaultRepo(deps));
          const list = pathsByRepo.get(routed.repoPath) ?? [];
          list.push(routed.repoRelPath);
          pathsByRepo.set(routed.repoPath, list);
        }
        // Repos to commit: explicit, else routed from `paths`, else every
        // sealable repo. A clean explicit repo reports `unchanged` — a
        // status, not an error; partial multi-repo outcomes stay visible.
        let repoPaths: string[];
        if (input.repoPaths && input.repoPaths.length > 0) {
          repoPaths = uniqueRepoPaths(input.repoPaths, "vcs.commit");
        } else if (pathsByRepo.size > 0) {
          repoPaths = [...pathsByRepo.keys()].sort();
        } else {
          repoPaths = [...sealableRepos].sort();
          if (repoPaths.length === 0) {
            throw new Error(noUncommittedCommitMessage(head));
          }
        }
        // Exclude paths route to their repo (repo-relative) for filtering.
        const excludeByRepo = new Map<string, string[]>();
        const targetRepos = new Set(repoPaths);
        for (const p of input.exclude ?? []) {
          const routed = routeWorkspacePathOrThrow("vcs.commit exclude", p, defaultRepo(deps));
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
        for (const repoPath of pathsByRepo.keys()) {
          if (!targetRepos.has(repoPath)) {
            throw new Error(
              `vcs.commit paths include ${repoPath} files, but this commit targets ` +
                `${repoPaths.join(", ")}. Add the repo to repoPaths or drop those paths.`
            );
          }
        }
        if (pathsByRepo.size > 0) {
          for (const repoPath of targetRepos) {
            if (!pathsByRepo.has(repoPath)) {
              throw new Error(
                `vcs.commit targets ${repoPath}, but paths contains no selected paths for that repo. ` +
                  `Remove ${repoPath} from repoPaths or add the files to paths.`
              );
            }
          }
        }
        // Per-repo loop, NEVER throwing mid-loop: a repo whose seal fails
        // reports `refused` (with the reason) while earlier repos' landed
        // commits stay visible in the result. Eligibility is re-checked
        // INSIDE the loop by the DO's own commit (CAS-guarded), so a
        // concurrent discard between the snapshot above and the loop can
        // only produce an honest `unchanged`/`refused`, never a lost result.
        const out = [];
        for (const repoPath of repoPaths) {
          const exclude = excludeByRepo.get(repoPath);
          const paths = pathsByRepo.get(repoPath);
          try {
            const result = await vcs.commit({
              head,
              repoPath,
              message: input.message,
              actor,
              ...(exclude ? { exclude } : {}),
              ...(paths ? { paths } : {}),
              // A2/T1: self-asserted sealing tool-call id, recorded on the commit event.
              ...(input.invocationId ? { invocationId: input.invocationId } : {}),
            });
            out.push({ repoPath: normalizeWorkspaceRepoPath(repoPath), ...result });
          } catch (error) {
            out.push({
              repoPath: normalizeWorkspaceRepoPath(repoPath),
              head,
              stateHash: null,
              eventId: null,
              headHash: null,
              editCount: 0,
              status: "refused" as const,
              refusedReason: error instanceof Error ? error.message : String(error),
              changedPaths: [],
            });
          }
        }
        return out;
      },
      discardEdits: async (ctx, [repoArg, headArg]) => {
        const head = await resolveWriteHead(ctx, deps, headArg);
        if (head === VCS_MAIN_HEAD) {
          throw new Error(
            "vcs.discardEdits: main is a pure ref with no working edits to discard — " +
              "working edits live on ctx:* heads; pass or resolve a context head"
          );
        }
        const repoPath = normalizeWorkspaceRepoPath(repoArg);
        return vcs.discardEdits({ head, repoPath });
      },
      // History/read traversals (commitEdits, fileHistory, commitAncestors,
      // editsByActor/Turn/Invocation, log) are USERLAND-dispatched since
      // P5c: consumers resolve the `vcs` manifest service (workers.
      // resolveService → gad-store DO) and call its `vcs*` read methods.
      previewBuild: async (ctx, [input]) => {
        const head = input.head
          ? await resolveWriteHead(ctx, deps, input.head)
          : headForCaller(ctx, deps);
        return vcs.previewBuild({
          head,
          ...(input.repoPaths
            ? { repoPaths: input.repoPaths.map((r) => normalizeWorkspaceRepoPath(r)) }
            : {}),
          ...(input.units ? { units: input.units } : {}),
          getBuildSystem: () => deps.getBuildSystem?.() ?? null,
        });
      },
      readFile: async (ctx, [input]) => {
        const { path: filePath, repoPath: repoArg, scope } = input;
        const resolvedRef =
          input.ref || (scope ? vcsContextHead(scope.contextId) : headForCaller(ctx, deps));
        await authorizeScopedReadHead(ctx, deps, resolvedRef, scope);
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
        const routed = routeWorkspacePathOrThrow("vcs.readFile", filePath, defaultRepo(deps));
        if (resolvedRef.startsWith("ctx:")) {
          const stateHash = await vcs.contextRepoState(
            resolvedRef.slice("ctx:".length),
            routed.repoPath
          );
          return stateHash ? await vcs.readFile(stateHash, routed.repoRelPath) : null;
        }
        if (!resolvedRef.startsWith("state:")) {
          return await vcs.readFile(resolvedRef, routed.repoRelPath, routed.repoPath);
        }
        // A state ref without repoPath denotes a composed workspace state;
        // preserve its workspace-rooted address. Repo-rooted state reads are
        // explicit through input.repoPath and cannot be guessed from a hash.
        return await vcs.readFile(resolvedRef, `${routed.repoPath}/${routed.repoRelPath}`);
      },
      listFiles: async (ctx, [input = {}]) => {
        const { repoPath: repoArg, scope } = input;
        const resolvedRef =
          input.ref || (scope ? vcsContextHead(scope.contextId) : headForCaller(ctx, deps));
        await authorizeScopedReadHead(ctx, deps, resolvedRef, scope);
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
            ? (await vcs.repositories.workspaceView()).stateHash
            : resolvedRef;
        return await vcs.listFiles(stateRef);
      },
      revert: async (ctx, [target]) => {
        const actor = actorFor(ctx);
        // A revert lands as a WORKING edit (inverse patch) — no commit, no
        // build; the caller commits it later. Rejects a `main` head.
        const head = await resolveWriteHead(ctx, deps, target.head);
        const repoPath = normalizeWorkspaceRepoPath(target.repoPath);
        const stateHash = target.stateHash;
        let eventId = target.eventId;
        if (!stateHash && !eventId) {
          const latest = (await vcs.readVcsLog(repoPath, 1, head))[0];
          if (!latest) {
            throw new Error(`vcs.revert found no commit to undo on ${repoPath} at ${head}`);
          }
          eventId = latest.envelopeId;
        }
        return await vcs.revert({
          head,
          target: { stateHash, eventId },
          actor,
          repoPath,
        });
      },
      log: async (ctx, [repoArg, limit, requestedHead]) => {
        const repoPath = normalizeWorkspaceRepoPath(repoArg);
        const head = requestedHead ?? headForCaller(ctx, deps);
        await authorizeReadHead(ctx, deps, head);
        return await vcs.readVcsLog(repoPath, limit, head);
      },
      status: async (ctx, [repoArg, headArg, scope]) => {
        const repoPath = normalizeWorkspaceRepoPath(repoArg);
        const head = scope
          ? vcsContextHead(scope.contextId)
          : resolveReadHeadArg("status", headArg, ctx, deps);
        await authorizeScopedReadHead(ctx, deps, head, scope);
        return await vcs.statusHead(head, repoPath);
      },
      diff: (_ctx, [left, right]) => {
        assertStateHashArg("diff", left, "left");
        assertStateHashArg("diff", right, "right");
        // Content-store Merkle diff (diffTrees) — the gad DO is not consulted.
        return vcs.diffStates(left, right);
      },
      diffContent: async (ctx, [input]) => {
        // Real hunks (review-before-commit/push). Endpoint resolution follows
        // status semantics; the hunk computation runs in the gad-store DO
        // over the shared vcs-engine diff.
        if ((input.left === undefined) !== (input.right === undefined)) {
          throw new Error("vcs.diffContent: pass BOTH left and right state hashes, or neither");
        }
        if (input.left && input.right) {
          assertStateHashArg("diffContent", input.left, "left");
          assertStateHashArg("diffContent", input.right, "right");
        } else if (!input.repoPath) {
          throw new Error(
            "vcs.diffContent requires repoPath (to resolve the head/main endpoints) unless " +
              "explicit left/right state hashes are given"
          );
        }
        const head = resolveReadHeadArg("diffContent", input.head, ctx, deps);
        await authorizeReadHead(ctx, deps, head);
        return await vcs.diffContent({
          ...(input.repoPath ? { repoPath: normalizeWorkspaceRepoPath(input.repoPath) } : {}),
          head,
          scope: input.scope ?? "all",
          ...(input.left && input.right ? { left: input.left, right: input.right } : {}),
          ...(input.paths ? { paths: input.paths } : {}),
          ...(input.contextLines !== undefined ? { contextLines: input.contextLines } : {}),
        });
      },
      resolveHead: async (ctx, [requested, repoArg]) => {
        const repoPath = normalizeWorkspaceRepoPath(repoArg);
        const head = requested ?? headForCaller(ctx, deps);
        await authorizeReadHead(ctx, deps, head);
        return { head, stateHash: await vcs.resolveHead(head, repoPath) };
      },
      workspaceViewWithRepoAt: async (_ctx, [repoArg, stateHash]) => {
        if (stateHash !== null)
          assertStateHashArg("workspaceViewWithRepoAt", stateHash, "stateHash");
        const repoPath = normalizeWorkspaceRepoPath(repoArg);
        return {
          stateHash: await vcs.repositories.workspaceViewWithRepoAt(repoPath, stateHash),
        };
      },
      merge: async (ctx, [input]) => {
        const actor = actorFor(ctx);
        // Explicit reconcile: pull a SOURCE (`main`, or a context the caller
        // owns/forked) into the caller's context head, one merge commit per
        // repo. The merge ENGINE is source-generic in the gad-store DO
        // (`vcsMerge`), which owns the commit-gate on BOTH sides; this host
        // side resolves the source head, loops repos, and surfaces the DO's
        // source-side dirty-gate error verbatim.
        const targetHead = await resolveWriteHead(ctx, deps, input.head);
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
          await authorizeContextRead(
            ctx,
            deps,
            input.source.contextId,
            input.source.ownerContextId
          );
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
        // Per-repo loop, NEVER throwing mid-loop: a repo whose merge cannot
        // run (uncommitted edits, deleted repo, source absent there, …)
        // reports `refused` while the other repos' merge commits land and
        // stay visible in the result.
        const out = [];
        for (const repoPath of repoPaths) {
          try {
            const result = await vcs.mergeHeads(targetHead, sourceHead, { actor, repoPath });
            out.push({ repoPath, ...result });
          } catch (error) {
            out.push({
              repoPath,
              status: "refused" as const,
              stateHash: null,
              conflicts: [],
              mergeable: "clean" as const,
              upstreamCommits: [],
              refusedReason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return out;
      },
      pick: async (ctx, [input]) => {
        const actor = actorFor(ctx);
        // Cherry-pick selected changes from a SOURCE onto the caller's context
        // head as UNCOMMITTED working edits (never a head advance). Commit
        // picks 3-way-apply a commit's patch (routed per pick's repoPath);
        // path picks inject the source context's working content (routed to
        // the paths' owning repos). Each lands via the DO `vcsPick`.
        const targetHead = await resolveWriteHead(ctx, deps, input.head);
        if (targetHead === VCS_MAIN_HEAD) {
          throw new Error("vcs.pick targets a ctx:* head; main advances via push");
        }
        let sourceContextId: string | null = null;
        if (input.source && input.source !== "main") {
          await authorizeContextRead(
            ctx,
            deps,
            input.source.contextId,
            input.source.ownerContextId
          );
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
            const routed = routeWorkspacePathOrThrow("vcs.pick", path, defaultRepo(deps));
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
      },
      contextDiff: async (ctx, [input]) => {
        // A convenience projection: diff a context you own/forked against its
        // fork-base (default) or main. Read-authorized like the cross-context
        // reads; NOT a head write.
        await authorizeContextRead(ctx, deps, input.contextId, input.ownerContextId);
        return await vcs.contextDiff(input.contextId, input.against ?? "fork-base");
      },
      abortMerge: async (ctx, [repoArg, headArg]) => {
        const actor = actorFor(ctx);
        const targetHead = await resolveWriteHead(ctx, deps, headArg);
        if (targetHead === VCS_MAIN_HEAD) {
          throw new Error(
            "vcs.abortMerge: main is a pure ref and never carries a pending merge — " +
              "pending merges live on ctx:* heads; pass or resolve a context head"
          );
        }
        const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
        if (!repoPath) {
          throw new Error("vcs.abortMerge requires repoPath in the per-repo VCS model");
        }
        // Aborting a pending merge restores the pre-merge tree; it never
        // advances a head ref, so no main-advance gate applies (even on main).
        return await vcs.abortMerge(targetHead, { actor, repoPath });
      },
      pendingMerge: async (ctx, [repoArg, headArg, scope]) => {
        const targetHead = scope
          ? vcsContextHead(scope.contextId)
          : resolveReadHeadArg("pendingMerge", headArg, ctx, deps);
        await authorizeScopedReadHead(ctx, deps, targetHead, scope);
        const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
        if (!repoPath) {
          throw new Error("vcs.pendingMerge requires repoPath in the per-repo VCS model");
        }
        return await vcs.pendingMerge(targetHead, repoPath);
      },
      pushStatus: (ctx, [repoArgs]) => {
        const repoPaths = repoArgs.map((r) => normalizeWorkspaceRepoPath(r));
        const head = headForCaller(ctx, deps);
        return Promise.all(repoPaths.map((repoPath) => vcs.pushStatus(repoPath, head)));
      },
      recall: (_ctx, [input]) => vcs.memory.recall(input),
      // forkRepo / deleteRepo / restoreRepo are no longer host-serviced:
      // Phase 4 moved the sagas into the gad-store DO (`vcsForkRepo` /
      // `vcsDeleteRepo` / `vcsRestoreRepo`) and userland routes to them
      // DIRECTLY (like `vcs.push` → `vcsPush`) so the relay mints the
      // on-behalf-of token attributing the severe prompt to the originating
      // caller (D3). A host forward would erase that attribution.
      contextStatus: async (ctx, [scope]) => {
        if (scope) {
          await authorizeContextRead(ctx, deps, scope.contextId, scope.ownerContextId);
          return await vcs.contextStatus(scope.contextId);
        }
        const contextId = callerContextId(ctx, deps);
        if (!contextId) throw new Error("vcs.contextStatus requires an active context");
        return await vcs.contextStatus(contextId);
      },
      rebaseContext: (ctx) => {
        const actor = actorFor(ctx);
        const contextId = callerContextId(ctx, deps);
        if (!contextId) throw new Error("vcs.rebaseContext requires an active context");
        return vcs.rebaseContext(contextId, actor);
      },
    }),
  };
}
