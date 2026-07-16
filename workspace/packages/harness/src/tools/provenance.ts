/** Friendly graph-walking tool over the canonical `vcs.neighbors` primitive. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import { vcsSemanticNodeRefSchema, type VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { ToolVcs } from "./tool-vcs.js";
import { resolveToolFile, resolveToolWorkingState, toVcsPath } from "./tool-vcs.js";
import {
  renderProvenanceBlock,
  type CanonicalProvenanceHistory,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
} from "./provenance-format.js";

const provenanceSchema = Type.Object({
  target: Type.Optional(
    Type.String({
      description:
        'Friendly workspace file path, "session", or semantic shorthand such as "applied-change:...", "change:...", or "decision:...". Omit when root is supplied.',
    })
  ),
  root: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Exact typed semantic root returned by inspect.root, neighbors.root, provenance details, or either endpoint of a returned edge.",
    })
  ),
  after: Type.Optional(Type.String({ description: "Stable neighbor-page cursor." })),
});

export type ProvenanceToolInput = Static<typeof provenanceSchema>;
export interface ProvenanceToolDetails {
  target: string;
  root: VcsSemanticNodeRef;
  node: CanonicalProvenanceInspection["node"];
  adjacency: CanonicalProvenanceResult["edges"];
  history?: CanonicalProvenanceHistory["entries"];
  historyNextCursor?: string;
  edges: number;
  nextCursor?: string;
}

export interface WorkspacePathProvenanceDeps {
  vcs: Pick<ToolVcs, "status" | "resolveRepository" | "neighbors" | "inspect" | "readFile">;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

export interface ProvenanceToolDeps {
  vcs: Pick<
    ToolVcs,
    "status" | "resolveRepository" | "neighbors" | "inspect" | "readFile" | "history"
  >;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

function contextIdOf(deps: WorkspacePathProvenanceDeps): string {
  return typeof deps.contextId === "function" ? deps.contextId() : deps.contextId;
}

function semanticRootForTarget(
  target: string,
  session: WorkspacePathProvenanceDeps["session"]
): VcsSemanticNodeRef {
  if (target.startsWith("event:")) return { kind: "event", eventId: target };
  if (target.startsWith("application:")) return { kind: "application", applicationId: target };
  if (target.startsWith("applied-change:")) {
    return { kind: "applied-change", appliedChangeId: target };
  }
  if (target.startsWith("work-unit:")) return { kind: "work-unit", workUnitId: target };
  if (target.startsWith("change:")) return { kind: "change", changeId: target };
  if (target.startsWith("decision:")) return { kind: "decision", decisionId: target };
  if (target.startsWith("command:")) return { kind: "command", commandId: target };
  if (target === "session") return { kind: "trajectory", ...session };
  throw new Error(
    `Provenance target must be a workspace path, session, or event/application/applied-change/work-unit/change/decision/command identity; received ${target}`
  );
}

function parseRoot(input: unknown): VcsSemanticNodeRef {
  const parsed = vcsSemanticNodeRefSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid typed semantic root: ${parsed.error.issues[0]?.message ?? "unknown"}`);
}

function rootLabel(root: VcsSemanticNodeRef): string {
  switch (root.kind) {
    case "event":
      return root.eventId;
    case "application":
      return root.applicationId;
    case "applied-change":
      return root.appliedChangeId;
    case "work-unit":
      return root.workUnitId;
    case "change":
      return root.changeId;
    case "decision":
      return root.decisionId;
    case "command":
      return root.commandId;
    case "file":
      return `${root.repositoryId}/${root.fileId}`;
    case "repository":
      return root.repositoryId;
    case "trajectory":
      return `${root.logId}@${root.head}`;
    case "trajectory-invocation":
      return `${root.invocationId} @ ${root.logId}@${root.head}`;
    case "trajectory-turn":
      return `${root.turnId} @ ${root.logId}@${root.head}`;
    case "trajectory-message":
      return `${root.messageId} @ ${root.logId}@${root.head}`;
  }
}

export async function neighborsForWorkspacePath(
  cwd: string,
  deps: WorkspacePathProvenanceDeps,
  rawPath: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{
  label: string;
  root: Extract<VcsSemanticNodeRef, { kind: "file" }>;
  result: CanonicalProvenanceResult;
}> {
  const workspacePath = toVcsPath(rawPath, cwd);
  const workingHead = await resolveToolWorkingState(deps.vcs, {
    contextId: () => contextIdOf(deps),
  });
  const file = await resolveToolFile(deps.vcs, workingHead, workspacePath);
  if (!file) throw new Error(`No file identity at ${workspacePath} in the working state`);
  const root: Extract<VcsSemanticNodeRef, { kind: "file" }> = {
    kind: "file",
    state: workingHead,
    repositoryId: file.repositoryId,
    fileId: file.fileId,
  };
  const result = await deps.vcs.neighbors({
    root,
    limit: options.limit ?? 10,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return { label: workspacePath, root, result };
}

function toolResult(
  target: string,
  inspection: CanonicalProvenanceInspection,
  result: CanonicalProvenanceResult,
  history: CanonicalProvenanceHistory | undefined,
  continuation: NonNullable<Parameters<typeof renderProvenanceBlock>[0]["continuation"]>
) {
  const details: ProvenanceToolDetails = {
    target,
    root: inspection.root,
    node: inspection.node,
    adjacency: result.edges,
    ...(history
      ? {
          history: history.entries,
          ...(history.nextCursor ? { historyNextCursor: history.nextCursor } : {}),
        }
      : {}),
    edges: result.edges.length,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
  return {
    content: [
      {
        type: "text" as const,
        text:
          renderProvenanceBlock({ label: target, inspection, history, result, continuation }) ??
          `prov · ${target} · unavailable`,
      },
    ],
    details,
  };
}

export function createProvenanceTool(
  cwd: string,
  deps: ProvenanceToolDeps
): AgentTool<typeof provenanceSchema, ProvenanceToolDetails> {
  return {
    name: "provenance",
    label: "provenance",
    description:
      "Inspect a semantic node and walk one bounded adjacency page; managed files also include a small exact change-history preview.",
    parameters: provenanceSchema,
    execute: async (_toolCallId, input) => {
      if (input.root && input.target) throw new Error("provenance accepts either root or target");
      const cursor = typeof input.after === "string" && input.after ? input.after : undefined;
      const target = String(input.target ?? "session").trim() || "session";
      if (input.root) {
        const root = parseRoot(input.root);
        const [inspection, neighbors, history] = await Promise.all([
          deps.vcs.inspect({ node: root, edgeLimit: 1 }),
          deps.vcs.neighbors({ root, limit: 20, ...(cursor ? { cursor } : {}) }),
          root.kind === "file"
            ? deps.vcs.history({ root, direction: "past", limit: 5 })
            : Promise.resolve(undefined),
        ]);
        return toolResult(rootLabel(root), inspection, neighbors, history, {
          kind: "root",
          root,
          includeCursor: true,
        });
      }
      const path = target.startsWith("file:") ? target.slice(5) : target;
      if (splitRepoPath(path)) {
        const page = await neighborsForWorkspacePath(cwd, deps, path, { cursor, limit: 20 });
        const [inspection, history] = await Promise.all([
          deps.vcs.inspect({ node: page.root, edgeLimit: 1 }),
          deps.vcs.history({ root: page.root, direction: "past", limit: 5 }),
        ]);
        return toolResult(page.label, inspection, page.result, history, {
          kind: "target",
          target: page.label,
          includeCursor: true,
        });
      }
      const root = semanticRootForTarget(target, deps.session);
      const [inspection, neighbors] = await Promise.all([
        deps.vcs.inspect({ node: root, edgeLimit: 1 }),
        deps.vcs.neighbors({ root, limit: 20, ...(cursor ? { cursor } : {}) }),
      ]);
      return toolResult(target, inspection, neighbors, undefined, {
        kind: "root",
        root,
        includeCursor: true,
      });
    },
  };
}
