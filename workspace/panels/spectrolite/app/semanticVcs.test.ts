import { describe, expect, it, vi } from "vitest";
import { VaultSemanticVcs, type VaultVcsPort } from "./semanticVcs";

vi.mock("@workspace/runtime", () => ({ vcs: {} }));

const committed = { kind: "event" as const, eventId: "event:local" };
const working = { kind: "application" as const, applicationId: "application:working" };

function status(overrides: Record<string, unknown> = {}) {
  return {
    contextId: "ctx",
    committed,
    workingHead: working,
    clean: false,
    mainEventId: "event:main",
    mainRelation: "ahead" as const,
    workingCounts: { applications: 1, workUnits: 1, changes: 1 },
    integrating: [],
    ...overrides,
  };
}

function client(overrides: Partial<VaultVcsPort> = {}): VaultVcsPort {
  const unreachable = async () => {
    throw new Error("unexpected VCS call");
  };
  return {
    status: async () => status(),
    resolveRepository: async ({ state, repoPath }) => ({
      state,
      repositoryId: "repo:notes",
      repoPath,
    }),
    readFile: unreachable,
    listFiles: unreachable,
    edit: unreachable,
    compare: unreachable,
    merge: unreachable,
    revert: unreachable,
    commit: unreachable,
    push: unreachable,
    ...overrides,
  } as VaultVcsPort;
}

const compareResult = (
  coordinates: Array<{
    coordinate: {
      kind: "file" | "repository";
      id: string;
      paths: { base?: string; ours?: string; theirs?: string };
    };
    status: "adopt" | "convergent" | "composed" | "conflict" | "resolved";
    group?: string;
    summary: string;
  }> = [],
  concluded = coordinates.length === 0
): Awaited<ReturnType<VaultVcsPort["compare"]>> => ({
  target: working,
  source: { kind: "event", eventId: "event:main" },
  base: committed,
  resolution: {
    complete: coordinates.length === 0,
    remainingCoordinateCount: coordinates.length,
    concluded,
  },
  counts: {
    adopt: coordinates.filter((row) => row.status === "adopt").length,
    convergent: coordinates.filter((row) => row.status === "convergent").length,
    composed: coordinates.filter((row) => row.status === "composed").length,
    conflict: coordinates.filter((row) => row.status === "conflict").length,
    resolved: coordinates.filter((row) => row.status === "resolved").length,
  },
  intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 0 },
  coordinates: coordinates.map((row) => ({
    ...row,
    aspects: [
      {
        aspect: "content" as const,
        base: null,
        ours: null,
        theirs: "next",
        status: row.status === "conflict" ? ("conflict" as const) : ("adopt" as const),
      },
    ],
    attribution: { ours: [], theirs: [{ changeId: "change:source", workUnitId: "work:source" }] },
    resolutions:
      row.status === "resolved"
        ? []
        : row.status === "composed"
          ? ["composed" as const, "theirs" as const, "ours" as const, "current" as const]
          : ["theirs" as const, "ours" as const, "current" as const],
  })),
  intents: [],
  intentsTruncated: false,
  nextCursor: null,
});

