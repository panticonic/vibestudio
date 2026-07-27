import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInvocation } from "../commandTable.js";
import { setPlainOutput } from "../output.js";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  result: undefined as unknown,
}));

vi.mock("../credentialStore.js", () => ({
  loadCliCredentials: () => ({
    url: "https://studio.example.test",
    workspaceName: "workspace",
  }),
}));

vi.mock("../rpcClient.js", () => ({
  RpcClient: class {
    async call<T>(method: string, args: unknown[]): Promise<T> {
      fixture.calls.push({ method, args });
      return fixture.result as T;
    }

    async close(): Promise<void> {}
  },
}));

import { vcsGitCommand } from "./vcsGitCommands.js";

async function run(...args: string[]): Promise<number> {
  return await vcsGitCommand.run(parseInvocation(vcsGitCommand, []), args);
}

function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map(([line]) => String(line));
}

describe("vcs git CLI", () => {
  beforeEach(() => {
    fixture.calls = [];
    fixture.result = undefined;
    setPlainOutput(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPlainOutput(false);
  });

  it.each([
    {
      args: ["disable", "--repo", "projects/demo"],
      expectedArgs: ["projects/demo"],
      removedRemote: null,
    },
    {
      args: ["disable", "--repo", "projects/demo", "--forget-remote", "--remote", "upstream"],
      expectedArgs: ["projects/demo", { forgetRemote: true, remote: "upstream" }],
      removedRemote: "upstream",
    },
  ])("atomically detaches upstream configuration for $args", async (testCase) => {
    fixture.result = {
      upstreams: {},
      remotes: {},
      removedRemote: testCase.removedRemote,
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(...testCase.args)).resolves.toBe(0);

    expect(fixture.calls).toEqual([
      {
        method: "gitInterop.detachUpstream",
        args: testCase.expectedArgs,
      },
    ]);
  });

  it("preserves the existing structured disable result", async () => {
    fixture.result = {
      upstreams: { projects: { demo: { remote: "origin" } } },
      remotes: {},
      removedRemote: null,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run("disable", "--repo", "projects/demo", "--json")).resolves.toBe(0);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify((fixture.result as { upstreams: unknown }).upstreams)
    );
  });

  it("names an imported semantic candidate and its required publication workflow", async () => {
    fixture.result = {
      path: "projects/demo",
      remote: {
        name: "origin",
        url: "https://example.test/demo.git",
        branch: "main",
      },
      candidate: {
        contextId: "context:import",
        eventId: "event:import",
        changed: true,
        semanticEvidence: {
          applicationId: "application:import",
          workUnitId: "work:import",
          externalSnapshot: {
            sourceKind: "git",
            sourceUri: "https://example.test/demo.git",
            snapshotRevision: "abc123",
            snapshotDigest: "snapshot:abc123",
            targetRepositoryIds: ["repository:demo"],
          },
        },
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      run("import", "https://example.test/demo.git", "--path", "projects/demo", "--branch", "main")
    ).resolves.toBe(0);

    const output = logLines(log).join("\n");
    expect(output).toContain("semantic candidate: event:import in context context:import");
    expect(output).toContain("compare and incrementally integrate this candidate");
    expect(output).toContain("publish protected main with `vibestudio vcs push`");
    expect(output).not.toContain("vibestudio vcs git push --repo");
  });

  it.each([
    {
      args: ["enable", "--repo", "projects/demo", "--anonymous"],
      method: "gitInterop.setUpstream",
      expected: ["projects/demo", { remote: "origin", autoPush: false, credentialId: null }],
      result: { projects: { demo: { remote: "origin", credentialId: null } } },
    },
    {
      args: ["import", "https://example.test/demo.git", "--path", "projects/demo", "--anonymous"],
      method: "gitInterop.importProject",
      expected: [
        {
          path: "projects/demo",
          remote: { name: "origin", url: "https://example.test/demo.git" },
          credentialId: null,
        },
      ],
      result: {
        path: "projects/demo",
        remote: { name: "origin", url: "https://example.test/demo.git" },
        candidate: {
          contextId: "context:import",
          eventId: "event:import",
          changed: true,
          semanticEvidence: {
            applicationId: "application:import",
            workUnitId: "work:import",
            externalSnapshot: {
              sourceKind: "git",
              sourceUri: "https://example.test/demo.git",
              snapshotRevision: "abc123",
              snapshotDigest: "a".repeat(64),
              targetRepositoryIds: ["repository:demo"],
            },
          },
        },
      },
    },
  ])("passes explicit anonymous selection through $method", async (testCase) => {
    fixture.result = testCase.result;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(...testCase.args)).resolves.toBe(0);

    expect(fixture.calls).toEqual([{ method: testCase.method, args: testCase.expected }]);
  });

  it("rejects conflicting credential selection before invoking Git interop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      run("enable", "--repo", "projects/demo", "--credential", "github", "--anonymous")
    ).resolves.toBe(2);

    expect(fixture.calls).toEqual([]);
  });

  it("distinguishes an empty repository from one already in sync", async () => {
    fixture.result = {
      exported: 0,
      headCommit: null,
      pushed: false,
      status: "empty",
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run("push", "--repo", "projects/empty")).resolves.toBe(0);

    expect(logLines(log)).toContain("projects/empty has no published gad history to push");
    expect(logLines(log)).not.toContain("projects/empty already in sync");
  });

  it("describes unrelated force-push history without presenting a false count", async () => {
    fixture.result = {
      exported: 1,
      headCommit: "abcdef012345",
      pushed: true,
      status: "in-sync",
      overwrites: {
        relationship: "unrelated",
        count: null,
        commits: [{ sha: "123456789abc", summary: "Remote root" }],
        truncated: true,
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run("push", "--repo", "projects/demo", "--force")).resolves.toBe(0);

    const output = logLines(log).join("\n");
    expect(output).toContain("replaced unrelated upstream history");
    expect(output).toContain("1234567 Remote root");
    expect(output).toContain("additional upstream commits not shown");
    expect(output).not.toContain("overwrote 0");
  });

  it.each([
    {
      command: "push",
      result: {
        exported: 1,
        headCommit: "abcdef012345",
        pushed: true,
        status: "in-sync",
        clobberedLocalEdits: ["src/local.ts"],
      },
    },
    {
      command: "pull",
      result: {
        behindBy: 0,
        aheadBy: 0,
        remoteBranchExists: true,
        incoming: [],
        clobberedLocalEdits: ["src/local.ts"],
      },
    },
  ])("warns when $command overwrites checkout-only edits", async ({ command, result }) => {
    fixture.result = result;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(command, "--repo", "projects/demo")).resolves.toBe(0);

    expect(logLines(log)).toContain(
      "warning: restored 1 managed path(s), overwriting checkout-only edits:"
    );
    expect(logLines(log)).toContain("  src/local.ts");
  });

  it("keeps structured push output unchanged", async () => {
    fixture.result = {
      exported: 1,
      headCommit: "abcdef012345",
      pushed: true,
      status: "in-sync",
      clobberedLocalEdits: ["src/local.ts"],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run("push", "--repo", "projects/demo", "--json")).resolves.toBe(0);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(JSON.stringify(fixture.result));
  });
});
