import { describe, expect, it, vi } from "vitest";
import { createWorkspaceVcsTool, type ToolWorkflowVcs } from "../workspace-vcs.js";

function fixture() {
  const working = { kind: "application" as const, applicationId: "application:working" };
  const status = vi.fn(async () => ({
    contextId: "context:test",
    committed: { kind: "event" as const, eventId: "event:committed" },
    workingHead: working,
    clean: false,
    mainEventId: "event:main",
    mainRelation: "ahead" as const,
    workingCounts: { applications: 2, workUnits: 2, changes: 3 },
  }));
  const compare = vi.fn(async (input: Parameters<ToolWorkflowVcs["compare"]>[0]) => ({
    target: input.target,
    sourceEventId: input.sourceEventId,
    resolution: { complete: false, remainingChangeCount: 1 },
    counts: {
      shared: 1,
      alreadySatisfied: 0,
      actionable: 1,
      conflicting: 0,
      blocked: 0,
      accounted: 0,
      historical: 0,
    },
    changes: [
      {
        changeId: "change:source",
        workUnitId: "work:source",
        kind: "text-edit" as const,
        summary: "Update the source",
        disposition: { status: "actionable" as const, applicability: "applicable" as const },
      },
    ],
    nextCursor: null,
  }));
  const integrate = vi.fn(async (input: Parameters<ToolWorkflowVcs["integrate"]>[0]) => ({
    contextId: input.contextId,
    workUnitId: "work:integration",
    applicationId: "application:integration",
    changeCount: 0,
    changeIds: [],
    incorporatedChangeCount: input.decision.sourceChangeIds.length,
    incorporatedChangeIds: input.decision.sourceChangeIds,
    workingHead: { kind: "application" as const, applicationId: "application:integration" },
    decisionId: "decision:integration",
  }));
  const revert = vi.fn();
  const discard = vi.fn(async (input: Parameters<ToolWorkflowVcs["discard"]>[0]) => ({
    contextId: input.contextId,
    workingHead: { kind: "event" as const, eventId: "event:committed" },
    discardedApplicationIds: ["application:first", "application:working"],
  }));
  const blame = vi.fn<ToolWorkflowVcs["blame"]>(async (input) => ({
    state: input.state,
    fileId: input.fileId,
    coordinateKind: "utf16" as const,
    spans: [
      {
        start: input.range.start,
        end: input.range.end,
        change: { kind: "change", changeId: "change:origin" },
        appliedChange: {
          kind: "applied-change",
          appliedChangeId: "applied-change:origin",
        },
        workUnit: { kind: "work-unit", workUnitId: "work-unit:origin" },
        command: { kind: "command", commandId: "command:origin" },
        path: [],
        stop: "authored",
      },
    ],
    nextCursor: null,
  }));
  const push = vi.fn(async (input: Parameters<ToolWorkflowVcs["push"]>[0]) => ({
    contextId: input.contextId,
    eventId: input.expectedCommittedEventId,
    mainEventId: input.expectedCommittedEventId,
    effectId: "effect:push",
    appliedAt: "2026-07-15T00:00:00.000Z",
  }));
  const resolveRepository = vi.fn(async () => ({
    state: working,
    repositoryId: "repository:packages/demo",
    repoPath: "packages/demo",
  }));
  const vcs = {
    status,
    compare,
    integrate,
    revert,
    discard,
    blame,
    push,
    resolveRepository,
    neighbors: vi.fn(async () => ({
      root: working,
      edges: [
        {
          kind: "contains-repository" as const,
          from: working,
          to: {
            kind: "repository" as const,
            state: working,
            repositoryId: "repository:packages/demo",
          },
        },
      ],
      nextCursor: null,
    })),
    inspect: vi.fn(async (input) => ({
      root: input.node,
      node: {
        kind: "repository" as const,
        state: working,
        value: {
          kind: "present" as const,
          repositoryId: "repository:packages/demo",
          repoPath: "packages/demo",
          manifestId: "manifest:demo",
        },
      },
      edges: [],
      hasMoreEdges: false,
    })),
    readFile: vi.fn(async () => ({
      repositoryId: "repository:packages/demo",
      fileId: "file:demo",
      repoPath: "packages/demo",
      path: "a.ts",
      contentHash: "blob:demo",
      mode: 0o644,
      content: { kind: "text" as const, text: "hello" },
    })),
  } as unknown as ToolWorkflowVcs;
  return { vcs, status, compare, integrate, discard, blame, push, working };
}

