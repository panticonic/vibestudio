/** Publish workspace-config edits through the caller's clean task context when available. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { rpcErrorDataOf } from "@vibestudio/rpc";
import { verifiedInitiator, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import {
  assertWorkspaceConfigPathScope,
  changedWorkspaceConfigPaths,
  workspaceConfigDigest,
} from "@vibestudio/workspace/preparedConfig";
import type {
  VcsCommitResult,
  VcsInspectResult,
  VcsListFilesResult,
  VcsNeighborsResult,
  VcsPushResult,
  VcsReadFileResult,
  VcsStateNodeRef,
  VcsStatusResult,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import type { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";

const META_REPO_PATH = "meta";
const WORKSPACE_CONFIG_FILE = "vibestudio.yml";
const PAGE_LIMIT = 500;

export interface WorkspaceConfigMainWriter {
  wouldMutate(mutate: WorkspaceConfigMutation): Promise<boolean>;
  applyMutation(input: {
    ctx: ServiceContext;
    mutate: WorkspaceConfigMutation;
    summary: string;
  }): Promise<WorkspaceConfigMutationResult>;
  applyPrepared(input: {
    ctx: ServiceContext;
    expectedBaseDigest: string;
    nextState: WorkspaceConfig;
    resultDigest: string;
    allowedPathScope: readonly string[];
    summary: string;
  }): Promise<WorkspaceConfigMutationResult & { resultDigest: string }>;
}

export type WorkspaceConfigMutation = (currentConfig: WorkspaceConfig) => WorkspaceConfig;

export interface WorkspaceConfigMutationResult {
  changed: boolean;
  nextConfig: WorkspaceConfig;
}

interface WorkspaceConfigAtState {
  status: VcsStatusResult;
  repositoryId: string;
  fileId: string;
  text: string;
  config: WorkspaceConfig;
}

function sameState(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "event"
      ? right.kind === "event" && left.eventId === right.eventId
      : right.kind === "application" && left.applicationId === right.applicationId)
  );
}

const SYSTEM_CAUSE: RpcCausalParent | null = null;
const SYSTEM_INTEGRITY = Object.freeze({
  class: "internal" as const,
  externalKeys: Object.freeze([]) as readonly string[],
});

function integrityFor(ctx: ServiceContext): {
  class: "internal" | "external";
  externalKeys: readonly string[];
} {
  const fact = ctx.authorization?.contextIntegrity;
  if (!fact) {
    throw new Error("Workspace config mutation requires resolved context-integrity authority");
  }
  return fact.class === "external"
    ? { class: "external", externalKeys: [...fact.externalKeys] }
    : { class: "internal", externalKeys: [] };
}

function errorDetail(error: unknown): {
  message: string;
  code?: string;
  errorKind?: string;
  errorData?: unknown;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  const errorKind =
    error &&
    typeof error === "object" &&
    typeof (error as { errorKind?: unknown }).errorKind === "string"
      ? (error as { errorKind: string }).errorKind
      : undefined;
  const errorData = rpcErrorDataOf(error);
  return {
    message,
    ...(code ? { code } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(errorData === undefined ? {} : { errorData }),
  };
}

function attachCleanupFailure(primary: unknown, cleanup: unknown, contextId: string): Error {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  const existing = rpcErrorDataOf(error);
  const errorData = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    cleanupFailures: [
      {
        stage: "drop-temporary-context",
        contextId,
        ...errorDetail(cleanup),
      },
    ],
  };
  try {
    Object.defineProperty(error, "errorData", {
      value: errorData,
      writable: true,
      configurable: true,
    });
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: error });
    Object.defineProperty(wrapped, "errorData", {
      value: errorData,
      writable: true,
      configurable: true,
    });
    return wrapped;
  }
}

export function createWorkspaceConfigMainWriter(deps: {
  /** Hub-owned workspace identity. Never derive authority from a mutable checkout path. */
  workspaceId: string;
  vcs: WorkspaceVcs;
}): WorkspaceConfigMainWriter {
  const readConfig = async (
    contextId: string,
    causalParent: RpcCausalParent | null,
    contextIntegrity: { class: "internal" | "external"; externalKeys: readonly string[] },
    knownStatus?: VcsStatusResult
  ): Promise<WorkspaceConfigAtState> => {
    const call = <T>(method: string, input: unknown): Promise<T> =>
      deps.vcs.semanticCausalCall<T>(method, input, causalParent, contextIntegrity);
    const status = knownStatus ?? (await call<VcsStatusResult>("vcsStatus", { contextId }));
    const state = status.workingHead;
    const repositoryRefs = new Map<
      string,
      Extract<VcsNeighborsResult["edges"][number]["to"], { kind: "repository" }>
    >();
    let cursor: string | undefined;
    do {
      const page = await call<VcsNeighborsResult>("vcsNeighbors", {
        root: state,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      for (const edge of page.edges) {
        for (const node of [edge.from, edge.to]) {
          if (node.kind === "repository" && sameState(node.state, state)) {
            repositoryRefs.set(node.repositoryId, node);
          }
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    let repositoryId: string | null = null;
    for (const repository of repositoryRefs.values()) {
      const inspected = await call<VcsInspectResult>("vcsInspect", {
        node: repository,
        edgeLimit: 1,
      });
      if (
        inspected.node.kind === "repository" &&
        inspected.node.value.kind === "present" &&
        inspected.node.value.repoPath === META_REPO_PATH
      ) {
        repositoryId = inspected.node.value.repositoryId;
        break;
      }
    }
    if (!repositoryId) {
      throw new Error(`Cannot persist workspace config: ${META_REPO_PATH} repository is absent`);
    }

    const metaFiles = new Map<string, string>();
    cursor = undefined;
    do {
      const page: VcsListFilesResult = await call("vcsListFiles", {
        state,
        repositoryId,
        prefix: "",
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      for (const file of page.files) metaFiles.set(file.path, file.fileId);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const fileId = metaFiles.get(WORKSPACE_CONFIG_FILE) ?? null;
    if (!fileId) {
      throw new Error(
        `Cannot persist workspace config: ${META_REPO_PATH}/${WORKSPACE_CONFIG_FILE} is absent`
      );
    }

    const content = await call<VcsReadFileResult>("vcsReadFile", {
      state,
      repositoryId,
      file: { kind: "id", fileId },
    });
    if (!content || content.content.kind !== "text") {
      throw new Error(
        `Cannot persist workspace config: ${META_REPO_PATH}/${WORKSPACE_CONFIG_FILE} is not text`
      );
    }
    return {
      status,
      repositoryId,
      fileId,
      text: content.content.text,
      config: parseWorkspaceConfigContentWithId(content.content.text, deps.workspaceId),
    };
  };

  const withFreshContext = async <T>(operation: (contextId: string) => Promise<T>): Promise<T> => {
    const contextId = `system:workspace-config:${randomUUID()}`;
    // Config mutation is entirely semantic: every read/edit/commit below is
    // addressed through the content graph, and no operation consumes a
    // filesystem path. Eagerly projecting the whole workspace here made an
    // approval click compete with (and delay) unrelated unit builds and Iroh
    // control traffic. Preserve the exact same isolated VCS authority without
    // manufacturing a disposable checkout that nobody reads.
    await deps.vcs.ensureSemanticContext(contextId);

    // The context drop is mandatory, but it can't live in a `finally`: a throw
    // there hijacks the control flow leaving the try block (that's what
    // no-unsafe-finally warns about). Settle both outcomes first, then decide
    // what propagates — the operation's own failure always stays primary, with
    // any cleanup failure attached to it.
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await operation(contextId) };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let cleanup: { failure: unknown } | null = null;
    try {
      await deps.vcs.dropContext(contextId);
    } catch (failure) {
      cleanup = { failure };
    }

    if (cleanup) {
      throw outcome.ok
        ? cleanup.failure
        : attachCleanupFailure(outcome.error, cleanup.failure, contextId);
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  const withMutationContext = async <T>(
    ctx: ServiceContext,
    operation: (contextId: string, borrowed: boolean) => Promise<T>
  ): Promise<T> => {
    const callerContextId =
      ctx.evalInvocation?.contextId ??
      ctx.caller.executionSession?.contextId ??
      ctx.authorizingCaller?.executionSession?.contextId;
    if (callerContextId) return operation(callerContextId, true);
    return withFreshContext((contextId) => operation(contextId, false));
  };

  const render = (currentState: WorkspaceConfigAtState, mutate: WorkspaceConfigMutation) => {
    const nextConfig = mutate(currentState.config);
    const nextContent = renderWorkspaceConfigYaml(currentState.text, nextConfig, deps.workspaceId);
    const parsed = parseWorkspaceConfigContentWithId(nextContent, deps.workspaceId);
    return {
      nextConfig: parsed,
      nextContent: isDeepStrictEqual(nextConfig, currentState.config)
        ? currentState.text
        : nextContent,
    };
  };

  const applyMutationInContext = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0],
    contextId: string,
    borrowed: boolean
  ): Promise<WorkspaceConfigMutationResult> => {
    const causalParent = input.ctx.causalParent ?? null;
    const contextIntegrity = integrityFor(input.ctx);
    // Borrowing a clean caller context keeps it aligned with the config
    // publication. A dirty or behind context may contain unrelated work, so
    // preserve the established isolated-context behavior instead of either
    // publishing that work or refusing a previously valid config mutation.
    const borrowedStatus = borrowed
      ? await deps.vcs.semanticCausalCall<VcsStatusResult>(
          "vcsStatus",
          { contextId },
          causalParent,
          contextIntegrity
        )
      : undefined;
    if (borrowedStatus && (!borrowedStatus.clean || borrowedStatus.mainRelation !== "at")) {
      return withFreshContext((freshContextId) =>
        applyMutationInContext(input, freshContextId, false)
      );
    }
    const current = await readConfig(contextId, causalParent, contextIntegrity, borrowedStatus);
    const rendered = render(current, input.mutate);
    if (rendered.nextContent === current.text) {
      return { changed: false, nextConfig: rendered.nextConfig };
    }

    const commandStem = `workspace-config:${input.ctx.requestId ?? randomUUID()}`;
    const edit = await deps.vcs.semanticCausalCall<VcsWorkingMutationResult>(
      "vcsEdit",
      {
        contextId,
        commandId: `${commandStem}:edit`,
        expectedWorkingHead: current.status.workingHead,
        intentSummary: input.summary,
        changes: [
          {
            kind: "text-edit",
            repositoryId: current.repositoryId,
            fileId: current.fileId,
            edits: [{ start: 0, end: current.text.length, text: rendered.nextContent }],
          },
        ],
      },
      causalParent,
      contextIntegrity
    );
    const committed = await deps.vcs.semanticCausalCall<VcsCommitResult>(
      "vcsCommit",
      {
        contextId,
        commandId: `${commandStem}:commit`,
        expectedWorkingHead: edit.workingHead,
        message: input.summary,
      },
      causalParent,
      contextIntegrity
    );
    if (committed.event.kind !== "event") {
      throw new Error("Workspace config commit did not produce an event");
    }
    const pushInput = {
      contextId,
      commandId: `${commandStem}:push`,
      expectedCommittedEventId: committed.event.eventId,
      expectedMainEventId: current.status.mainEventId,
    };
    // Provider methods may perform a config mutation as a nested RPC while
    // servicing an authenticated shell/agent request. The extension is the
    // immediate transport caller, but it did not originate the protected
    // main advance. Preserve the verified authorizing principal just as the
    // VCS service does for other provider relays.
    const publishingCaller = verifiedInitiator(input.ctx);
    if (input.ctx.signal) {
      await deps.vcs.semanticPublishCall<VcsPushResult>(
        pushInput,
        causalParent,
        publishingCaller,
        contextIntegrity,
        input.ctx.signal
      );
    } else {
      await deps.vcs.semanticPublishCall<VcsPushResult>(
        pushInput,
        causalParent,
        publishingCaller,
        contextIntegrity
      );
    }
    return { changed: true, nextConfig: rendered.nextConfig };
  };

  const applyMutation = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> =>
    deps.vcs.withProtectedMainMutation(() =>
      withMutationContext(input.ctx, (contextId, borrowed) =>
        applyMutationInContext(input, contextId, borrowed)
      )
    );

  return {
    wouldMutate: (mutate) =>
      withFreshContext(async (contextId) => {
        const current = await readConfig(contextId, SYSTEM_CAUSE, SYSTEM_INTEGRITY);
        return render(current, mutate).nextContent !== current.text;
      }),
    applyMutation,
    applyPrepared: async (input) => {
      const result = await applyMutation({
        ctx: input.ctx,
        summary: input.summary,
        mutate: (currentConfig) => {
          const baseDigest = workspaceConfigDigest(currentConfig);
          if (baseDigest !== input.expectedBaseDigest) {
            throw new Error(
              `Prepared workspace-config base is stale: expected ${input.expectedBaseDigest}, current ${baseDigest}`
            );
          }
          const resultDigest = workspaceConfigDigest(input.nextState);
          if (resultDigest !== input.resultDigest) {
            throw new Error(
              `Prepared workspace-config result digest mismatch: expected ${input.resultDigest}, computed ${resultDigest}`
            );
          }
          assertWorkspaceConfigPathScope(
            changedWorkspaceConfigPaths(currentConfig, input.nextState),
            input.allowedPathScope
          );
          return input.nextState;
        },
      });
      return { ...result, resultDigest: workspaceConfigDigest(result.nextConfig) };
    },
  };
}

export function renderWorkspaceConfigYaml(
  currentContent: string,
  nextConfig: WorkspaceConfig,
  workspaceId: string
): string {
  // Parse the old file so malformed runtime state is never overwritten under
  // cover of an unrelated mutation.
  parseWorkspaceConfigContentWithId(currentContent, workspaceId);
  // `WorkspaceConfig.id` is resolved host state, not manifest content.
  const { id: _resolvedId, ...nextManifest } = nextConfig;
  const nextContent = YAML.stringify(nextManifest);
  parseWorkspaceConfigContentWithId(nextContent, workspaceId);
  return nextContent;
}
