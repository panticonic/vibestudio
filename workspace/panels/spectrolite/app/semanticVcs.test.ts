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
    integrate: unreachable,
    revert: unreachable,
    commit: unreachable,
    push: unreachable,
    ...overrides,
  } as VaultVcsPort;
}

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

  it("returns conflicting main changes for an explicit product decision", async () => {
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => status({ mainRelation: "diverged" }),
        compare: async () => ({
          target: working,
          sourceEventId: "event:main",
          counts: {
            shared: 0,
            alreadySatisfied: 0,
            actionable: 1,
            conflicting: 1,
            blocked: 0,
            accounted: 0,
            historical: 0,
          },
          changes: [
            {
              changeId: "change:conflict",
              workUnitId: "work:main",
              kind: "text-edit",
              summary: "Change the title",
              disposition: { status: "actionable", applicability: "conflicting" },
            },
          ],
          nextCursor: null,
        }),
      })
    );

    await expect(session.integrateMain()).resolves.toEqual({
      status: "conflicts",
      sourceEventId: "event:main",
      conflicts: [{ changeId: "change:conflict", kind: "text-edit", summary: "Change the title" }],
    });
  });

  it("authors text edits against the exact working state", async () => {
    const edit = vi.fn(async () => ({
      contextId: "ctx",
      workUnitId: "work:edit",
      applicationId: "application:next",
      changeIds: ["change:edit"],
      changeCount: 1,
      incorporatedChangeIds: [],
      incorporatedChangeCount: 0,
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

  it("integrates applicable main changes locally and commits the integration parent", async () => {
    let currentStatus = status({ mainRelation: "behind", clean: true });
    let comparisonOrdinal = 0;
    const integrate = vi.fn(async () => ({
      contextId: "ctx",
      workUnitId: "work:integration",
      applicationId: "application:integrated",
      decisionId: "decision:adopt",
      changeIds: [],
      changeCount: 0,
      incorporatedChangeIds: ["change:source"],
      incorporatedChangeCount: 1,
      workingHead: { kind: "application" as const, applicationId: "application:integrated" },
    }));
    const commit = vi.fn(async (_input: unknown) => ({
      contextId: "ctx",
      event: { kind: "event" as const, eventId: "event:integrated" },
      committedApplicationIds: ["application:integrated"],
      integrationSourceEventId: "event:main",
    }));
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => currentStatus,
        compare: async () => {
          const actionable = comparisonOrdinal++ === 0;
          return {
            target: working,
            sourceEventId: "event:main",
            counts: {
              shared: 0,
              alreadySatisfied: 0,
              actionable: actionable ? 1 : 0,
              conflicting: 0,
              blocked: 0,
              accounted: actionable ? 0 : 1,
              historical: 0,
            },
            changes: actionable
              ? [
                  {
                    changeId: "change:source",
                    workUnitId: "work:source",
                    kind: "text-edit" as const,
                    summary: "edit note",
                    disposition: {
                      status: "actionable" as const,
                      applicability: "applicable" as const,
                    },
                  },
                ]
              : [],
            nextCursor: null,
          };
        },
        integrate,
        commit: async (input) => {
          const result = await commit(input);
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
    expect(integrate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: "event:main",
        decision: { kind: "adopted", sourceChangeIds: ["change:source"] },
      })
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ integratesEventId: "event:main" })
    );
  });

  it("recompares after each local step so derived prerequisites clear naturally", async () => {
    let currentStatus = status({ mainRelation: "behind", clean: true });
    let comparisonOrdinal = 0;
    const integrate = vi.fn(async (input: { decision: { sourceChangeIds: string[] } }) => {
      const changeId = input.decision.sourceChangeIds[0]!;
      const suffix = changeId.endsWith("first") ? "first" : "second";
      return {
        contextId: "ctx",
        workUnitId: `work:${suffix}`,
        applicationId: `application:${suffix}`,
        decisionId: `decision:${suffix}`,
        changeIds: [],
        changeCount: 0,
        incorporatedChangeIds: [changeId],
        incorporatedChangeCount: 1,
        workingHead: {
          kind: "application" as const,
          applicationId: `application:${suffix}`,
        },
      };
    });
    const compare: VaultVcsPort["compare"] = async () => {
      const ordinal = comparisonOrdinal++;
      const changes =
        ordinal === 0
          ? [
              {
                changeId: "change:first",
                workUnitId: "work:source",
                kind: "content-replace" as const,
                summary: "first content step",
                disposition: {
                  status: "actionable" as const,
                  applicability: "applicable" as const,
                },
              },
              {
                changeId: "change:second",
                workUnitId: "work:source",
                kind: "content-replace" as const,
                summary: "second content step",
                disposition: {
                  status: "actionable" as const,
                  applicability: "blocked" as const,
                  prerequisiteChangeIds: ["change:first"],
                },
              },
            ]
          : ordinal === 1
            ? [
                {
                  changeId: "change:second",
                  workUnitId: "work:source",
                  kind: "content-replace" as const,
                  summary: "second content step",
                  disposition: {
                    status: "actionable" as const,
                    applicability: "applicable" as const,
                  },
                },
              ]
            : [];
      return {
        target: working,
        sourceEventId: "event:main",
        counts: {
          shared: 0,
          alreadySatisfied: 0,
          actionable: changes.length,
          conflicting: 0,
          blocked: ordinal === 0 ? 1 : 0,
          accounted: ordinal,
          historical: 0,
        },
        changes,
        nextCursor: null,
      };
    };
    const commit = vi.fn(async () => ({
      contextId: "ctx",
      event: { kind: "event" as const, eventId: "event:integrated" },
      committedApplicationIds: ["application:first", "application:second"],
      integrationSourceEventId: "event:main",
    }));
    const session = new VaultSemanticVcs(
      "ctx",
      "projects/default",
      client({
        status: async () => currentStatus,
        compare,
        integrate,
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
    expect(integrate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedWorkingHead: working,
        decision: { kind: "adopted", sourceChangeIds: ["change:first"] },
      })
    );
    expect(integrate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedWorkingHead: { kind: "application", applicationId: "application:first" },
        decision: { kind: "adopted", sourceChangeIds: ["change:second"] },
      })
    );
    expect(comparisonOrdinal).toBe(3);
  });
});
