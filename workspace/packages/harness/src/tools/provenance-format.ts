/** Compact renderer for one page of canonical semantic-graph edges. */

import type { VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import type { ToolVcs } from "./tool-vcs.js";

export type CanonicalProvenanceResult = Awaited<ReturnType<ToolVcs["neighbors"]>>;
export type CanonicalProvenanceInspection = Awaited<ReturnType<ToolVcs["inspect"]>>;
export type CanonicalProvenanceHistory = Awaited<ReturnType<ToolVcs["history"]>>;

export interface ProvenancePages {
  adjacency: number;
  fileHistory: number;
  limit: number;
}

export function provenancePageStreams(pages: ProvenancePages): {
  inspection: boolean;
  adjacency: boolean;
  fileHistory: boolean;
} {
  return {
    inspection: pages.adjacency === 1 && pages.fileHistory === 1,
    adjacency: pages.adjacency > 1 || pages.fileHistory === 1,
    fileHistory: pages.fileHistory > 1 || pages.adjacency === 1,
  };
}

export interface ProvenanceBlockInput {
  label: string;
  inspection?: CanonicalProvenanceInspection;
  history?: CanonicalProvenanceHistory;
  result: CanonicalProvenanceResult;
  pages?: ProvenancePages;
  reference?: (
    root: VcsSemanticNodeRef,
    continuation?: { stream: "adjacency" | "file-history"; page: number; cursor: string }
  ) => string;
}

function historyCall(
  history: CanonicalProvenanceHistory,
  page: number,
  limit: number,
  reference?: ProvenanceBlockInput["reference"]
): string {
  return `provenance(${JSON.stringify({
    ...(reference
      ? {
          target: reference(history.root, {
            stream: "file-history",
            page,
            cursor: history.nextCursor!,
          }),
        }
      : { root: history.root, historyPage: page, ...(limit === 5 ? {} : { limit }) }),
  })})`;
}

function quoted(value: string): string {
  const limit = 160;
  return JSON.stringify(value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
}

function countedPreview(total: number, preview: number, label: string): string {
  const plural = label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`;
  return `${total} ${total === 1 ? label : plural} (${preview} in preview)`;
}

function inspectedNodeSummary(inspection: CanonicalProvenanceInspection): string {
  const node = inspection.node;
  switch (node.kind) {
    case "event": {
      const value = node.value;
      return [
        "event",
        value.kind,
        value.message ? `message ${quoted(value.message)}` : null,
        `${value.applicationIds.length} application${value.applicationIds.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "external-delta": {
      const value = node.value;
      return [
        "external-delta",
        value.status,
        value.repoPath,
        `${value.changeCount} change${value.changeCount === 1 ? "" : "s"}`,
      ].join(" · ");
    }
    case "application": {
      const value = node.value;
      return [
        "application",
        `work ${value.workUnitId}`,
        `basis ${nodeLabel(value.basis)}`,
        countedPreview(value.appliedChangeCount, value.appliedChanges.length, "applied change"),
      ].join(" · ");
    }
    case "applied-change": {
      const value = node.value;
      return [
        "applied-change",
        `application ${value.applicationId}`,
        `change ${value.changeId}`,
        `ordinal ${value.ordinal}`,
        `${value.appliedEffects.length} effect${value.appliedEffects.length === 1 ? "" : "s"}`,
      ].join(" · ");
    }
    case "work-unit": {
      const value = node.value;
      const externalSnapshot = value.externalSnapshot;
      return [
        "work-unit",
        value.kind,
        `${value.intent.tier}: ${quoted(value.intent.text)}`,
        `command ${value.commandId}`,
        countedPreview(
          value.authoredChangeCount,
          value.authoredChangeIds.length,
          "authored change"
        ),
        countedPreview(
          value.incorporatedChangeCount,
          value.incorporatedChangeIds.length,
          "incorporated change"
        ),
        countedPreview(value.decisionCount, value.decisionIds.length, "decision"),
        externalSnapshot
          ? `external snapshot ${externalSnapshot.sourceKind}:${quoted(externalSnapshot.sourceUri)} @ ${quoted(externalSnapshot.snapshotRevision)} · snapshot digest ${externalSnapshot.snapshotDigest} · ${countedPreview(externalSnapshot.targetRepositoryIds.length, externalSnapshot.targetRepositoryIds.length, "target repository")} · pre-import coordinate authorship unknown`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "change": {
      const value = node.value;
      return [
        "change",
        value.kind,
        `work ${value.authoredByWorkUnitId}`,
        `${value.effects.length} effect${value.effects.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "decision": {
      const value = node.value;
      return [
        "decision",
        `${value.intent.tier}: ${quoted(value.intent.text)}`,
        ...value.sourceIntents.map(
          (source) =>
            `source ${source.workUnitId} ${source.intent.tier}: ${quoted(source.intent.text)}`
        ),
        `${value.entries.length} coordinate entr${value.entries.length === 1 ? "y" : "ies"}`,
        `${value.entries.reduce((count, entry) => count + entry.accountedSourceChangeIds.length, 0)} accounted source changes`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "command": {
      const value = node.value;
      return [
        "command",
        value.method,
        value.status,
        value.contextId ? `context ${value.contextId}` : "workspace-scoped",
      ].join(" · ");
    }
    case "file": {
      const value = node.value;
      return value.kind === "placed"
        ? [
            "file",
            value.path,
            value.contentKind,
            `${value.byteLength} bytes`,
            `${value.coordinateExtent} ${value.contentKind === "text" ? "UTF-16 units" : "byte coordinates"}`,
          ].join(" · ")
        : `file · tombstone · change ${value.tombstoneChangeId}`;
    }
    case "repository": {
      const value = node.value;
      return value.kind === "present"
        ? `repository · ${value.repoPath} · manifest ${value.manifestId}`
        : `repository · tombstone · change ${value.tombstoneChangeId}`;
    }
    case "trajectory": {
      const value = node.value;
      return `trajectory · ${value.logId}@${value.head}`;
    }
    case "trajectory-invocation": {
      const value = node.value;
      return [
        "trajectory-invocation",
        value.name ? `name ${quoted(value.name)}` : null,
        `status ${value.status}`,
        value.turnId ? `turn ${value.turnId}` : null,
        value.terminalOutcome ? `outcome ${value.terminalOutcome}` : null,
        value.requestRef
          ? `request ${value.requestRef.digest} · ${value.requestRef.encoding} · ${value.requestRef.originalBytes} bytes · read services.blobstore.getText(${JSON.stringify(value.requestRef.digest)})`
          : null,
        value.startedEventId ? `started ${value.startedEventId}` : null,
        value.completedEventId ? `completed ${value.completedEventId}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "trajectory-turn": {
      const value = node.value;
      return [
        "trajectory-turn",
        value.ordinal === null ? null : `ordinal ${value.ordinal}`,
        value.triggerMessageId ? `trigger ${value.triggerMessageId}` : null,
        value.summary ? `summary ${quoted(value.summary)}` : null,
        value.openedAt ? `opened ${value.openedAt}` : null,
        value.closedAt ? `closed ${value.closedAt}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "trajectory-message": {
      const value = node.value;
      const text = value.textBlocks.map((block) => block.content).join("\n");
      return [
        "trajectory-message",
        `role ${value.role}`,
        `status ${value.status}`,
        value.turnId ? `turn ${value.turnId}` : null,
        value.sourceMessageId ? `source ${value.sourceMessageId}` : null,
        value.senderRef
          ? `sender ${value.senderRef.kind}:${value.senderRef.id}${value.senderRef.participantId ? ` participant ${value.senderRef.participantId}` : ""}`
          : null,
        text ? `text ${quoted(text)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

function provenanceCall(
  root: VcsSemanticNodeRef,
  adjacencyPage?: number,
  limit = 5,
  reference?: ProvenanceBlockInput["reference"],
  cursor?: string
): string {
  const input = {
    ...(reference
      ? {
          target: reference(
            root,
            adjacencyPage && cursor
              ? { stream: "adjacency", page: adjacencyPage, cursor }
              : undefined
          ),
        }
      : {
          root,
          ...(adjacencyPage ? { adjacencyPage } : {}),
          ...(limit === 5 ? {} : { limit }),
        }),
  };
  return `provenance(${JSON.stringify(input)})`;
}

function referencedNode(
  node: VcsSemanticNodeRef,
  reference?: ProvenanceBlockInput["reference"]
): string {
  return reference
    ? `${node.kind} · provenance(${JSON.stringify({ target: reference(node) })})`
    : JSON.stringify(node);
}

function nodeLabel(node: VcsSemanticNodeRef): string {
  switch (node.kind) {
    case "event":
      return node.eventId;
    case "external-delta":
      return node.deltaId;
    case "application":
      return node.applicationId;
    case "applied-change":
      return node.appliedChangeId;
    case "work-unit":
      return node.workUnitId;
    case "change":
      return node.changeId;
    case "decision":
      return node.decisionId;
    case "command":
      return node.commandId;
    case "file":
      return `${node.repositoryId}/${node.fileId}`;
    case "repository":
      return node.repositoryId;
    case "trajectory":
      return `${node.logId}@${node.head}`;
    case "trajectory-invocation":
      return `${node.invocationId} @ ${node.logId}@${node.head}`;
    case "trajectory-turn":
      return `${node.turnId} @ ${node.logId}@${node.head}`;
    case "trajectory-message":
      return `${node.messageId} @ ${node.logId}@${node.head}`;
  }
}

function inspectionContinuation(
  inspection: CanonicalProvenanceInspection
): { label: string; root: VcsSemanticNodeRef } | null {
  const node = inspection.node;
  if (node.kind === "event" && node.value.applicationIds.length === 1) {
    return {
      label: "sole application",
      root: { kind: "application", applicationId: node.value.applicationIds[0]! },
    };
  }
  if (node.kind === "application") {
    return {
      label: "owning work",
      root: { kind: "work-unit", workUnitId: node.value.workUnitId },
    };
  }
  if (node.kind === "change") {
    return {
      label: "authoring work",
      root: { kind: "work-unit", workUnitId: node.value.authoredByWorkUnitId },
    };
  }
  if (node.kind === "applied-change") {
    return {
      label: "owning application",
      root: { kind: "application", applicationId: node.value.applicationId },
    };
  }
  return null;
}

export function renderProvenanceBlock(input: ProvenanceBlockInput): string | null {
  if (!input.inspection && !input.history && input.result.edges.length === 0) return null;
  const pages = input.pages ?? { adjacency: 1, fileHistory: 1, limit: 5 };
  const streams = provenancePageStreams(pages);
  const pageLabel =
    streams.fileHistory && !streams.adjacency
      ? `file history page ${pages.fileHistory}`
      : streams.adjacency && !streams.fileHistory
        ? `adjacency page ${pages.adjacency}`
        : `${input.result.edges.length} edge${input.result.edges.length === 1 ? "" : "s"}`;
  const lines = [`prov · ${input.label} · ${pageLabel}`];
  if (streams.inspection && input.inspection) {
    lines.push(`  node · ${inspectedNodeSummary(input.inspection)}`);
    const next = inspectionContinuation(input.inspection);
    if (next) {
      lines.push(
        `  inspect ${next.label} → ${provenanceCall(next.root, undefined, pages.limit, input.reference)}`
      );
    }
  }
  if (streams.fileHistory && input.history?.nextCursor) {
    lines.push(
      `  more file history → ${historyCall(input.history, pages.fileHistory + 1, pages.limit, input.reference)}`
    );
  }
  if (streams.fileHistory) {
    for (const entry of input.history?.entries ?? []) {
      lines.push(
        `  past · ${input.reference ? referencedNode(entry.node, input.reference) : nodeLabel(entry.node)} · ${JSON.stringify(entry.summary)}`
      );
    }
  }
  if (streams.adjacency && input.result.nextCursor) {
    lines.push(
      `  more → ${provenanceCall(input.result.root, pages.adjacency + 1, pages.limit, input.reference, input.result.nextCursor)}`
    );
  }
  if (streams.adjacency) {
    for (const edge of input.result.edges) {
      lines.push(
        `  ${referencedNode(edge.from, input.reference)} —${edge.kind}→ ${referencedNode(edge.to, input.reference)}`
      );
    }
  }
  return lines.join("\n");
}
