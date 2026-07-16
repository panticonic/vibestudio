/** Publish workspace-config edits through one fresh semantic context. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { parseWorkspaceConfigContent } from "@vibestudio/workspace/loader";
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

export function createWorkspaceConfigMainWriter(deps: {
  workspacePath: string;
  vcs: WorkspaceVcs;
}): WorkspaceConfigMainWriter {
  let mutationQueue = Promise.resolve();

  const readConfig = async (
    contextId: string,
    causalParent: RpcCausalParent | null
  ): Promise<WorkspaceConfigAtState> => {
    const call = <T>(method: string, input: unknown): Promise<T> =>
      deps.vcs.semanticCausalCall<T>(method, input, causalParent);
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
      config: parseWorkspaceConfigContent(content.content.text, deps.workspacePath),
    };
  };

  const withFreshContext = async <T>(operation: (contextId: string) => Promise<T>): Promise<T> => {
    const contextId = `system:workspace-config:${randomUUID()}`;
    await deps.vcs.ensureContext(contextId);
    try {
      return await operation(contextId);
    } finally {
      await deps.vcs.dropContext(contextId);
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
        : renderWorkspaceConfigYaml(currentContent, nextConfig, deps.workspacePath),
    };
  };

  const applyMutation = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> =>
    withFreshContext(async (contextId) => {
      const causalParent = input.ctx.causalParent ?? null;
      const current = await readConfig(contextId, causalParent);
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
        causalParent
      );
      const committed = await deps.vcs.semanticCausalCall<VcsCommitResult>(
        "vcsCommit",
        {
          contextId,
          commandId: `${commandStem}:commit`,
          expectedWorkingHead: edit.workingHead,
          message: input.summary,
        },
        causalParent
      );
      if (committed.event.kind !== "event") {
        throw new Error("Workspace config commit did not produce an event");
      }
      await deps.vcs.semanticPublishCall<VcsPushResult>(
        {
          contextId,
          commandId: `${commandStem}:push`,
          expectedCommittedEventId: committed.event.eventId,
          expectedMainEventId: current.status.mainEventId,
        },
        causalParent,
        input.ctx.caller
      );
      return { changed: true, nextConfig: rendered.nextConfig };
    });

  return {
    wouldMutate: (mutate) =>
      withFreshContext(async (contextId) => {
        const current = await readConfig(contextId, SYSTEM_CAUSE);
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
  workspacePath: string
): string {
  const beforeParsed = (YAML.parse(currentContent) as Record<string, unknown> | null) ?? {};
  const nextContent = YAML.stringify({ ...beforeParsed, ...nextConfig });
  parseWorkspaceConfigContent(nextContent, workspacePath);
  return nextContent;
}
