/** Atomic multi-file mutation tool over the semantic workspace VCS. */

import { Buffer } from "node:buffer";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { VcsEditChange, VcsWorkingMutationResult } from "@vibestudio/service-schemas/vcs";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { resolveToolFileInRepository, resolveToolRepository } from "../semantic-file-resolution.js";
import { differingTextEdits, generateDiffString } from "./edit-diff.js";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolEditingVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const expectedHash = Type.Optional(
  Type.String({
    pattern: "^[0-9a-f]{64}$",
    description: "Expected current content hash. Supply it to reject stale edits.",
  })
);
const mode = Type.Optional(
  Type.Integer({
    minimum: 0,
    maximum: 0o777,
    description: "Resulting POSIX permission bits, for example 420 for 0644 or 493 for 0755.",
  })
);
const path = Type.String({
  minLength: 1,
  description: "Managed workspace file path inside an existing repository.",
});

const patchOperationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("replace"),
      path,
      expectedHash,
      mode,
      replacements: Type.Array(
        Type.Object(
          {
            oldText: Type.String({ minLength: 1 }),
            newText: Type.String(),
          },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: 1_000 }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("write"),
      path,
      expectedHash,
      mode,
      content: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("write_binary"),
      path,
      expectedHash,
      mode,
      base64: Type.String({ description: "Complete file bytes encoded as canonical base64." }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("delete"), path, expectedHash },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("chmod"),
      path,
      expectedHash,
      mode: Type.Integer({ minimum: 0, maximum: 0o777 }),
    },
    { additionalProperties: false }
  ),
]);

const applyPatchSchema = Type.Object(
  {
    operations: Type.Array(patchOperationSchema, { minItems: 1, maxItems: 200 }),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Purpose when it is not already clear from the request.",
      })
    ),
  },
  { additionalProperties: false }
);

export type ApplyPatchOperation =
  | {
      kind: "replace";
      path: string;
      expectedHash?: string;
      mode?: number;
      replacements: Array<{ oldText: string; newText: string }>;
    }
  | { kind: "write"; path: string; expectedHash?: string; mode?: number; content: string }
  | {
      kind: "write_binary";
      path: string;
      expectedHash?: string;
      mode?: number;
      base64: string;
    }
  | { kind: "delete"; path: string; expectedHash?: string }
  | { kind: "chmod"; path: string; expectedHash?: string; mode: number };

export interface ApplyPatchToolInput {
  operations: ApplyPatchOperation[];
  intent?: string;
}

export interface ApplyPatchToolDetails {
  status: "applied" | "unchanged";
  paths: string[];
  diff: string;
  vcsResult?: VcsWorkingMutationResult;
}

function patchFailure(code: string, message: string, data: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, errorData: { code, message, ...data } });
}

function assertExpectedHash(
  operation: ApplyPatchOperation,
  actual: string | undefined,
  canonicalPath: string
): void {
  if (!operation.expectedHash) return;
  if (actual === operation.expectedHash) return;
  throw patchFailure("PatchPreconditionFailed", `Stale content at ${canonicalPath}`, {
    path: canonicalPath,
    expectedHash: operation.expectedHash,
    actualHash: actual ?? null,
  });
}

function canonicalBase64(value: string, canonicalPath: string): string {
  const bytes = Buffer.from(value, "base64");
  const normalized = bytes.toString("base64");
  if (value.replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) {
    throw patchFailure("InvalidPatch", `Invalid base64 content for ${canonicalPath}`, {
      path: canonicalPath,
    });
  }
  return normalized;
}

function replaceExactly(
  content: string,
  replacements: Array<{ oldText: string; newText: string }>,
  canonicalPath: string
): string {
  let next = content;
  for (const [index, replacement] of replacements.entries()) {
    const first = next.indexOf(replacement.oldText);
    if (first < 0) {
      throw patchFailure(
        "PatchPreconditionFailed",
        `Replacement ${index + 1} was not found in ${canonicalPath}`,
        { path: canonicalPath, replacement: index + 1, reason: "not-found" }
      );
    }
    if (next.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw patchFailure(
        "PatchPreconditionFailed",
        `Replacement ${index + 1} is ambiguous in ${canonicalPath}`,
        { path: canonicalPath, replacement: index + 1, reason: "ambiguous" }
      );
    }
    next =
      next.slice(0, first) + replacement.newText + next.slice(first + replacement.oldText.length);
  }
  return next;
}