describe("VaultSemanticVcs", () => {
  it("resolves the repository directly at the exact working state", async () => {
    const resolveRepository = vi.fn(client().resolveRepository);
    const session = new VaultSemanticVcs("ctx", "projects/default", client({ resolveRepository }));

    const revision = await session.refresh();

    expect(revision.repositoryId).toBe("repo:notes");
    expect(resolveRepository).toHaveBeenCalledWith({
      state: working,
      repoPath: "projects/default",
    });
  });

  it("returns coordinate conflicts for an explicit product decision", async () => {
    const conflict = {
      coordinate: {
        kind: "file" as const,
        id: "file:note",
        paths: {
          base: "projects/default/Note.mdx",
          ours: "projects/default/Note.mdx",
          theirs: "projects/default/Note.mdx",
        },
      },
      status: "conflict" as const,
      summary: "conflict file projects/default/Note.mdx",
    };
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => status({ mainRelation: "diverged" }),
        compare: async () => compareResult([conflict], false),
      })
    );

    await expect(session.integrateMain()).resolves.toEqual({
      status: "conflicts",
      sourceEventId: "event:main",
      conflicts: [
        {
          coordinate: { kind: "file", id: "file:note" },
          coordinates: [{ kind: "file", id: "file:note" }],
          summary: conflict.summary,
        },
      ],
    });
  });

  it("finds conflicts on later comparison pages before attempting a merge", async () => {
    const lateConflict = {
      coordinate: {
        kind: "file" as const,
        id: "file:late",
        paths: { theirs: "projects/default/Late.mdx" },
      },
      status: "conflict" as const,
      summary: "conflict file projects/default/Late.mdx",
    };
    const first = {
      ...compareResult([], true),
      resolution: { complete: false, remainingCoordinateCount: 1, concluded: true },
      counts: { adopt: 0, convergent: 0, composed: 0, conflict: 1, resolved: 500 },
      nextCursor: "page:2",
    };
    const compare = vi.fn(async (input: Parameters<VaultVcsPort["compare"]>[0]) =>
      input.cursor ? compareResult([lateConflict], true) : first
    );
    const merge = vi.fn(client().merge);
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({ status: async () => status({ mainRelation: "diverged" }), compare, merge })
    );

    await expect(session.integrateMain()).resolves.toEqual({
      status: "conflicts",
      sourceEventId: "event:main",
      conflicts: [
        {
          coordinate: { kind: "file", id: "file:late" },
          coordinates: [{ kind: "file", id: "file:late" }],
          summary: lateConflict.summary,
        },
      ],
    });
    expect(compare).toHaveBeenCalledTimes(2);
    expect(merge).not.toHaveBeenCalled();
  });

  it("round-trips a displayed conflict as its complete coupled group", async () => {
    const conflict = {
      coordinate: {
        kind: "file" as const,
        id: "file:note",
        paths: { ours: "projects/default/Note.mdx", theirs: "projects/default/Note.mdx" },
      },
      status: "conflict" as const,
      group: "group:note",
      summary: "conflict file projects/default/Note.mdx",
    };
    const repository = {
      coordinate: {
        kind: "repository" as const,
        id: "repository:notes",
        paths: { theirs: "projects/default" },
      },
      status: "adopt" as const,
      group: "group:note",
      summary: "adopt repository projects/default",
    };
    const statusCall = vi
      .fn()
      .mockResolvedValueOnce(status({ mainRelation: "diverged" }))
      .mockResolvedValue(status({ mainRelation: "ahead" }));
    const merge = vi.fn(async (input: Parameters<VaultVcsPort["merge"]>[0]) => ({
      status: "working" as const,
      contextId: "ctx",
      commandId: input.commandId,
      workUnitId: "work:decision",
      applicationId: "application:decision",
      decisionId: "decision:local",
      changeIds: [],
      changeCount: 0,
      incorporatedChangeIds: [],
      incorporatedChangeCount: 0,
      decisionIds: ["decision:local"],
      workingHead: { kind: "application" as const, applicationId: "application:decision" },
      outcomes: [],
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
      intents: [],
      intentsTruncated: false,
      counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
      conflicts: [],
      nextConflictCursor: null,
      composed: [],
    }));
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: statusCall,
        compare: async () => compareResult([conflict, repository], false),
        merge,
      })
    );
    const result = await session.integrateMain();
    if (typeof result === "string") throw new Error("expected a conflict result");

    await session.keepLocalForMain(result.conflicts[0]!.coordinates);

    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinates: [
          { kind: "file", id: "file:note" },
          { kind: "repository", id: "repository:notes" },
        ],
        resolutions: [
          expect.objectContaining({
            coordinate: { kind: "file", id: "file:note" },
            resolution: "ours",
          }),
          expect.objectContaining({
            coordinate: { kind: "repository", id: "repository:notes" },
            resolution: "ours",
          }),
        ],
      })
    );
  });

  it("authors text edits against the exact working state", async () => {
    const edit = vi.fn(async (input: Parameters<VaultVcsPort["edit"]>[0]) => ({
      contextId: "ctx",
      commandId: input.commandId,
      workUnitId: "work:edit",
      applicationId: "application:next",
      changeIds: ["change:edit"],
      changeCount: 1,
      incorporatedChangeIds: [],
      incorporatedChangeCount: 0,
      decisionIds: [],
      workingHead: { kind: "application" as const, applicationId: "application:next" },
    }));
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        readFile: async () => ({
          repositoryId: "repo:notes",
          fileId: "file:note",
          repoPath: "projects/default",
          path: "Note.mdx",
          contentHash: "blob:old",
          authoredChangeId: "change:old",
          authoredByWorkUnitId: "work:old",
          contentClass: "internal" as const,
          externalKeys: [],
          mode: 0o644,
          content: { kind: "text", text: "old" },
        }),
        edit,
      })
    );

    const result = await session.edit([
      {
        kind: "replace",
        path: "projects/default/Note.mdx",
        hunks: [{ start: 0, end: 3, oldText: "old", newText: "new" }],
      },
    ]);

    expect(result.changeIds).toEqual(["change:edit"]);
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "ctx",
        expectedWorkingHead: working,
        changes: [
          {
            kind: "text-edit",
            repositoryId: "repo:notes",
            fileId: "file:note",
            edits: [{ start: 0, end: 3, text: "new" }],
          },
        ],
      })
    );
  });

  it("merges a clean coordinate page, observes conclusion, and commits the source parent", async () => {
    let currentStatus = status({ mainRelation: "behind", clean: true });
    let compared = 0;
    const merge = vi.fn(async (input: Parameters<VaultVcsPort["merge"]>[0]) => ({
      status: "working" as const,
      contextId: "ctx",
      commandId: input.commandId,
      workUnitId: "work:merge",
      applicationId: "application:merged",
      decisionId: "decision:merge",
      changeIds: [],
      changeCount: 0,
      incorporatedChangeIds: ["change:source"],
      incorporatedChangeCount: 1,
      decisionIds: ["decision:merge"],
      workingHead: { kind: "application" as const, applicationId: "application:merged" },
      outcomes: [],
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
      intents: [],
      intentsTruncated: false,
      counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
      conflicts: [],
      nextConflictCursor: null,
      composed: [],
    }));
    const commit = vi.fn(async () => ({
      contextId: "ctx",
      event: { kind: "event" as const, eventId: "event:integrated" },
      committedApplicationIds: ["application:merged"],
      integrationSourceEventIds: ["event:main"],
    }));
    const pending = {
      coordinate: {
        kind: "file" as const,
        id: "file:note",
        paths: { theirs: "projects/default/Note.mdx" },
      },
      status: "adopt" as const,
      summary: "adopt file projects/default/Note.mdx",
    };
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => currentStatus,
        compare: async () =>
          compared++ === 0 ? compareResult([pending], false) : compareResult([], true),
        merge,
        commit: async () => {
          const result = await commit();
          currentStatus = status({
            committed: result.event,
            workingHead: result.event,
            mainRelation: "at",
            clean: true,
          });
          return result;
        },
      })
    );

    await expect(session.integrateMain()).resolves.toBe("integrated");
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "event", eventId: "event:main" },
        expectedWorkingHead: working,
      })
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it("passes selected coordinates as explicit ours resolutions", async () => {
    const merge = vi.fn(async (input: Parameters<VaultVcsPort["merge"]>[0]) => ({
      status: "working" as const,
      contextId: "ctx",
      commandId: input.commandId,
      workUnitId: "work:merge",
      applicationId: "application:merged",
      decisionId: "decision:merge",
      changeIds: [],
      changeCount: 0,
      incorporatedChangeIds: ["change:source"],
      incorporatedChangeCount: 1,
      decisionIds: ["decision:merge"],
      workingHead: working,
      outcomes: [],
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
      intents: [],
      intentsTruncated: false,
      counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
      conflicts: [],
      nextConflictCursor: null,
      composed: [],
    }));
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => status({ mainRelation: "diverged" }),
        merge,
        compare: async () => compareResult([], true),
        commit: async () => ({
          contextId: "ctx",
          event: committed,
          committedApplicationIds: [],
          integrationSourceEventIds: ["event:main"],
        }),
      })
    );
    const coordinate = { kind: "file" as const, id: "file:note" };

    await session.keepLocalForMain([coordinate]);

    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinates: [coordinate],
        resolutions: [expect.objectContaining({ coordinate, resolution: "ours" })],
      })
    );
  });
});
