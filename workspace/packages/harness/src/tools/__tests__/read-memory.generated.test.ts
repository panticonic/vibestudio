import { describe, expect, it } from "vitest";
import type { VcsReadMemoryEpisode, VcsReadMemoryResult } from "@vibestudio/service-schemas/vcs";
import { renderReadMemoryBlock } from "../read-memory.js";

const HASH = "a".repeat(64);

function episode(
  index: number,
  overrides: Partial<VcsReadMemoryEpisode> = {}
): VcsReadMemoryEpisode {
  const start = index * 17;
  return {
    ranges: [{ start, end: start + 9 }],
    stop: "authored",
    change: { kind: "change", changeId: `change:${index}` },
    appliedChange: { kind: "applied-change", appliedChangeId: `applied-change:${index}` },
    workUnit: { kind: "work-unit", workUnitId: `work-unit:${index}` },
    command: { kind: "command", commandId: `command:${index}` },
    changeKind: "text-edit",
    counteractsChangeIds: [],
    intentSummary: `Keep invariant ${index} owned by its caller`,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    externalSnapshot: null,
    commit: null,
    cause: null,
    decisions: [],
    ...overrides,
  };
}

function attached(overrides: Partial<Extract<VcsReadMemoryResult, { status: "attached" }>> = {}) {
  return {
    status: "attached" as const,
    state: { kind: "event" as const, eventId: "event:read" },
    repositoryId: "repository:fixture",
    fileId: "file:fixture",
    path: "packages/fixture/src/memory.ts",
    contentHash: HASH,
    range: { start: 0, end: 120 },
    coordinateKind: "utf16" as const,
    episodes: [],
    history: [],
    truncated: false,
    ...overrides,
  } satisfies Extract<VcsReadMemoryResult, { status: "attached" }>;
}

function render(result: Extract<VcsReadMemoryResult, { status: "attached" }>): string | null {
  return renderReadMemoryBlock({
    label: "packages/fixture/src/memory.ts",
    startLine: 4,
    endLine: 9,
    result,
  });
}

