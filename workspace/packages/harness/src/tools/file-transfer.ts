/** Stable-identity file move/copy tools over the canonical VCS commands. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import {
  resolveToolFile,
  resolveToolRepository,
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolFileResolution,
  type ToolFileTransferVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const fileTransferSchema = Type.Object(
  {
    source: Type.String({ description: "Current workspace path of the managed source file." }),
    destination: Type.String({
      description: "Unoccupied destination path inside a managed workspace repository.",
    }),
    intentSummary: Type.Optional(
      Type.String({ minLength: 1, description: "Optional semantic reason for the move or copy." })
    ),
  },
  { additionalProperties: false }
);

export type FileTransferToolInput = Static<typeof fileTransferSchema>;

interface FileDetails {
  repositoryId: string;
  fileId: string;
  repoPath: string;
  path: string;
  state: VcsStateNodeRef;
}

export interface FileTransferToolDetails {
  operation: "moved" | "copied";
  source: FileDetails;
  destination: FileDetails;
  commandId: string;
  workUnitId: string;
  applicationId: string;
  changeId: string;
}

function missingSource(operation: "move_file" | "copy_file", path: string): NodeJS.ErrnoException {
  const error = new Error(`${operation}: source file not found: ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = path;
  error.syscall = operation;
  return error;
}

function details(file: ToolFileResolution): FileDetails {
  return {
    repositoryId: file.repositoryId,
    fileId: file.fileId,
    repoPath: file.repoPath,
    path: file.path,
    state: file.state,
  };
}

function createFileTransferTool(
  kind: "move" | "copy",
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext
): AgentTool<typeof fileTransferSchema, FileTransferToolDetails> {
  const operation = kind === "move" ? "move_file" : "copy_file";
  return {
    name: operation,
    label: operation,
    description:
      kind === "move"
        ? "Move one managed file atomically while preserving its stable file identity and history. Never emulate this with write/delete."
        : "Copy one managed file atomically, minting a distinct file identity with explicit copy provenance. Never emulate this with read/write.",
    parameters: fileTransferSchema,
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<FileTransferToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (typeof input.source !== "string" || typeof input.destination !== "string") {
        throw new Error(`${operation} requires source and destination paths`);
      }
      const sourcePath = canonicalizeWorkspaceFilePath(toVcsPath(input.source, cwd));
      const destinationPath = canonicalizeWorkspaceFilePath(toVcsPath(input.destination, cwd));
      const destinationRoute = splitRepoPath(destinationPath);
      if (!destinationRoute?.repoRelPath) {
        throw new Error(`${input.destination} is not a file in a managed workspace repository`);
      }

      const workingHead = await resolveToolWorkingState(vcs, context);
      const [source, destinationRepository] = await Promise.all([
        resolveToolFile(vcs, workingHead, sourcePath),
        resolveToolRepository(vcs, workingHead, destinationRoute.repoPath),
      ]);
      if (!source) throw missingSource(operation, input.source);
      if (signal?.aborted) throw new Error("Operation aborted");

      const commandId = toolCommandId(context);
      const destination = {
        repositoryId: destinationRepository.repositoryId,
        path: destinationRoute.repoRelPath,
      };
      const intentSummary =
        input.intentSummary?.trim() ||
        `${kind === "move" ? "Move" : "Copy"} ${sourcePath} to ${destinationPath}`;
      const result =
        kind === "move"
          ? await vcs.move({
              contextId: toolContextId(context),
              expectedWorkingHead: workingHead,
              commandId,
              intentSummary,
              moves: [
                {
                  kind: "file",
                  repositoryId: source.repositoryId,
                  fileId: source.fileId,
                  destinationRepositoryId: destination.repositoryId,
                  destinationPath: destination.path,
                },
              ],
            })
          : await vcs.copy({
              contextId: toolContextId(context),
              expectedWorkingHead: workingHead,
              commandId,
              intentSummary,
              copies: [
                {
                  source: {
                    state: source.state,
                    repositoryId: source.repositoryId,
                    fileId: source.fileId,
                  },
                  destination,
                },
              ],
            });
      if (signal?.aborted) throw new Error("Operation aborted");

      const produced = await resolveToolFile(vcs, result.workingHead, destinationPath);
      if (!produced) throw new Error(`${operation} did not produce ${destinationPath}`);
      const changeId = result.changeIds[0];
      if (!changeId) throw new Error(`${operation} returned no semantic change`);

      return {
        content: [
          {
            type: "text",
            text:
              `${kind === "move" ? "Moved" : "Copied"} ${sourcePath} to ${destinationPath}. ` +
              `${kind === "move" ? "Preserved" : "Minted"} file identity ${produced.fileId}; ` +
              `semantic change ${changeId}.`,
          },
        ],
        details: {
          operation: kind === "move" ? "moved" : "copied",
          source: details(source),
          destination: details(produced),
          commandId,
          workUnitId: result.workUnitId,
          applicationId: result.applicationId,
          changeId,
        },
      };
    },
  };
}

export function createMoveFileTool(
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext
) {
  return createFileTransferTool("move", cwd, vcs, context);
}

export function createCopyFileTool(
  cwd: string,
  vcs: ToolFileTransferVcs,
  context: ToolMutationContext
) {
  return createFileTransferTool("copy", cwd, vcs, context);
}