describe("workspace VCS agent tool", () => {
  it("orients and compares from the current working state", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:orient",
    });

    const status = await tool.execute("call:status", { operation: "status" });
    expect(status.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("dirty"),
    });

    const compared = await tool.execute("call:compare", {
      operation: "compare",
      sourceEventId: "event:source",
    });
    expect(f.compare).toHaveBeenCalledWith(
      expect.objectContaining({ target: f.working, sourceEventId: "event:source" })
    );
    expect(compared.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("change:source"),
    });
  });

  it("records one exact incremental integration decision", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:integrate",
    });
    const result = await tool.execute("call:integrate", {
      operation: "integrate",
      sourceEventId: "event:source",
      decision: { kind: "adopted", sourceChangeIds: ["change:source"] },
    });
    expect(f.integrate).toHaveBeenCalledWith({
      contextId: "context:test",
      expectedWorkingHead: f.working,
      commandId: "command:integrate",
      sourceEventId: "event:source",
      decision: { kind: "adopted", sourceChangeIds: ["change:source"] },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Decision decision:integration"),
    });
  });

  it("resolves path-based reconciliation evidence at the exact working state", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:reconcile",
    });

    await tool.execute("call:reconcile", {
      operation: "integrate",
      sourceEventId: "event:source",
      decision: {
        kind: "reconciled",
        sourceChangeIds: ["change:source"],
        evidence: [{ kind: "file-content", path: "packages/demo/a.ts" }],
        rationale: "The merged file preserves both intended behaviors.",
      },
    });

    expect(f.integrate).toHaveBeenCalledWith({
      contextId: "context:test",
      expectedWorkingHead: f.working,
      commandId: "command:reconcile",
      sourceEventId: "event:source",
      decision: {
        kind: "reconciled",
        sourceChangeIds: ["change:source"],
        evidence: [{ kind: "file-content", fileId: "file:demo", contentHash: "blob:demo" }],
        rationale: "The merged file preserves both intended behaviors.",
      },
    });
  });

  it("resolves a friendly file path for bounded blame", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:blame",
    });
    expect(JSON.stringify(tool.parameters)).toContain("This is not a line number");
    const result = await tool.execute("call:blame", {
      operation: "blame",
      path: "packages/demo/a.ts",
      start: 1,
      end: 4,
    });
    expect(f.blame).toHaveBeenCalledWith(
      expect.objectContaining({
        state: f.working,
        repositoryId: "repository:packages/demo",
        fileId: "file:demo",
        range: { start: 1, end: 4 },
      })
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("command:origin"),
    });
  });

  it("discards the whole local chain from the live head with the invocation command", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:discard",
    });

    const result = await tool.execute("call:discard", { operation: "discard" });

    expect(f.discard).toHaveBeenCalledWith({
      contextId: "context:test",
      expectedWorkingHead: f.working,
      commandId: "command:discard",
    });
    expect(result.details).toEqual({
      operation: "discard",
      result: {
        contextId: "context:test",
        workingHead: { kind: "event", eventId: "event:committed" },
        discardedApplicationIds: ["application:first", "application:working"],
      },
    });
  });

  it("points an import-terminal span to its exact inspectable boundary", async () => {
    const f = fixture();
    f.blame.mockResolvedValueOnce({
      state: f.working,
      fileId: "file:demo",
      coordinateKind: "utf16",
      spans: [
        {
          start: 0,
          end: 5,
          change: { kind: "change", changeId: "change:import" },
          appliedChange: {
            kind: "applied-change",
            appliedChangeId: "applied-change:import",
          },
          workUnit: { kind: "work-unit", workUnitId: "work-unit:import" },
          command: { kind: "command", commandId: "command:import" },
          path: [],
          stop: "import-boundary",
        },
      ],
      nextCursor: null,
    });
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:blame-import",
    });

    const result = await tool.execute("call:blame-import", {
      operation: "blame",
      path: "packages/demo/a.ts",
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        'pass these typed roots unchanged to provenance: inspect terminal change {"kind":"change","changeId":"change:import"}, then owning import work unit {"kind":"work-unit","workUnitId":"work-unit:import"} for the exact external snapshot; earlier coordinate authorship is unknown'
      ),
    });
    expect(result.details).toMatchObject({
      result: {
        spans: [
          {
            change: { kind: "change", changeId: "change:import" },
            appliedChange: {
              kind: "applied-change",
              appliedChangeId: "applied-change:import",
            },
            workUnit: { kind: "work-unit", workUnitId: "work-unit:import" },
            command: { kind: "command", commandId: "command:import" },
          },
        ],
      },
    });
  });

  it("pushes with the exact committed and protected-main observations", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:push",
    });
    await tool.execute("call:push", { operation: "push" });
    expect(f.push).toHaveBeenCalledWith({
      commandId: "command:push",
      contextId: "context:test",
      expectedCommittedEventId: "event:committed",
      expectedMainEventId: "event:main",
    });
  });
});
