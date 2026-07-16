/** Compact agent workflow over the canonical semantic VCS methods. */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type {
  VcsCompareResult,
  VcsDiscardResult,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import {
  resolveToolFile,
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const evidenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("file-content"),
      fileId: Type.String(),
      contentHash: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("file-placement"),
      fileId: Type.String(),
      repositoryId: Type.String(),
      path: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("file-absent"), fileId: Type.String() },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("repository-present"),
      repositoryId: Type.String(),
      repoPath: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("repository-absent"), repositoryId: Type.String() },
    { additionalProperties: false }
  ),
]);

const workspaceVcsSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("compare"),
      sourceEventId: Type.String({ minLength: 1 }),
      view: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("changes")])),
      disposition: Type.Optional(
        Type.Union([
          Type.Literal("shared"),
          Type.Literal("already-satisfied"),
          Type.Literal("actionable"),
          Type.Literal("accounted"),
          Type.Literal("historical"),
        ])
      ),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("integrate"),
      sourceEventId: Type.String({ minLength: 1 }),
      decision: Type.Union([
        Type.Object(
          {
            kind: Type.Literal("adopted"),
            sourceChangeIds: Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: 200,
            }),
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            kind: Type.Literal("reconciled"),
            sourceChangeIds: Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: 200,
            }),
            evidence: Type.Array(evidenceSchema, { minItems: 1, maxItems: 200 }),
            rationale: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            kind: Type.Literal("declined"),
            sourceChangeIds: Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: 200,
            }),
            rationale: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false }
        ),
      ]),
      intentSummary: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("revert"),
      changeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }),
      intentSummary: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("discard") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("blame"),
      path: Type.String({ minLength: 1 }),
      start: Type.Optional(Type.Integer({ minimum: 0 })),
      end: Type.Optional(Type.Integer({ minimum: 0 })),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("push") }, { additionalProperties: false }),
]);

export type WorkspaceVcsToolInput =
  | { operation: "status" }
  | {
      operation: "compare";
      sourceEventId: string;
      view?: "overview" | "changes";
      disposition?: "shared" | "already-satisfied" | "actionable" | "accounted" | "historical";
      after?: string;
      limit?: number;
    }
  | {
      operation: "integrate";
      sourceEventId: string;
      decision: VcsIntegrationDecisionInput;
      intentSummary?: string;
    }
  | { operation: "revert"; changeIds: string[]; intentSummary?: string }
  | { operation: "discard" }
  | {
      operation: "blame";
      path: string;
      start?: number;
      end?: number;
      after?: string;
      limit?: number;
    }
  | { operation: "push" };

export interface WorkspaceVcsToolDetails {
  operation: WorkspaceVcsToolInput["operation"];
  result: unknown;
}

export type ToolWorkflowVcs = Pick<
  ToolVcs,
  | "status"
  | "compare"
  | "integrate"
  | "revert"
  | "discard"
  | "blame"
  | "push"
  | "resolveRepository"
  | "readFile"
>;

function compareText(result: VcsCompareResult): string {
  const counts = result.counts;
  const lines = [
    `Compared ${result.sourceEventId} with the current working state: ` +
      `${counts.actionable} actionable (${counts.conflicting} conflicting, ${counts.blocked} blocked), ` +
      `${counts.accounted} accounted, ${counts.shared} shared, ` +
      `${counts.alreadySatisfied} already satisfied, ${counts.historical} historical.`,
  ];
  for (const change of result.changes) {
    const applicability =
      change.disposition.status === "actionable" ? `/${change.disposition.applicability}` : "";
    const accounting =
      change.disposition.status === "accounted"
        ? ` · decisions ${change.disposition.decisionIds.join(", ")}`
        : "";
    lines.push(
      `${change.changeId} · ${change.kind} · ${change.disposition.status}${applicability}${accounting} · ${change.summary}`
    );
  }
  if (result.nextCursor) lines.push(`More changes: rerun compare with after=${result.nextCursor}`);
  return lines.join("\n");
}

function mutationText(verb: string, result: VcsWorkingMutationResult): string {
  return (
    `${verb} in ${result.applicationId}; work unit ${result.workUnitId}; ` +
    `${result.changeCount} authored and ${result.incorporatedChangeCount} incorporated changes ` +
    `(${result.changeIds.length} authored and ${result.incorporatedChangeIds.length} incorporated in preview).` +
    (result.changeIds.length > 0 ? ` Authored changes: ${result.changeIds.join(", ")}.` : "") +
    (result.incorporatedChangeIds.length > 0
      ? ` Incorporated changes: ${result.incorporatedChangeIds.join(", ")}.`
      : "")
  );
}