describe("generated read-memory renderer corpus", () => {
  it("renders a deterministic, compact corpus of authored and imported blame episodes", () => {
    const episodes = Array.from({ length: 12 }, (_, index) =>
      episode(index, {
        ranges:
          index === 2
            ? [
                { start: 34, end: 36 },
                // UTF-16 positions deliberately straddle a surrogate-pair-sized gap.
                { start: 38, end: 43 },
              ]
            : [{ start: index * 17, end: index * 17 + 9 }],
        stop: index % 3 === 0 ? "import-boundary" : "authored",
        intentSummary:
          index === 5
            ? `  Preserve   a whitespace-normalized invariant ${"x".repeat(400)}  `
            : `Keep generated invariant ${index} intact`,
        counteractsChangeIds: index % 4 === 0 ? [`change:prior:${index}`] : [],
        commit:
          index % 2 === 0
            ? {
                event: { kind: "event", eventId: `event:commit:${index}` },
                message: `Commit preserves invariant ${index}`,
                createdAt: "2026-07-22T10:01:00.000Z",
              }
            : null,
        cause:
          index % 2 === 1
            ? {
                invocation: {
                  kind: "trajectory-invocation",
                  logId: `trajectory:${index}`,
                  head: "main",
                  invocationId: `invocation:${index}`,
                },
                turn: {
                  kind: "trajectory-turn",
                  logId: `trajectory:${index}`,
                  head: "main",
                  turnId: `turn:${index}`,
                },
                message: {
                  kind: "trajectory-message",
                  logId: `trajectory:${index}`,
                  head: "main",
                  messageId: `message:${index}`,
                },
                toolName: "edit",
                terminalOutcome: "success",
                requestRef: null,
                turnSummary: null,
                triggerText: `User requested invariant ${index}`,
                sender: { kind: "user", id: "user:fixture", participantId: "user:fixture" },
              }
            : null,
        decisions:
          index % 3 === 1
            ? [
                {
                  decision: { kind: "decision", decisionId: `decision:${index}` },
                  kind: "reconciled",
                  rationale: `Reconcile generated branch ${index}`,
                },
              ]
            : [],
        externalSnapshot:
          index % 3 === 0
            ? {
                sourceKind: "git",
                sourceUri: `https://example.test/library-${index}.git`,
                snapshotRevision: `revision-${index}`,
                sourceSubdir: null,
                canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
                snapshotDigest: `snapshot:${index}`,
                targetRepositoryIds: ["repository:fixture"],
              }
            : null,
      })
    );
    const result = attached({
      episodes,
      history: Array.from({ length: 8 }, (_, index) => ({
        node: { kind: "event" as const, eventId: `event:history:${index}` },
        createdAt: "2026-07-23T10:00:00.000Z",
        summary: `History ${index}`,
      })),
      truncated: true,
    });

    const first = render(result);
    const second = render(result);

    expect(first).toBe(second);
    expect(first).toContain(
      "why packages/fixture/src/memory.ts lines 4-9 exist · verified against this exact file content"
    );
    expect(first).toContain("UTF-16 34-36, 38-43");
    expect(first).toContain("imported from outside workspace history");
    expect(first).toContain("counteracts change:prior:0");
    expect(first).toContain('original request "User requested invariant 1"');
    expect(first).toContain('committed as "Commit preserves invariant 0"');
    expect(first).toContain("decision reconciled");
    expect(first).toContain("external source git https://example.test/library-0.git @ revision-0");
    expect(first).toContain("earlier file history");
    expect(first).toContain(
      "more history exists; continue from an exact target above with provenance"
    );
    expect(first).toContain(
      'inspect deeper with provenance({ target: {"kind":"change","changeId":"change:1"} })'
    );
    expect(first).toContain("…");
    expect(first).not.toContain("  Preserve   a whitespace");

    const lines = first?.split("\n") ?? [];
    expect(lines.filter((line) => line.startsWith("● UTF-16 "))).toHaveLength(12);
    expect(lines.filter((line) => line.startsWith("  - "))).toHaveLength(8);
    expect(lines.indexOf("  earlier file history")).toBeGreaterThan(
      lines.findIndex((line) =>
        line.includes("external source git https://example.test/library-9.git")
      )
    );
  });

  it("uses the strongest available semantic summary without emitting empty fields", () => {
    const output = render(
      attached({
        episodes: [
          episode(1, {
            intentSummary: null,
            commit: {
              event: { kind: "event", eventId: "event:commit" },
              message: "Commit message is the semantic fallback",
              createdAt: "2026-07-22T10:01:00.000Z",
            },
            cause: {
              invocation: {
                kind: "trajectory-invocation",
                logId: "trajectory:fallback",
                head: "main",
                invocationId: "invocation:fallback",
              },
              turn: null,
              message: null,
              toolName: null,
              terminalOutcome: null,
              requestRef: null,
              turnSummary: "Turn summary should not outrank a commit",
              triggerText: "Prompt detail should be present but not duplicate the summary",
              sender: null,
            },
          }),
          episode(2, {
            intentSummary: null,
            commit: null,
            cause: {
              invocation: {
                kind: "trajectory-invocation",
                logId: "trajectory:turn",
                head: "main",
                invocationId: "invocation:turn",
              },
              turn: null,
              message: null,
              toolName: null,
              terminalOutcome: null,
              requestRef: null,
              turnSummary: "Turn summary is the fallback",
              triggerText: "Different trigger remains useful",
              sender: null,
            },
          }),
          episode(3, { intentSummary: null, commit: null, cause: null }),
        ],
      })
    );

    expect(output).toContain('why "Commit message is the semantic fallback"');
    expect(output).toContain(
      'original request "Prompt detail should be present but not duplicate the summary"'
    );
    expect(output).toContain('why "Turn summary is the fallback"');
    expect(output).toContain('original request "Different trigger remains useful"');
    expect(output).not.toContain("why null");
    expect(output).not.toContain("committed as null");
    expect(output).not.toContain("original request null");
  });

  it("does not create an empty provenance block, but preserves history-only memory", () => {
    expect(render(attached())).toBeNull();

    const historyOnly = render(
      attached({
        history: [
          {
            node: { kind: "event", eventId: "event:history-only" },
            createdAt: null,
            summary: "A prior commit still explains this file",
          },
        ],
      })
    );
    expect(historyOnly).toContain("verified against this exact file content");
    expect(historyOnly).toContain("A prior commit still explains this file");
    expect(historyOnly).not.toContain("inspect deeper with provenance");
  });
});
