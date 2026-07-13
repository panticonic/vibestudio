import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

interface RpcRequest {
  method: string;
  args: unknown[];
  type?: "call";
  targetId?: string;
}

/** The resolved DO target for the userland `vcs` manifest service (P3 push
 *  flip): `push` dispatches here (workers.resolveService → DO vcsPush), not the
 *  host `vcs.push` service. */
const VCS_DO_TARGET = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";
const VCS_SERVICE_RESOLUTION = {
  kind: "durable-object",
  name: "vcs",
  source: "workers/gad-store",
  className: "GadWorkspaceDO",
  objectKey: "workspace-gad",
  targetId: VCS_DO_TARGET,
};

const transportMock = vi.hoisted(() => ({
  handle: null as ((body: RpcRequest) => unknown) | null,
  rpcBodies: [] as RpcRequest[],
}));

vi.mock("../webrtcClient.js", () => ({
  WebRtcRpcClient: class {
    async ready(): Promise<void> {}

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
      return await this.dispatch<T>({ method, args });
    }

    async callTarget<T = unknown>(
      targetId: string,
      method: string,
      args: unknown[] = []
    ): Promise<T> {
      return await this.dispatch<T>({ type: "call", targetId, method, args });
    }

    async close(): Promise<void> {}

    private async dispatch<T>(body: RpcRequest): Promise<T> {
      transportMock.rpcBodies.push(body);
      if (!transportMock.handle) throw new Error("WebRTC test server is not configured");
      return (await transportMock.handle(body)) as T;
    }
  },
}));

/** Configure the deterministic WebRTC RPC boundary used by paired CLI credentials. */
function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  transportMock.rpcBodies = [];
  transportMock.handle = handle;
  return { rpcBodies: transportMock.rpcBodies };
}

function writeCredentials(tmpDir: string): void {
  const dir = path.join(tmpDir, ".config", "vibestudio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 3,
      kind: "device",
      url: "webrtc://room-cli/_workspace/dev",
      workspaceName: "dev",
      serverId: `srv_${"S".repeat(24)}`,
      deviceId: `dev_${"D".repeat(24)}`,
      refreshToken: "R".repeat(43),
      controlPairing: {
        room: "room-control",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      workspacePairing: {
        room: "room-cli",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      pairedAt: 1,
    })
  );
}

function writeSession(tmpDir: string, name = "default"): void {
  const dir = path.join(tmpDir, ".config", "vibestudio", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      serverUrl: "webrtc://room-cli/_workspace/dev",
      entityId: `session:${name}`,
      contextId: "ctx_1",
      scopeKey: name,
      createdAt: 1,
    })
  );
}

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