export function createWorkspaceVcsTool(
  cwd: string,
  vcs: ToolWorkflowVcs,
  context: ToolMutationContext
): AgentTool<typeof workspaceVcsSchema, WorkspaceVcsToolDetails> {
  return {
    name: "vcs",
    label: "vcs",
    description:
      "Orient, compare, incrementally integrate, revert, discard, blame, or push the semantic workspace. Edits/moves/copies and commit have dedicated tools.",
    parameters: workspaceVcsSchema,
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<WorkspaceVcsToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const contextId = toolContextId(context);
      // AgentTool invokes execute only after validating the TypeBox union.
      const command = input as WorkspaceVcsToolInput;

      if (command.operation === "status") {
        const result = await vcs.status({ contextId });
        return resultOf(
          command.operation,
          `Context ${contextId} is ${result.clean ? "clean" : "dirty"}; ` +
            `${result.mainRelation} main at ${result.mainEventId}; committed ${stateLabel(result.committed)}; ` +
            `working ${stateLabel(result.workingHead)} (${result.workingCounts.applications} applications, ` +
            `${result.workingCounts.changes} changes).`,
          result
        );
      }

      if (command.operation === "compare") {
        const target = await resolveToolWorkingState(vcs, context);
        const result = await vcs.compare({
          target,
          sourceEventId: command.sourceEventId,
          view: command.view ?? "changes",
          ...(command.disposition ? { disposition: command.disposition } : {}),
          ...(command.after ? { cursor: command.after } : {}),
          limit: command.limit ?? 100,
        });
        return resultOf(command.operation, compareText(result), result);
      }

      if (command.operation === "integrate") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result = await vcs.integrate({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
          sourceEventId: command.sourceEventId,
          decision: command.decision,
          ...(command.intentSummary ? { intentSummary: command.intentSummary } : {}),
        });
        return resultOf(
          command.operation,
          `${mutationText("Integrated one local step", result)} Decision ${result.decisionId}.`,
          result
        );
      }

      if (command.operation === "revert") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result = await vcs.revert({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
          changeIds: command.changeIds,
          ...(command.intentSummary ? { intentSummary: command.intentSummary } : {}),
        });
        return resultOf(
          command.operation,
          mutationText("Reverted semantic changes", result),
          result
        );
      }

      if (command.operation === "discard") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result: VcsDiscardResult = await vcs.discard({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
        });
        return resultOf(
          command.operation,
          `Discarded ${result.discardedApplicationIds.length} local application${result.discardedApplicationIds.length === 1 ? "" : "s"}; working state is now ${stateLabel(result.workingHead)}.`,
          result
        );
      }

      if (command.operation === "blame") {
        const state = await resolveToolWorkingState(vcs, context);
        const workspacePath = toVcsPath(command.path, cwd);
        const file = await resolveToolFile(vcs, state, workspacePath);
        if (!file) throw new Error(`No managed file at ${command.path}`);
        const contentLength =
          file.content.kind === "text"
            ? file.content.text.length
            : Buffer.from(file.content.base64, "base64").byteLength;
        const start = command.start ?? 0;
        const end = command.end ?? contentLength;
        if (end < start || end > contentLength) {
          throw new Error(`blame range ${start}..${end} is outside 0..${contentLength}`);
        }
        const result = await vcs.blame({
          state,
          repositoryId: file.repositoryId,
          fileId: file.fileId,
          range: { start, end },
          ...(command.after ? { cursor: command.after } : {}),
          limit: command.limit ?? 100,
        });
        const lines = result.spans.map(
          (span) =>
            `${span.start}..${span.end} · ${span.stop} · change ${span.changeId ?? "unknown"} · ` +
            `work ${span.workUnitId ?? "unknown"} · command ${span.commandId ?? "unknown"}` +
            (span.stop === "import-boundary" && span.changeId && span.workUnitId
              ? ` · inspect terminal change ${span.changeId}, then owning import work unit ${span.workUnitId} for the exact external snapshot; earlier coordinate authorship is unknown`
              : "")
        );
        if (result.nextCursor)
          lines.push(`More spans: rerun blame with after=${result.nextCursor}`);
        return resultOf(
          command.operation,
          lines.join("\n") || `No blame spans for ${workspacePath}`,
          result
        );
      }

      const status = await vcs.status({ contextId });
      if (status.committed.kind !== "event") throw new Error("Committed state is not an event");
      const result = await vcs.push({
        commandId: toolCommandId(context),
        contextId,
        expectedCommittedEventId: status.committed.eventId,
        expectedMainEventId: status.mainEventId,
      });
      return resultOf(
        command.operation,
        `Published ${result.eventId} as protected main ${result.mainEventId}.`,
        result
      );
    },
  };
}

type VcsIntegrationDecisionInput = Parameters<ToolVcs["integrate"]>[0]["decision"];

function stateLabel(
  state: { kind: "event"; eventId: string } | { kind: "application"; applicationId: string }
) {
  return state.kind === "event" ? state.eventId : state.applicationId;
}

function resultOf(
  operation: WorkspaceVcsToolInput["operation"],
  text: string,
  result: unknown
): AgentToolResult<WorkspaceVcsToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { operation, result },
  };
}
