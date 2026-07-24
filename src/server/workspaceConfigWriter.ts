/** Publish workspace-config edits through one fresh semantic context. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { rpcErrorDataOf } from "@vibestudio/rpc";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
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
  let mutationQueue = Promise.resolve();

  const readConfig = async (
    contextId: string,
    causalParent: RpcCausalParent | null,
    contextIntegrity: { class: "internal" | "external"; externalKeys: readonly string[] }
  ): Promise<WorkspaceConfigAtState> => {
    const call = <T>(method: string, input: unknown): Promise<T> =>
      deps.vcs.semanticCausalCall<T>(method, input, causalParent, contextIntegrity);
    const status = await call<VcsStatusResult>("vcsStatus", { contextId });
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

    let fileId: string | null = null;
    cursor = undefined;
    do {
      const page: VcsListFilesResult = await call("vcsListFiles", {
        state,
        repositoryId,
        prefix: WORKSPACE_CONFIG_FILE,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      fileId =
        page.files.find((candidate) => candidate.path === WORKSPACE_CONFIG_FILE)?.fileId ?? null;
      cursor = page.nextCursor ?? undefined;
    } while (!fileId && cursor);
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
    await deps.vcs.ensureContext(contextId);
    let primaryFailure: unknown;
    try {
      return await operation(contextId);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        await deps.vcs.dropContext(contextId);
      } catch (cleanupFailure) {
        if (primaryFailure !== undefined) {
          throw attachCleanupFailure(primaryFailure, cleanupFailure, contextId);
        }
        throw cleanupFailure;
      }
    }
  };

  const render = (
    currentContent: string,
    current: WorkspaceConfig,
    mutate: WorkspaceConfigMutation
  ) => {
    const nextConfig = mutate(current);
    return {
      nextConfig,
      nextContent: isDeepStrictEqual(nextConfig, current)
        ? currentContent
        : renderWorkspaceConfigYaml(currentContent, nextConfig, deps.workspaceId),
    };
  };

  const applyMutation = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> =>
    withFreshContext(async (contextId) => {
      const causalParent = input.ctx.causalParent ?? null;
      const contextIntegrity = integrityFor(input.ctx);
      const current = await readConfig(contextId, causalParent, contextIntegrity);
      const rendered = render(current.text, current.config, input.mutate);
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
      if (input.ctx.signal) {
        await deps.vcs.semanticPublishCall<VcsPushResult>(
          pushInput,
          causalParent,
          input.ctx.caller,
          contextIntegrity,
          input.ctx.signal
        );
      } else {
        await deps.vcs.semanticPublishCall<VcsPushResult>(
          pushInput,
          causalParent,
          input.ctx.caller,
          contextIntegrity
        );
      }
      return { changed: true, nextConfig: rendered.nextConfig };
    });

  return {
    wouldMutate: (mutate) =>
      withFreshContext(async (contextId) => {
        const current = await readConfig(contextId, SYSTEM_CAUSE, SYSTEM_INTEGRITY);
        return render(current.text, current.config, mutate).nextContent !== current.text;
      }),
    applyMutation(input) {
      const run = mutationQueue.then(
        () => applyMutation(input),
        () => applyMutation(input)
      );
      mutationQueue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}

export function renderWorkspaceConfigYaml(
  currentContent: string,
  nextConfig: WorkspaceConfig,
  workspaceId: string
): string {
  const beforeParsed = (YAML.parse(currentContent) as Record<string, unknown> | null) ?? {};
  // `WorkspaceConfig.id` is resolved host state, not manifest content. Older
  // writers could accidentally persist a checkout-derived id; omit it from
  // both sides so every real mutation also repairs that stale projection.
  const { id: _persistedId, ...beforeManifest } = beforeParsed;
  const { id: _resolvedId, ...nextManifest } = nextConfig;
  const nextContent = YAML.stringify({ ...beforeManifest, ...nextManifest });
  parseWorkspaceConfigContentWithId(nextContent, workspaceId);
  return nextContent;
}
