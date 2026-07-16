import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCommand, parseInvocation } from "../commandTable.js";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  handler: null as ((method: string, args: unknown[]) => unknown) | null,
  journal: new Map<string, Record<string, unknown>>(),
}));

vi.mock("./vcsCommandJournal.js", () => ({
  loadVcsCommandJournalEntry: (target: { commandId: string }) =>
    fixture.journal.get(target.commandId) ?? null,
  saveVcsCommandJournalEntry: (entry: Record<string, unknown>) => {
    fixture.journal.set(entry["commandId"] as string, entry);
  },
}));

vi.mock("./sessionContext.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./sessionContext.js")>();
  return {
    ...original,
    resolveSessionScope: () => ({
      contextId: "context:1",
      session: { serverUrl: "https://studio.example.test" },
      client: {
        call: async (method: string, args: unknown[]) => {
          fixture.calls.push({ method, args });
          if (!fixture.handler) throw new Error(`unexpected ${method}`);
          return fixture.handler(method, args);
        },
      },
    }),
  };
});

import { vcsCommands } from "./vcsCommands.js";

const working = { kind: "event" as const, eventId: "event:working" };

function semanticFixture(method: string, args: unknown[]): unknown {
  const input = args[0] as Record<string, unknown>;
  if (method === "vcs.status") {
    return {
      contextId: "context:1",
      committed: working,
      workingHead: working,
      clean: true,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    };
  }
  if (method === "vcs.resolveRepository") {
    const repoPath = input["repoPath"] as string;
    return {
      state: input["state"],
      repositoryId: `repository:${repoPath}`,
      repoPath,
    };
  }
  if (method === "vcs.neighbors") {
    const root = input["root"] as typeof working;
    return {
      root,
      edges: ["packages/source", "panels/target"].map((repoPath) => ({
        kind: "contains-repository",
        from: root,
        to: {
          kind: "repository",
          state: root,
          repositoryId: `repository:${repoPath}`,
        },
      })),
      nextCursor: null,
    };
  }
  if (method === "vcs.inspect") {
    const node = input["node"] as { state: typeof working; repositoryId: string };
    const repoPath = node.repositoryId.slice("repository:".length);
    return {
      root: node,
      node: {
        kind: "repository",
        state: node.state,
        value: {
          kind: "present",
          repositoryId: node.repositoryId,
          repoPath,
          manifestId: `manifest:${repoPath}`,
        },
      },
      edges: [],
      hasMoreEdges: false,
    };
  }
  if (method === "vcs.readFile") {
    const repositoryId = input["repositoryId"] as string;
    const file = input["file"] as { path: string };
    return {
      repositoryId,
      fileId: `file:${file.path}`,
      repoPath: repositoryId.slice("repository:".length),
      path: file.path,
      contentHash: "blob:1",
      mode: 0o644,
      content: { kind: "text", text: "content" },
    };
  }
  if (method === "vcs.move" || method === "vcs.copy") {
    return {
      contextId: "context:1",
      workUnitId: "work:1",
      applicationId: "application:1",
      changeCount: 1,
      changeIds: ["change:1"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      workingHead: { kind: "application", applicationId: "application:1" },
    };
  }
  throw new Error(`unexpected ${method}`);
}

describe("canonical VCS CLI", () => {
  beforeEach(() => {
    fixture.calls = [];
    fixture.journal.clear();
    fixture.handler = semanticFixture;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("exposes only the reduced semantic workflows", () => {
    const names = vcsCommands
      .filter((command) => command.group === "vcs")
      .map((command) => command.name);
    for (const expected of [
      "compare",
      "integrate",
      "move-file",
      "copy-file",
      "import-snapshot",
      "inspect",
      "neighbors",
      "history",
      "blame",
    ]) {
      expect(names).toContain(expected);
    }
    for (const removed of [
      "plan-commit",
      "provenance",
      "recall",
      "import-repos",
      "add-repo",
      "merge",
      "rebase",
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it("resolves a friendly move into one stable-identity transaction", async () => {
    const command = findCommand(vcsCommands, "vcs", "move-file")!;
    const invocation = parseInvocation(command, [
      "packages/source/src/a.ts",
      "panels/target/src/a.ts",
      "--command-id",
      "command:move",
      "--json",
    ]);

    await expect(command.run(invocation, [])).resolves.toBe(0);
    expect(fixture.calls.filter(({ method }) => method === "vcs.resolveRepository")).toHaveLength(
      2
    );
    expect(fixture.calls.some(({ method }) => method === "vcs.neighbors")).toBe(false);
    expect(fixture.calls.some(({ method }) => method === "vcs.inspect")).toBe(false);
    expect(fixture.calls.at(-1)).toEqual({
      method: "vcs.move",
      args: [
        {
          contextId: "context:1",
          expectedWorkingHead: working,
          commandId: "command:move",
          intentSummary: "Move packages/source/src/a.ts to panels/target/src/a.ts",
          moves: [
            {
              kind: "file",
              repositoryId: "repository:packages/source",
              fileId: "file:src/a.ts",
              destinationRepositoryId: "repository:panels/target",
              destinationPath: "src/a.ts",
            },
          ],
        },
      ],
    });
  });

  it("commit has no staging or selective-work flags", () => {
    const command = findCommand(vcsCommands, "vcs", "commit")!;
    const flags = command.flags?.map((flag) => flag.name) ?? [];
    expect(flags).not.toContain("work-unit");
    expect(flags).not.toContain("repo");
    expect(flags).not.toContain("path");
    expect(flags).not.toContain("exclude");
  });

  it("compares an explicit integration source and commits it as the second parent", async () => {
    fixture.handler = (method, args) => {
      if (method === "vcs.status") return semanticFixture(method, args);
      if (method === "vcs.compare") {
        const input = args[0] as Record<string, unknown>;
        return {
          target: input["target"],
          sourceEventId: input["sourceEventId"],
          counts: {
            shared: 0,
            alreadySatisfied: 0,
            actionable: 0,
            conflicting: 0,
            blocked: 0,
            accounted: 1,
            historical: 0,
          },
          changes: [],
          nextCursor: null,
        };
      }
      if (method === "vcs.commit") {
        const input = args[0] as Record<string, unknown>;
        return {
          contextId: "context:1",
          event: { kind: "event", eventId: "event:integration" },
          committedApplicationIds: [],
          integrationSourceEventId: input["integratesEventId"],
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const compareCommand = findCommand(vcsCommands, "vcs", "compare")!;
    await expect(
      compareCommand.run(
        parseInvocation(compareCommand, ["event:source", "--view", "changes", "--json"]),
        []
      )
    ).resolves.toBe(0);
    expect(fixture.calls.at(-1)).toMatchObject({
      method: "vcs.compare",
      args: [expect.objectContaining({ sourceEventId: "event:source" })],
    });

    const commitCommand = findCommand(vcsCommands, "vcs", "commit")!;
    await expect(
      commitCommand.run(
        parseInvocation(commitCommand, [
          "-m",
          "Close integration",
          "--integrates",
          "event:source",
          "--command-id",
          "command:integration",
          "--json",
        ]),
        []
      )
    ).resolves.toBe(0);
    expect(fixture.calls.at(-1)).toEqual({
      method: "vcs.commit",
      args: [
        {
          contextId: "context:1",
          expectedWorkingHead: working,
          message: "Close integration",
          commandId: "command:integration",
          integratesEventId: "event:source",
        },
      ],
    });
  });

  it("resolves one working state and dry-runs without mutation", async () => {
    const command = findCommand(vcsCommands, "vcs", "copy-file")!;
    const invocation = parseInvocation(command, [
      "packages/source/src/a.ts",
      "panels/target/src/a.ts",
      "packages/source/src/b.ts",
      "panels/target/src/b.ts",
      "--dry-run",
      "--command-id",
      "command:copy",
      "--json",
    ]);

    await expect(command.run(invocation, [])).resolves.toBe(0);
    expect(fixture.calls.filter(({ method }) => method === "vcs.status")).toHaveLength(1);
    expect(fixture.calls.filter(({ method }) => method === "vcs.readFile")).toHaveLength(2);
    expect(fixture.calls.some(({ method }) => method === "vcs.copy")).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"expectedWorkingHead":{"kind":"event","eventId":"event:working"}')
    );
  });

  it("replays the exact recorded request after an uncertain response", async () => {
    let moveAttempts = 0;
    fixture.handler = (method, args) => {
      if (
        method === "vcs.status" ||
        method === "vcs.resolveRepository" ||
        method === "vcs.readFile"
      ) {
        return semanticFixture(method, args);
      }
      if (method === "vcs.move") {
        moveAttempts += 1;
        if (moveAttempts === 1) throw new Error("connection closed after dispatch");
        return semanticFixture(method, args);
      }
      throw new Error(`unexpected ${method}`);
    };
    const command = findCommand(vcsCommands, "vcs", "move-file")!;
    const args = [
      "packages/source/src/a.ts",
      "panels/target/src/a.ts",
      "--command-id",
      "command:uncertain",
      "--json",
    ];

    await expect(command.run(parseInvocation(command, args), [])).resolves.toBe(1);
    await expect(command.run(parseInvocation(command, args), [])).resolves.toBe(0);

    const moveCalls = fixture.calls.filter(({ method }) => method === "vcs.move");
    expect(moveCalls).toHaveLength(2);
    expect(moveCalls[1]).toEqual(moveCalls[0]);
    expect(fixture.calls.filter(({ method }) => method === "vcs.status")).toHaveLength(1);
    expect(fixture.calls.filter(({ method }) => method === "vcs.readFile")).toHaveLength(1);
  });

  it("prints an auto-generated retry identity before dispatch", async () => {
    fixture.handler = (method, args) => {
      if (method === "vcs.status") return semanticFixture(method, args);
      if (method === "vcs.commit") {
        return {
          contextId: "context:1",
          event: { kind: "event", eventId: "event:committed" },
          committedApplicationIds: [],
          integrationSourceEventId: null,
        };
      }
      throw new Error(`unexpected ${method}`);
    };
    const command = findCommand(vcsCommands, "vcs", "commit")!;

    await expect(
      command.run(parseInvocation(command, ["-m", "Generated identity", "--json"]), [])
    ).resolves.toBe(0);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[vibestudio\] command-id: cli:[0-9a-f-]+$/)
    );
    const commitInput = fixture.calls.find(({ method }) => method === "vcs.commit")!.args[0] as {
      commandId: string;
    };
    expect(fixture.journal.has(commitInput.commandId)).toBe(true);
  });
});
