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
  resolveToolRepository,
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const agentEvidenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("file-content"),
      path: Type.String({
        minLength: 1,
        description:
          "Workspace file path whose exact current file identity and content hash are evidence.",
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("file-placement"),
      path: Type.String({
        minLength: 1,
        description:
          "Workspace file path whose exact current file identity, repository, and placement are evidence.",
      }),
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
      path: Type.String({
        minLength: 1,
        description:
          "Workspace repository path whose exact current identity and placement are evidence.",
      }),
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
            evidence: Type.Array(agentEvidenceSchema, {
              minItems: 1,
              maxItems: 200,
              description:
                "Exact target-state evidence. Prefer path-based file-content, file-placement, or repository-present entries; the tool resolves their stable identities at the current working state.",
            }),
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
      start: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
      end: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Exclusive zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
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
      decision: AgentIntegrationDecisionInput;
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
    result.resolution.complete
      ? "Integration resolution is complete; no source changes still require a decision."
      : `Integration resolution is incomplete; ${result.resolution.remainingChangeCount} source change${result.resolution.remainingChangeCount === 1 ? "" : "s"} still require a decision.`,
    `Compared ${result.sourceEventId} with the current working state: ` +
      `${counts.actionable} actionable (${counts.conflicting} conflicting, ${counts.blocked} blocked), ` +
      `${counts.accounted} resolved by decision, ${counts.shared} shared, ` +
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
        const decision = await resolveAgentIntegrationDecision(
          vcs,
          expectedWorkingHead,
          cwd,
          command.decision
        );
        const result = await vcs.integrate({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
          sourceEventId: command.sourceEventId,
          decision,
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
            `${span.start}..${span.end} · ${span.stop} · ` +
            `change ${JSON.stringify(span.change)} · applied change ${JSON.stringify(span.appliedChange)} · ` +
            `work ${JSON.stringify(span.workUnit)} · command ${JSON.stringify(span.command)}` +
            (span.stop === "import-boundary"
              ? ` · pass these typed roots unchanged to provenance: inspect terminal change ${JSON.stringify(span.change)}, then owning import work unit ${JSON.stringify(span.workUnit)} for the exact external snapshot; earlier coordinate authorship is unknown`
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

      if (command.operation !== "push") {
        throw new Error("Unsupported vcs operation");
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

type AgentIntegrationEvidence =
  | { kind: "file-content"; path: string }
  | { kind: "file-placement"; path: string }
  | { kind: "file-absent"; fileId: string }
  | { kind: "repository-present"; path: string }
  | { kind: "repository-absent"; repositoryId: string };

type AgentIntegrationDecisionInput =
  | Extract<VcsIntegrationDecisionInput, { kind: "adopted" | "declined" }>
  | {
      kind: "reconciled";
      sourceChangeIds: string[];
      evidence: AgentIntegrationEvidence[];
      rationale: string;
    };

async function resolveAgentIntegrationDecision(
  vcs: Pick<ToolVcs, "resolveRepository" | "readFile">,
  state: Parameters<typeof resolveToolFile>[1],
  cwd: string,
  decision: AgentIntegrationDecisionInput
): Promise<VcsIntegrationDecisionInput> {
  if (decision.kind !== "reconciled") return decision;
  const evidence: Extract<VcsIntegrationDecisionInput, { kind: "reconciled" }>["evidence"] = [];
  for (const item of decision.evidence) {
    if (item.kind === "file-content" || item.kind === "file-placement") {
      const path = toVcsPath(item.path, cwd);
      const file = await resolveToolFile(vcs, state, path);
      if (!file) throw new Error(`No managed file at ${item.path}`);
      evidence.push(
        item.kind === "file-content"
          ? { kind: item.kind, fileId: file.fileId, contentHash: file.contentHash }
          : {
              kind: item.kind,
              fileId: file.fileId,
              repositoryId: file.repositoryId,
              path: file.path,
            }
      );
      continue;
    }
    if (item.kind === "repository-present") {
      const repoPath = toVcsPath(item.path, cwd);
      const repository = await resolveToolRepository(vcs, state, repoPath);
      evidence.push({
        kind: item.kind,
        repositoryId: repository.repositoryId,
        repoPath: repository.repoPath,
      });
      continue;
    }
    evidence.push(item);
  }
  return { ...decision, evidence };
}

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
