/** Friendly graph-walking tool over the canonical `vcs.neighbors` primitive. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import { vcsSemanticNodeRefSchema, type VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { ToolVcs } from "./tool-vcs.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import {
  AgentReferenceUnavailableError,
  createMemoryAgentReferenceStore,
  isAgentReference,
  type AgentReferenceStore,
} from "./agent-pagination.js";
import {
  loadProvenanceReference,
  putProvenanceReference,
} from "./provenance-reference.js";
import { resolveToolWorkingState, toVcsPath } from "./tool-vcs.js";
import {
  provenancePageStreams,
  renderProvenanceBlock,
  type CanonicalProvenanceHistory,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
} from "./provenance-format.js";

const ORIENTATION_EDGE_LIMIT = 5;

class InvalidProvenanceTargetError extends Error {}

const provenanceSchema = Type.Object(
  {
    target: Type.Optional(
      Type.String({
        description:
          'Friendly selector used to start a walk: an existing managed file path (not an intermediate directory), exact repository root, "session", or semantic shorthand such as "workspace-event:...", "applied-change:...", "change:...", or "decision:...". A service, tool, package name, or general topic is not a target.',
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Preferred entries per adjacency and file-history page. Values above 20 are safely clamped. Omit it when following a returned reference because the reference retains the page geometry.",
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      "Inspect one subject. Use target for a friendly path or semantic identity, then pass each returned compact @ref back through the same target field. A continuation ref is complete: do not add a cursor or page. Omit target for the current session.",
  }
);

export type ProvenanceToolInput = Static<typeof provenanceSchema>;
export interface ProvenanceToolDetails {
  target: string;
  ref: string;
  subjectKind: VcsSemanticNodeRef["kind"];
  adjacencyCount?: number;
  historyCount?: number;
  limit: number;
  continuations: Array<
    { target: string; kind: "adjacency" | "file-history" }
  >;
}

export interface ProvenanceInvalidTargetDiagnostic {
  diagnostic: "invalid-target";
  target: string;
  acceptedTargets: readonly [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "compact ref returned by provenance",
  ];
}

export type ProvenanceToolDiagnostic = ProvenanceInvalidTargetDiagnostic;

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
  if (target.startsWith("event:") || target.startsWith("workspace-event:")) {
    return { kind: "event", eventId: target };
  }
  if (target.startsWith("application:")) return { kind: "application", applicationId: target };
  if (target.startsWith("applied-change:")) {
    return { kind: "applied-change", appliedChangeId: target };
  }
  if (target.startsWith("work-unit:")) return { kind: "work-unit", workUnitId: target };
  if (target.startsWith("change:")) return { kind: "change", changeId: target };
  if (target.startsWith("decision:")) return { kind: "decision", decisionId: target };
  if (target.startsWith("command:")) return { kind: "command", commandId: target };
  if (target === "session") return { kind: "trajectory", ...session };
  if (target.startsWith("trajectory")) {
    throw new Error(
      "Trajectory subnodes require the compact ref advertised by a preceding provenance result; do not reconstruct their composite identity"
    );
  }
  throw new Error(
    `Provenance target must be a workspace path, session, or event/application/applied-change/work-unit/change/decision/command identity; received ${target}`
  );
}

function invalidTargetResult(target: string, message: string) {
  const acceptedTargets = [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "compact ref returned by provenance",
  ] as const;
  return {
    content: [
      {
        type: "text" as const,
        text: `${message}\nUse "session", an existing managed repository/file path, a semantic identity, or a compact ref returned by provenance. Service and tool names are not provenance targets.`,
      },
    ],
    details: {
      diagnostic: "invalid-target" as const,
      target,
      acceptedTargets,
    },
  };
}

function parseRoot(input: unknown): VcsSemanticNodeRef {
  const parsed = vcsSemanticNodeRefSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid typed semantic root: ${parsed.error.issues[0]?.message ?? "unknown"}`);
}

export async function neighborsForWorkspacePath(
  cwd: string,
  deps: WorkspacePathProvenanceDeps,
  rawPath: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{
  label: string;
  root: Extract<VcsSemanticNodeRef, { kind: "file" | "repository" }>;
  result: CanonicalProvenanceResult;
}> {
  const workspacePath = toVcsPath(rawPath, cwd);
  const workingHead = await resolveToolWorkingState(deps.vcs, {
    contextId: () => contextIdOf(deps),
  });
  const split = splitRepoPath(workspacePath);
  if (!split) throw new Error(`${workspacePath} is not inside a workspace repository`);
  if (!split.repoRelPath) {
    const repository = await deps.vcs.resolveRepository({
      state: workingHead,
      repoPath: split.repoPath,
    });
    if (!repository) {
      throw new InvalidProvenanceTargetError(
        `Repository ${split.repoPath} is not present in the working state`
      );
    }
    const root: Extract<VcsSemanticNodeRef, { kind: "repository" }> = {
      kind: "repository",
      state: workingHead,
      repositoryId: repository.repositoryId,
    };
    const result = await deps.vcs.neighbors({
      root,
      limit: options.limit ?? 10,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return { label: workspacePath, root, result };
  }
  const file = await resolveToolFile(deps.vcs, workingHead, workspacePath);
  if (!file) {
    throw new InvalidProvenanceTargetError(
      `No file identity at ${workspacePath} in the working state. Provenance paths must name an existing managed file or an exact repository root; use ls for intermediate directories.`
    );
  }
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
  root: VcsSemanticNodeRef,
  inspection: CanonicalProvenanceInspection | undefined,
  result: CanonicalProvenanceResult,
  history: CanonicalProvenanceHistory | undefined,
  pages: { adjacency: number; fileHistory: number; limit: number },
  references: AgentReferenceStore
) {
  const streams = provenancePageStreams(pages);
  const ref = putProvenanceReference(references, root, pages.limit);
  const details: ProvenanceToolDetails = {
    target,
    ref,
    subjectKind: root.kind,
    limit: pages.limit,
    ...(streams.adjacency ? { adjacencyCount: result.edges.length } : {}),
    ...(streams.fileHistory && history ? { historyCount: history.entries.length } : {}),
    continuations: [
      ...(streams.adjacency && result.nextCursor
        ? [{
            target: putProvenanceReference(references, root, pages.limit, {
              stream: "adjacency",
              page: pages.adjacency + 1,
              cursor: result.nextCursor,
            }),
            kind: "adjacency" as const,
          }]
        : []),
      ...(streams.fileHistory && history?.nextCursor
        ? [{
            target: putProvenanceReference(references, root, pages.limit, {
              stream: "file-history",
              page: pages.fileHistory + 1,
              cursor: history.nextCursor,
            }),
            kind: "file-history" as const,
          }]
        : []),
    ],
  };
  return {
    content: [
      {
        type: "text" as const,
        text:
          renderProvenanceBlock({
            label: target,
            inspection,
            history,
            result,
            pages,
            reference: (root, continuation) =>
              putProvenanceReference(references, root, pages.limit, continuation),
          }) ?? `prov · ${target} · unavailable`,
      },
    ],
    details,
  };
}

async function loadProvenancePages(
  deps: ProvenanceToolDeps,
  root: VcsSemanticNodeRef,
  pages: { adjacency: number; fileHistory: number; limit: number },
  continuation?: { stream: "adjacency" | "file-history"; cursor: string },
  firstNeighbors?: CanonicalProvenanceResult
): Promise<{
  inspection: CanonicalProvenanceInspection | undefined;
  neighbors: CanonicalProvenanceResult;
  history: CanonicalProvenanceHistory | undefined;
}> {
  const fileRoot = root.kind === "file" ? root : undefined;
  const streams = provenancePageStreams(pages);
  const [inspection, neighbors, history] = await Promise.all([
    streams.inspection
      ? deps.vcs.inspect({ node: root, edgeLimit: 1 })
      : Promise.resolve(undefined),
    streams.adjacency
      ? firstNeighbors
        ? Promise.resolve(firstNeighbors)
        : deps.vcs.neighbors({
            root,
            limit: pages.limit,
            ...(continuation?.stream === "adjacency"
              ? { cursor: continuation.cursor }
              : {}),
          })
      : Promise.resolve({ root, edges: [], nextCursor: null }),
    streams.fileHistory && fileRoot
      ? deps.vcs.history({
          root: fileRoot,
          direction: "past",
          limit: pages.limit,
          ...(continuation?.stream === "file-history"
            ? { cursor: continuation.cursor }
            : {}),
        })
      : Promise.resolve(undefined),
  ]);
  return { inspection, neighbors, history };
}

export function createProvenanceTool(
  cwd: string,
  deps: ProvenanceToolDeps,
  references: AgentReferenceStore = createMemoryAgentReferenceStore()
): AgentTool<typeof provenanceSchema, ProvenanceToolDetails | ProvenanceToolDiagnostic> {
  return {
    name: "provenance",
    label: "provenance",
    executionMode: "parallel",
    description:
      'Inspect "session", a semantic shorthand, an existing managed repository/file path, or a short returned @ref and walk one bounded page. Use the single target field for friendly entry points, graph endpoints, and complete continuation refs. Never add a cursor or page to a returned ref. Exact roots, page geometry, and VCS cursors stay inside trusted code. Service/tool/package names are not targets. Managed files also include a small exact change-history preview.',
    parameters: provenanceSchema,
    execute: async (_toolCallId, input) => {
      const pages = { adjacency: 1, fileHistory: 1, limit: Math.min(input.limit ?? ORIENTATION_EDGE_LIMIT, 20) };
      let targetLabel = "session";
      try {
        const requestedTarget = String(input.target ?? "session").trim() || "session";
        if (isAgentReference(requestedTarget)) {
          const basis = loadProvenanceReference(references, requestedTarget);
          const root = parseRoot(basis.root);
          pages.limit = basis.limit;
          if (basis.stream === "adjacency" && basis.page) pages.adjacency = basis.page;
          if (basis.stream === "file-history" && basis.page) pages.fileHistory = basis.page;
          targetLabel = requestedTarget;
          const loaded = await loadProvenancePages(
            deps,
            root,
            pages,
            basis.stream && basis.cursor
              ? { stream: basis.stream, cursor: basis.cursor }
              : undefined
          );
          return toolResult(
            targetLabel,
            root,
            loaded.inspection,
            loaded.neighbors,
            loaded.history,
            pages,
            references
          );
        }
        const target = requestedTarget;
        targetLabel = target;
        const path = target.startsWith("file:") ? target.slice(5) : target;
        if (splitRepoPath(path)) {
          const firstPage = await neighborsForWorkspacePath(cwd, deps, path, {
            limit: pages.limit,
          });
          targetLabel = firstPage.label;
          const loaded = await loadProvenancePages(
            deps,
            firstPage.root,
            pages,
            undefined,
            firstPage.result
          );
          return toolResult(
            targetLabel,
            firstPage.root,
            loaded.inspection,
            loaded.neighbors,
            loaded.history,
            pages,
            references
          );
        }

        let root: VcsSemanticNodeRef;
        try {
          root = semanticRootForTarget(target, deps.session);
        } catch (error) {
          return invalidTargetResult(
            target,
            error instanceof Error ? error.message : `Invalid provenance target: ${target}`
          );
        }
        const loaded = await loadProvenancePages(deps, root, pages);
        return toolResult(
          target,
          root,
          loaded.inspection,
          loaded.neighbors,
          loaded.history,
          pages,
          references
        );
      } catch (error) {
        if (error instanceof InvalidProvenanceTargetError) {
          return invalidTargetResult(targetLabel, error.message);
        }
        if (error instanceof AgentReferenceUnavailableError) {
          return invalidTargetResult(
            error.ref,
            `Provenance reference ${error.ref} is unavailable or expired. Start again from a friendly target.`
          );
        }
        throw error;
      }
    },
  };
}