function withTtyStdout<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return fn().finally(() => {
    if (original) {
      Object.defineProperty(process.stdout, "isTTY", original);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
}

describe("vibestudio vcs commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-vcs-cli-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected network request from WebRTC CLI test");
      })
    );
    clearShellTokenCache();
    transportMock.handle = null;
    transportMock.rpcBodies = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status calls vcs.status with positional (repoPath, head) args", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // Server returns committed and working deltas separately; JSON mode passes
    // the canonical wire shape through unchanged.
    const statusResult = {
      committedStateHash: "state:abc123",
      workingStateHash: "state:abc123",
      dirty: true,
      uncommitted: 0,
      committed: { added: [], removed: [], changed: ["index.ts"] },
      working: { added: [], removed: [], changed: [] },
      diverged: false,
      behind: false,
      deleted: false,
      pendingMerge: null,
    };
    const { rpcBodies } = stubServer(() => statusResult);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "vcs.status", args: ["panels/notes", "ctx:ctx_1"] }]);
    expect(jsonOutput()).toEqual(statusResult);
  });

  it("diff renders name-status output from vcs.status (added/changed/removed)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      left: "state:main",
      right: "state:working",
      files: [
        { path: "new.ts", status: "added", binary: false, hunks: [] },
        { path: "index.ts", status: "changed", binary: false, hunks: [] },
        { path: "old.ts", status: "removed", binary: false, hunks: [] },
      ],
      unified: "",
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "diff", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "vcs.diffContent",
        args: [
          {
            repoPath: "panels/notes",
            head: "ctx:ctx_1",
            scope: "all",
            contextLines: 0,
          },
        ],
      },
    ]);
    expect(jsonOutput()).toBe("A\tnew.ts\nM\tindex.ts\nD\told.ts");
  });

  it("honors --session for non-default sessions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir, "work");
    const { rpcBodies } = stubServer(() => ({
      committedStateHash: null,
      workingStateHash: null,
      dirty: false,
      uncommitted: 0,
      committed: { added: [], removed: [], changed: [] },
      working: { added: [], removed: [], changed: [] },
      diverged: false,
      behind: false,
      deleted: false,
      pendingMerge: null,
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "status", "--repo", "panels/notes", "--session", "work", "--json"])
    ).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.status", args: ["panels/notes", "ctx:ctx_1"] });
  });

  it("status renders uncommitted-only dirty state in human output", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      committedStateHash: "state:committed",
      workingStateHash: "state:working",
      dirty: true,
      uncommitted: 2,
      committed: { added: [], removed: [], changed: [] },
      working: { added: [], removed: [], changed: ["index.ts"] },
      diverged: false,
      behind: false,
      deleted: false,
      pendingMerge: null,
    }));

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "status", "--repo", "panels/notes"])).resolves.toBe(0);
    });

    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs).toContain("U\t2 uncommitted working edit(s)");
    expect(logs).not.toContain("clean (in sync with main)");
  });

  it("commit treats unchanged/no-op responses as errors", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer((body) => {
      if (body.method === "vcs.commit") {
        return [
          {
            repoPath: "panels/notes",
            head: "ctx:ctx_1",
            stateHash: "state:same",
            eventId: null,
            headHash: null,
            editCount: 0,
            status: "unchanged",
            changedPaths: [],
          },
        ];
      }
      return null;
    });

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "commit", "-m", "noop", "--repo", "panels/notes", "--json"])
    ).resolves.toBe(1);

    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain("commit produced no snapshots");
    expect(errors.join("\n")).toContain("scratch/direct fs writes");
  });

  it("push --repo (single) dispatches USERLAND: resolves the vcs service, then calls the DO's vcsPush", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      status: "pushed",
      repoPaths: ["panels/notes"],
      reports: [
        {
          repoPath: "panels/notes",
          kind: "panel",
          role: "pushed",
          required: true,
          status: "ok",
          builds: [{ target: "runtime", diagnostics: [] }],
        },
      ],
    };
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : result
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    // Hop 1: resolve the vcs manifest service (userland dispatch, P3 flip).
    expect(rpcBodies[0]).toEqual({
      method: "workers.resolveService",
      args: ["vibestudio.vcs.v1", null],
    });
    // Hop 2: the build-gated push against the resolved DO target.
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: VCS_DO_TARGET,
      method: "vcsPush",
      args: [{ repoPaths: ["panels/notes"], sourceHead: "ctx:ctx_1" }],
    });
    expect(jsonOutput()).toEqual(result);
  });

  it("repeated --repo forms an atomic group push (all repos in one DO call)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : { status: "pushed", repoPaths: ["packages/core", "panels/notes"], reports: [] }
    );

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "push", "--repo", "packages/core", "--repo", "panels/notes", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: VCS_DO_TARGET,
      method: "vcsPush",
      args: [{ repoPaths: ["packages/core", "panels/notes"], sourceHead: "ctx:ctx_1" }],
    });
  });

  it("a build-failed push exits non-zero and still emits the full result under --json", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      status: "build-failed",
      reports: [
        {
          repoPath: "panels/notes",
          kind: "panel",
          role: "pushed",
          required: true,
          status: "failed",
          builds: [
            {
              target: "runtime",
              diagnostics: [
                {
                  source: "tsc",
                  severity: "error",
                  file: "panels/notes/index.tsx",
                  line: 12,
                  column: 5,
                  message: "Type 'string' is not assignable to type 'number'.",
                },
              ],
            },
          ],
        },
      ],
    };
    stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : result
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
    expect(jsonOutput()).toEqual(result);
  });

  it("a diverged push exits non-zero", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : {
            status: "diverged",
            divergences: [
              {
                repoPath: "panels/notes",
                base: "state:base",
                mainTip: "state:main",
                upstreamCommits: [
                  {
                    eventId: "evt-1",
                    message: "main moved",
                    stateHash: "state:main",
                    createdAt: null,
                  },
                ],
                mergeable: "conflict",
                conflictPaths: ["panels/notes/index.tsx"],
              },
            ],
          }
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
  });

  it("diverged push human output separates clean merge from conflict commit steps", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : {
            status: "diverged",
            divergences: [
              {
                repoPath: "panels/notes",
                base: "state:base",
                mainTip: "state:main",
                upstreamCommits: [
                  {
                    eventId: "evt-1",
                    message: "main moved",
                    stateHash: "state:main",
                    createdAt: null,
                  },
                ],
                mergeable: "clean",
              },
            ],
          }
    );

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "push", "--repo", "panels/notes"])).resolves.toBe(1);
    });

    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(
      errors.some((line) =>
        line.includes(
          "Reconcile with `vibestudio vcs merge --repo REPOPATH`, then push. " +
            "If the merge conflicts, resolve markers and commit before pushing."
        )
      )
    ).toBe(true);
  });

  it("merge human output distinguishes clean and conflicting resolution steps", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => [
      {
        repoPath: "panels/notes",
        status: "merged",
        mergeable: "clean",
        upstreamCommits: [
          { eventId: "evt-1", message: "main moved", stateHash: "state:main", createdAt: null },
        ],
      },
    ]);

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "merge", "--repo", "panels/notes"])).resolves.toBe(0);
    });

    expect(rpcBodies[0]).toEqual({
      method: "vcs.merge",
      args: [{ source: "main", repoPaths: ["panels/notes"], head: "ctx:ctx_1" }],
    });
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(
      logs.some((line) => line.includes("clean merge committed — push now fast-forwards."))
    ).toBe(true);
    expect(logs).not.toContain("clean merge — `vcs commit` then push (now fast-forwards).");
  });

  it("push-status renders uncommitted, diverged, and deleted blockers", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => [
      {
        repoPath: "panels/notes",
        head: "ctx:ctx_1",
        headStateHash: "state:head",
        mainStateHash: "state:main",
        ahead: 0,
        uncommitted: 2,
        uncommittedPaths: ["draft.ts"],
        diverged: false,
        behind: false,
        deleted: false,
        files: [],
      },
      {
        repoPath: "packages/lib",
        head: "ctx:ctx_1",
        headStateHash: "state:lib",
        mainStateHash: "state:main-lib",
        ahead: 1,
        uncommitted: 0,
        uncommittedPaths: [],
        diverged: true,
        behind: false,
        deleted: true,
        files: [{ path: "index.ts", kind: "changed" }],
      },
    ]);

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(
        main(["vcs", "push-status", "--repo", "panels/notes", "--repo", "packages/lib"])
      ).resolves.toBe(0);
    });

    expect(rpcBodies[0]).toEqual({
      method: "vcs.pushStatus",
      args: [["panels/notes", "packages/lib"]],
    });
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs).toContain("panels/notes: 2 uncommitted working edit(s)");
    expect(logs).toContain("  commit or discard uncommitted edits before push");
    expect(logs).toContain("packages/lib: DELETED, diverged, 1 unpushed change(s)");
    expect(logs).toContain("  merge/rebase this context before push");
    expect(logs).toContain(
      "  repo was deleted from workspace main; restore it or drop/rebase this context"
    );
    expect(logs).not.toContain("panels/notes: clean (in sync with main)");
  });

  it("log dispatches USERLAND: resolves the vcs manifest service, then calls the DO's vcsLog", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? {
            kind: "durable-object",
            name: "vcs",
            source: "workers/gad-store",
            className: "GadWorkspaceDO",
            objectKey: "workspace-gad",
            targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
          }
        : [{ stateHash: "state:1", parent: null, message: "init", timestamp: 1 }]
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "log", "--repo", "meta", "--json"])).resolves.toBe(0);
    // Hop 1: the single typed-host bootstrap hop (resolve the manifest service).
    expect(rpcBodies[0]).toEqual({
      method: "workers.resolveService",
      args: ["vibestudio.vcs.v1", null],
    });
    // Hop 2: positional (repoPath, limit?) against the resolved DO target;
    // no --limit ⇒ limit serializes to null.
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
      method: "vcsLog",
      args: ["meta", null],
    });
  });

  it("fork-repo dispatches USERLAND: resolves the vcs service, then calls the DO's vcsForkRepo", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : {
            repoPath: "panels/mychat",
            head: "main",
            inherited: 3,
            stateHash: "state:fork",
          }
    );

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "fork-repo", "panels/chat", "panels/mychat", "--json"])
    ).resolves.toBe(0);
    // Hop 1: resolve the vcs manifest service (userland dispatch, Phase 4 flip).
    expect(rpcBodies[0]).toEqual({
      method: "workers.resolveService",
      args: ["vibestudio.vcs.v1", null],
    });
    // Hop 2: the history-preserving fork against the resolved DO target.
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: VCS_DO_TARGET,
      method: "vcsForkRepo",
      args: [{ fromPath: "panels/chat", toPath: "panels/mychat" }],
    });
  });

  it("delete-repo dispatches USERLAND: resolves the vcs service, then calls the DO's vcsDeleteRepo", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : {
            repoPath: "panels/old",
            archived: true,
            archiveHead: "archived:state:doomed",
            removedPaths: ["panels/old/index.tsx"],
            dependents: [],
            stateHash: "state:after",
          }
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "delete-repo", "--repo", "panels/old", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({
      method: "workers.resolveService",
      args: ["vibestudio.vcs.v1", null],
    });
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: VCS_DO_TARGET,
      method: "vcsDeleteRepo",
      args: [{ repoPath: "panels/old" }],
    });
  });

  it("restore-repo dispatches USERLAND: resolves the vcs service, then calls the DO's vcsRestoreRepo", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      (body as { method?: string }).method === "workers.resolveService"
        ? VCS_SERVICE_RESOLUTION
        : {
            repoPath: "panels/old",
            restored: true,
            fromArchiveHead: "archived:state:doomed",
            restoredPaths: ["panels/old/index.tsx"],
            stateHash: "state:after",
          }
    );

    const { main } = await import("../client.js");
    await expect(main(["vcs", "restore-repo", "--repo", "panels/old", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({
      method: "workers.resolveService",
      args: ["vibestudio.vcs.v1", null],
    });
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: VCS_DO_TARGET,
      method: "vcsRestoreRepo",
      args: [{ repoPath: "panels/old" }],
    });
  });

  it("context-status calls vcs.contextStatus and renders forked/ahead/behind", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = [
      { repoPath: "panels/chat", forked: true, ahead: true, behind: false },
      { repoPath: "packages/ui", forked: false, ahead: false, behind: true },
    ];
    const { rpcBodies } = stubServer(() => result);
    const { main } = await import("../client.js");
    await expect(main(["vcs", "context-status", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.contextStatus", args: [] });
    expect(jsonOutput()).toEqual(result);
  });

  it("rebase calls vcs.rebaseContext", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      repos: [{ repoPath: "panels/chat", status: "merged" }],
      baseView: "state:newbase",
    }));
    const { main } = await import("../client.js");
    await expect(main(["vcs", "rebase", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.rebaseContext", args: [] });
  });

  it("rebase conflict human output tells users to commit before re-push", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      repos: [{ repoPath: "panels/chat", status: "conflicted" }],
      baseView: "state:newbase",
    }));
    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "rebase"])).resolves.toBe(0);
    });

    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(
      logs.some((line) =>
        line.includes(
          "1 repo(s) conflicted — resolve the markers, commit the resolution, then re-push."
        )
      )
    ).toBe(true);
  });

  it("git status dispatches to gitInterop.upstreamStatus and emits JSON rows", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const rows = [
      {
        repoPath: "panels/notes",
        remote: "origin",
        branch: "main",
        autoPush: false,
        state: "in-sync",
        aheadBy: 0,
        behindBy: 0,
        lastPushedSha: "abc1234",
        lastPushedAt: 123,
      },
    ];
    const { rpcBodies } = stubServer(() => rows);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "git", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies).toEqual([
      {
        method: "gitInterop.upstreamStatus",
        args: [["panels/notes"], { fetch: true }],
      },
    ]);
    expect(jsonOutput()).toEqual(rows);
  });

  it("git push --force dispatches to gitInterop.pushUpstream and exits zero for pushed in-sync results", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      exported: 1,
      headCommit: "abc1234",
      pushed: true,
      status: "in-sync",
    };
    const { rpcBodies } = stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "git", "push", "--repo", "panels/notes", "--force", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "gitInterop.pushUpstream",
        args: ["panels/notes", { force: true }],
      },
    ]);
    expect(jsonOutput()).toEqual(result);
  });

  it("git import sends the branch only inside the canonical remote object", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      path: "projects/demo",
      remote: {
        name: "origin",
        url: "https://github.com/werg/demo.git",
        branch: "feature/import",
      },
    };
    const { rpcBodies } = stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(
      main([
        "vcs",
        "git",
        "import",
        "https://github.com/werg/demo.git",
        "--path",
        "projects/demo",
        "--branch",
        "feature/import",
        "--credential",
        "cred-github",
        "--json",
      ])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "gitInterop.importProject",
        args: [
          {
            path: "projects/demo",
            remote: {
              name: "origin",
              url: "https://github.com/werg/demo.git",
              branch: "feature/import",
            },
            credentialId: "cred-github",
          },
        ],
      },
    ]);
    expect(jsonOutput()).toEqual(result);
  });

  it("git remote set dispatches to gitInterop.setSharedRemote with the declared remote", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      repoPath: "panels/notes",
      remote: {
        name: "origin",
        url: "https://github.com/werg/notes.git",
        branch: "main",
      },
    };
    const { rpcBodies } = stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(
      main([
        "vcs",
        "git",
        "remote",
        "set",
        "--repo",
        "panels/notes",
        "--url",
        "https://github.com/werg/notes.git",
        "--branch",
        "main",
        "--json",
      ])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "gitInterop.setSharedRemote",
        args: [
          "panels/notes",
          {
            name: "origin",
            url: "https://github.com/werg/notes.git",
            branch: "main",
          },
        ],
      },
    ]);
    expect(jsonOutput()).toEqual(result);
  });

  it("git status --help renders nested status usage", async () => {
    const { main } = await import("../client.js");
    await expect(main(["vcs", "git", "status", "--help"])).resolves.toBe(0);

    const logs = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(logs).toContain("Usage: vibestudio vcs git status [--repo REPOPATH ...]");
    expect(logs).not.toContain("Usage: vibestudio vcs git <status|enable");
  });

  it("maps failures to the exit-code conventions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");

    // Missing --repo is a usage error. `commit` and the old `git` group were dropped
    // (FS-snapshot commit was retired — fs writes route through GAD), so they are unknown
    // commands and also usage-error.
    await expect(main(["vcs", "status", "--json"])).resolves.toBe(2);
    await expect(main(["git", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(2);

    // A server-side RPC failure maps to exit 1.
    stubServer(() => {
      throw new Error("workspace VCS unavailable");
    });
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
  });
});