export function createApplyPatchTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext
): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Atomically mutate one or more managed workspace files in a single semantic work unit. Supports exact multi-replacement edits, whole text or binary writes, deletion, and mode changes. Each path may appear once. Use expectedHash from read/provenance when stale-write protection matters. Operations are all validated before anything changes; move_file and copy_file remain the identity-preserving structural tools.",
    parameters: applyPatchSchema,
    execute: async (
      _toolCallId,
      rawInput,
      signal
    ): Promise<AgentToolResult<ApplyPatchToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const input = rawInput as ApplyPatchToolInput;
      const workingHead = await resolveToolWorkingState(vcs, context);
      const seen = new Set<string>();
      const resolved = await Promise.all(
        input.operations.map(async (operation) => {
          const canonicalPath = canonicalizeWorkspaceFilePath(toVcsPath(operation.path, cwd));
          if (seen.has(canonicalPath)) {
            throw patchFailure("InvalidPatch", `Patch contains ${canonicalPath} more than once`, {
              path: canonicalPath,
            });
          }
          seen.add(canonicalPath);
          const route = splitRepoPath(canonicalPath);
          if (!route?.repoRelPath) {
            throw patchFailure(
              "InvalidPatch",
              `${canonicalPath} is not a managed file inside a workspace repository`,
              { path: canonicalPath }
            );
          }
          const repository = await resolveToolRepository(vcs, workingHead, route.repoPath);
          const file = await resolveToolFileInRepository(
            vcs,
            workingHead,
            repository,
            route.repoRelPath
          );
          assertExpectedHash(operation, file?.contentHash, canonicalPath);
          return { operation, canonicalPath, route, repository, file };
        })
      );
      if (signal?.aborted) throw new Error("Operation aborted");

      const changes: VcsEditChange[] = [];
      const diffs: string[] = [];
      for (const item of resolved) {
        const { operation, canonicalPath, route, repository, file } = item;
        if (operation.kind === "replace") {
          if (!file) {
            throw patchFailure(
              "PatchPreconditionFailed",
              `Cannot replace missing ${canonicalPath}`,
              {
                path: canonicalPath,
                reason: "missing-file",
              }
            );
          }
          if (file.content.kind !== "text") {
            throw patchFailure(
              "PatchPreconditionFailed",
              `Cannot text-edit binary ${canonicalPath}`,
              {
                path: canonicalPath,
                reason: "binary-file",
              }
            );
          }
          const next = replaceExactly(file.content.text, operation.replacements, canonicalPath);
          if (next !== file.content.text) {
            changes.push({
              kind: "text-edit",
              repositoryId: file.repositoryId,
              fileId: file.fileId,
              edits: differingTextEdits(file.content.text, next),
              ...(operation.mode !== undefined && operation.mode !== file.mode
                ? { mode: operation.mode }
                : {}),
            });
            diffs.push(`--- ${canonicalPath}\n${generateDiffString(file.content.text, next).diff}`);
          }
          if (
            next === file.content.text &&
            operation.mode !== undefined &&
            operation.mode !== file.mode
          ) {
            changes.push({
              kind: "file-mode",
              repositoryId: file.repositoryId,
              fileId: file.fileId,
              mode: operation.mode,
            });
          }
          continue;
        }
        if (operation.kind === "write" || operation.kind === "write_binary") {
          const content =
            operation.kind === "write"
              ? ({ kind: "text", text: operation.content } as const)
              : ({
                  kind: "bytes",
                  base64: canonicalBase64(operation.base64, canonicalPath),
                } as const);
          if (!file) {
            changes.push({
              kind: "file-create",
              repositoryId: repository.repositoryId,
              path: route.repoRelPath,
              content,
              mode: operation.mode ?? 0o644,
            });
          } else {
            const sameContent =
              file.content.kind === content.kind &&
              (content.kind === "text"
                ? file.content.kind === "text" && file.content.text === content.text
                : file.content.kind === "bytes" && file.content.base64 === content.base64);
            if (!sameContent) {
              changes.push(
                content.kind === "text" && file.content.kind === "text"
                  ? {
                      kind: "text-edit",
                      repositoryId: file.repositoryId,
                      fileId: file.fileId,
                      edits: differingTextEdits(file.content.text, content.text),
                      ...(operation.mode !== undefined && operation.mode !== file.mode
                        ? { mode: operation.mode }
                        : {}),
                    }
                  : {
                      kind: "binary-replace",
                      repositoryId: file.repositoryId,
                      fileId: file.fileId,
                      base64:
                        content.kind === "text"
                          ? Buffer.from(content.text, "utf8").toString("base64")
                          : content.base64,
                      ...(operation.mode !== undefined && operation.mode !== file.mode
                        ? { mode: operation.mode }
                        : {}),
                    }
              );
              if (content.kind === "text" && file.content.kind === "text") {
                diffs.push(
                  `--- ${canonicalPath}\n${generateDiffString(file.content.text, content.text).diff}`
                );
              }
            }
            if (sameContent && operation.mode !== undefined && operation.mode !== file.mode) {
              changes.push({
                kind: "file-mode",
                repositoryId: file.repositoryId,
                fileId: file.fileId,
                mode: operation.mode,
              });
            }
          }
          continue;
        }
        if (!file) {
          throw patchFailure("PatchPreconditionFailed", `${canonicalPath} does not exist`, {
            path: canonicalPath,
            reason: "missing-file",
          });
        }
        if (operation.kind === "delete") {
          changes.push({
            kind: "file-delete",
            repositoryId: file.repositoryId,
            fileId: file.fileId,
          });
        } else if (operation.mode !== file.mode) {
          changes.push({
            kind: "file-mode",
            repositoryId: file.repositoryId,
            fileId: file.fileId,
            mode: operation.mode,
          });
        }
      }

      if (changes.length === 0) {
        return {
          content: [{ type: "text", text: "Patch already matches the working state." }],
          details: { status: "unchanged", paths: [...seen], diff: diffs.join("\n") },
        };
      }
      const vcsResult = await vcs.edit({
        contextId: toolContextId(context),
        expectedWorkingHead: workingHead,
        commandId: toolCommandId(context),
        ...(input.intent?.trim() ? { intentSummary: input.intent.trim() } : {}),
        changes,
      });
      return {
        content: [
          {
            type: "text",
            text: `Applied ${changes.length} atomic semantic change${changes.length === 1 ? "" : "s"} across ${seen.size} file${seen.size === 1 ? "" : "s"}.`,
          },
        ],
        details: {
          status: "applied",
          paths: [...seen],
          diff: diffs.join("\n"),
          vcsResult,
        },
      };
    },
  };
}
