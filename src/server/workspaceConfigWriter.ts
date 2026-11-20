/** Publish workspace configuration from an isolated host working copy. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  parseTemplateManifestContent,
  templateManifestDocument,
} from "@vibestudio/workspace/templateManifest";
import { rpcErrorDataOf } from "@vibestudio/rpc";
import { verifiedInitiator, type ServiceContext, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  readWorkspaceConfig,
  parseWorkspaceConfigContentWithId,
} from "@vibestudio/workspace/configParser";
import {
  assertWorkspaceConfigPathScope,
  changedWorkspaceConfigPaths,
  workspaceConfigDigest,
} from "@vibestudio/workspace/preparedConfig";
import type { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";
import { readWorkspaceParticipantStatus, workspaceParticipantCatalog } from "./vcsHost/workspaceHistoryHost.js";

const META_REPO_PATH = "meta";
const WORKSPACE_CONFIG_FILE = "vibestudio.yml";

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

interface WorkspaceConfigContents {
  text: string;
  config: WorkspaceConfig;
  sourceFiles: Map<string, string | null>;
  readSourceFile(path: string): Promise<string | null>;
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
  vcs: Pick<WorkspaceVcs,
    | "whenSemanticReady" | "withProtectedMainMutation" | "ensureFresh" | "readFile"
    | "openParticipantScope" | "dropContext" | "readParticipantFiles"
    | "editParticipantContext" | "saveParticipantContext" | "publishParticipantContext"
  >;
  authoringCaller: VerifiedCaller;
}): WorkspaceConfigMainWriter {
  const loadConfig = async (text: string, readText: (path: string) => Promise<string | null>) => {
    const filePath = `${META_REPO_PATH}/${WORKSPACE_CONFIG_FILE}`;
    const sourceFiles = new Map<string, string | null>([[filePath, text]]);
    const readSourceFile = async (path: string): Promise<string | null> => {
      if (sourceFiles.has(path)) return sourceFiles.get(path)!;
      const content = await readText(path);
      sourceFiles.set(path, content);
      return content;
    };
    const config = await readWorkspaceConfig({ readText: readSourceFile }, deps.workspaceId);
    return { text, config, sourceFiles, readSourceFile };
  };
  const withTemporaryContext = async <T>(operation: (contextId: string) => Promise<T>): Promise<T> => {
    const contextId = `system:workspace-config:${randomUUID()}`;
    // The isolated context holds only the configuration changes. Preserve the
    // operation failure if cleanup also fails.
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

  const render = async (currentState: WorkspaceConfigContents, mutate: WorkspaceConfigMutation) => {
    const nextConfig = mutate(currentState.config);
    await Promise.all(
      (nextConfig.services ?? []).map((service) =>
        currentState.readSourceFile(`${service.source}/package.json`)
      )
    );
    const nextContent = renderWorkspaceConfigYaml(
      currentState.text,
      nextConfig,
      deps.workspaceId,
      (source) => currentState.sourceFiles.get(`${source}/package.json`) ?? null
    );
    const parsed = parseWorkspaceConfigContentWithId(
      nextContent,
      deps.workspaceId,
      (source) => currentState.sourceFiles.get(`${source}/package.json`) ?? null
    );
    return {
      nextConfig: parsed,
      nextContent: isDeepStrictEqual(nextConfig, currentState.config)
        ? currentState.text
        : nextContent,
    };
  };

  const applyParticipantMutation = (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> => withTemporaryContext(async (contextId) => {
    const author = deps.authoringCaller;
    const scope = await deps.vcs.openParticipantScope({
      contextId, caller: author, ownerContextId: contextId,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    });
    if (!scope) throw new Error("Participant workspace history is unavailable");
    const status = await readWorkspaceParticipantStatus(scope);
    if (!status.clean || status.mainRelation !== "at") {
      throw new Error("Workspace configuration could not start from the current main revision");
    }
    const state = status.workingHead;
    const catalog = workspaceParticipantCatalog(scope);
    const read = async (repoPath: string, filePath: string) => {
      const repository = await catalog.resolveRepository({ state, repoPath });
      if (!repository) return null;
      const [file] = await deps.vcs.readParticipantFiles({
        ...scope,
        read: { state, files: [{ repositoryId: repository.repositoryId, file: { kind: "path", path: filePath } }] },
      });
      return file?.content.kind === "text"
        ? { repositoryId: repository.repositoryId, fileId: file.fileId, text: file.content.text }
        : null;
    };
    const found = await read(META_REPO_PATH, WORKSPACE_CONFIG_FILE);
    if (!found) {
      throw new Error("Cannot persist workspace config: meta/vibestudio.yml is missing or is not text");
    }
    const current = await loadConfig(found.text, async (filePath) => {
      const value = await read(filePath.slice(0, -"/package.json".length), "package.json");
      return value?.text ?? null;
    });
    const rendered = await render(current, input.mutate);
    if (rendered.nextContent === current.text) {
      return { changed: false, nextConfig: rendered.nextConfig };
    }
    const commandStem = `workspace-config:${input.ctx.requestId ?? randomUUID()}`;
    const cause = { parent: input.ctx.causalParent ?? null };
    const edited = await deps.vcs.editParticipantContext({
      ...scope, head: scope.workingHead, cause,
      edit: {
        contextId, commandId: `${commandStem}:edit`, expectedWorkingHead: state,
        intentSummary: input.summary,
        changes: [{
          kind: "text-edit", repositoryId: found.repositoryId, fileId: found.fileId,
          edits: [{ start: 0, end: current.text.length, text: rendered.nextContent }],
        }],
      },
    });
    const committed = await deps.vcs.saveParticipantContext({
      ...scope, head: edited.head, cause,
      commit: {
        contextId, commandId: `${commandStem}:commit`,
        expectedWorkingHead: edited.result.workingHead, message: input.summary,
      },
    });
    if (committed.event.kind !== "event") throw new Error("Workspace config commit did not produce an event");
    await deps.vcs.publishParticipantContext({
      ...scope,
      storageCaller: author,
      push: {
        contextId, commandId: `${commandStem}:push`,
        expectedCommittedEventId: committed.event.eventId, expectedMainEventId: status.mainEventId,
      },
      gateContext: {
        kind: "caller", caller: verifiedInitiator(input.ctx),
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      },
    });
    return { changed: true, nextConfig: rendered.nextConfig };
  });

  const wouldMutate = async (mutate: WorkspaceConfigMutation): Promise<boolean> => {
    await deps.vcs.whenSemanticReady();
    const { stateHash } = await deps.vcs.ensureFresh();
    const readText = async (filePath: string) => {
      const file = await deps.vcs.readFile(stateHash, filePath);
      return file?.content.kind === "text" ? file.content.text : null;
    };
    const text = await readText(`${META_REPO_PATH}/${WORKSPACE_CONFIG_FILE}`);
    if (text === null) throw new Error("Cannot read workspace config from protected main");
    const current = await loadConfig(text, readText);
    return (await render(current, mutate)).nextContent !== current.text;
  };

  const applyMutation = async (
    input: Parameters<WorkspaceConfigMainWriter["applyMutation"]>[0]
  ): Promise<WorkspaceConfigMutationResult> => {
    await deps.vcs.whenSemanticReady(input.ctx.signal);
    if (!deps.authoringCaller.hostOriginated)
      throw new Error("Workspace configuration requires a host author");
    return deps.vcs.withProtectedMainMutation(() => applyParticipantMutation(input));
  };

  return {
    wouldMutate,
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
  workspaceId: string,
  readServiceManifest?: (source: string) => string | null
): string {
  // Parse the old file so malformed runtime state is never overwritten under
  // cover of an unrelated mutation.
  parseWorkspaceConfigContentWithId(currentContent, workspaceId, readServiceManifest);
  const manifest = parseTemplateManifestContent(currentContent, nextConfig.systemEpoch);
  const { id: _resolvedId, services, ...desired } = nextConfig;
  const authored = {
    ...desired,
    ...(services ? { services: services.map(({ source, name }) => ({ source, name })) } : {}),
    template: templateManifestDocument(manifest)["template"],
  };
  const nextContent = YAML.stringify(authored);
  const resolved = parseWorkspaceConfigContentWithId(nextContent, workspaceId, readServiceManifest);
  if (!isDeepStrictEqual(resolved, nextConfig))
    throw new Error("Service contracts must be edited in their owning repository manifest");
  return nextContent;
}
