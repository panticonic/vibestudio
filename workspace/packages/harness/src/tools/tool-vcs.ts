/** Thin agent-tool adapter for the canonical semantic VCS service. */

import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import type { VcsResolveRepositoryResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";

import { resolveToCwd } from "./path-utils.js";

export function toVcsPath(path: string, cwd: string): string {
  const abs = resolveToCwd(path, cwd);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs === cwd || `${abs}/` === root) return "";
  if (!abs.startsWith(root)) throw new Error(`Path escapes the workspace root: ${path}`);
  return abs.slice(root.length);
}

export type ToolVcs = TypedServiceClient<typeof vcsMethods>;

export type ToolEditingVcs = Pick<
  ToolVcs,
  "status" | "resolveRepository" | "readFile" | "edit" | "commit"
>;

export type ToolFileTransferVcs = Pick<
  ToolVcs,
  "status" | "resolveRepository" | "readFile" | "move" | "copy"
>;

export interface ToolWorkspaceContext {
  readonly contextId: string | (() => string);
}

/** Trusted invocation binding required by every semantic mutation tool. */
export interface ToolMutationContext extends ToolWorkspaceContext {
  readonly commandId: string | (() => string);
}

export function toolContextId(context: ToolWorkspaceContext): string {
  return typeof context.contextId === "function" ? context.contextId() : context.contextId;
}

/** Resolve the command identity at mutation time, failing closed when unbound. */
export function toolCommandId(context: ToolMutationContext): string {
  const commandId =
    typeof context.commandId === "function" ? context.commandId() : context.commandId;
  if (commandId.length === 0) {
    throw new Error("A semantic mutation requires a bound trajectory invocation command id");
  }
  return commandId;
}

export async function resolveToolWorkingState(
  vcs: Pick<ToolVcs, "status">,
  context: ToolWorkspaceContext
): Promise<VcsStateNodeRef> {
  return (await vcs.status({ contextId: toolContextId(context) })).workingHead;
}

export type PresentToolRepository = NonNullable<VcsResolveRepositoryResult>;

/** Resolve a repository through the canonical exact-state resolver. */
export async function resolveToolRepository(
  vcs: Pick<ToolVcs, "resolveRepository">,
  state: VcsStateNodeRef,
  repoPath: string
): Promise<PresentToolRepository> {
  const repository = await vcs.resolveRepository({ state, repoPath });
  if (repository) return repository;
  throw new Error(`Repository ${repoPath} is not present at ${stateNodeLabel(state)}`);
}

export interface ToolFileResolution {
  state: VcsStateNodeRef;
  repositoryId: string;
  repoPath: string;
  fileId: string;
  path: string;
  contentHash: string;
  mode: number;
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
}

export async function resolveToolFile(
  vcs: Pick<ToolVcs, "resolveRepository" | "readFile">,
  state: VcsStateNodeRef,
  workspacePath: string
): Promise<ToolFileResolution | null> {
  const split = splitRepoPath(workspacePath);
  if (!split?.repoRelPath) throw new Error(`${workspacePath} is not a file in a workspace repo`);
  const repository = await resolveToolRepository(vcs, state, split.repoPath);
  const file = await vcs.readFile({
    state,
    repositoryId: repository.repositoryId,
    file: { kind: "path", path: split.repoRelPath },
  });
  if (!file || !file.repositoryId || !file.fileId) return null;
  return {
    state,
    repositoryId: file.repositoryId,
    repoPath: file.repoPath,
    fileId: file.fileId,
    path: file.path,
    contentHash: file.contentHash,
    mode: file.mode,
    content: file.content,
  };
}

function stateNodeLabel(state: VcsStateNodeRef): string {
  return state.kind === "event" ? state.eventId : state.applicationId;
}

export function createToolVcs(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>
): ToolVcs {
  return createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, args)
  );
}
