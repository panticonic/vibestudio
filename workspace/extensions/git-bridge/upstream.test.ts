/**
 * git-bridge UpstreamEngine unit tests.
 *
 * The engine constructs its network `GitClient` internally
 * (`new GitClient(fsp, { http })` via `this.gitClient`) — there is no injection
 * seam — so we replace the whole `@vibestudio/git` module with a fake whose
 * network methods are shared `vi.fn`s configured per test. `GitAuthError` stays
 * a real `Error` subclass so the engine's `instanceof` classification works.
 *
 * `GitBridge` is faked entirely and passed positionally; the engine only calls
 * `repoGitDir`, `exportLockedInner` and `importLockedInner` on it. The extension
 * context is an in-memory fake (Map-backed storage, an rpc that serves
 * `workspace.getConfig`, recording notifications).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitAuthError } from "@vibestudio/git";
import { UpstreamEngine } from "./upstream.js";

const STATE_FILE = "state/upstream-state.json";

// Shared network-method fakes. Hoisted so the (hoisted) vi.mock factory can
// close over them; each test resets and configures them in beforeEach/body.
const gitFns = vi.hoisted(() => ({
  push: vi.fn(),
  fetch: vi.fn(),
  resolveRef: vi.fn(),
  compareRefs: vi.fn(),
  getCurrentBranch: vi.fn(),
  setRemote: vi.fn(),
  log: vi.fn(),
  getCurrentCommit: vi.fn(),
}));

vi.mock("@vibestudio/git", () => {
  class GitAuthError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = "GitAuthError";
      this.statusCode = statusCode;
    }
  }
  class GitClient {
    push = gitFns.push;
    fetch = gitFns.fetch;
    resolveRef = gitFns.resolveRef;
    compareRefs = gitFns.compareRefs;
    getCurrentBranch = gitFns.getCurrentBranch;
    setRemote = gitFns.setRemote;
    log = gitFns.log;
    getCurrentCommit = gitFns.getCurrentCommit;
    constructor(..._args: unknown[]) {
      void _args;
    }
  }
  return { GitClient, GitAuthError };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ConfigEntry {
  repo: string;
  remote?: string;
  branch?: string;
  autoPush?: boolean;
  url?: string;
  remoteBranch?: string;
  /** When false the referenced remote is NOT declared (a broken upstream). */
  declareRemote?: boolean;
}

/** Build a WorkspaceConfig with git.remotes + git.upstreams for the entries. */
function buildConfig(entries: ConfigEntry[]): unknown {
  const remotes: Record<string, Record<string, Record<string, unknown>>> = {};
  const upstreams: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const [section, name] = entry.repo.split("/") as [string, string];
    const remote = entry.remote ?? "origin";
    if (entry.declareRemote !== false) {
      (remotes[section] ??= {})[name] ??= {};
      remotes[section]![name]![remote] = {
        url: entry.url ?? `https://github.com/acme/${name}.git`,
        branch: entry.remoteBranch ?? "main",
      };
    }
    (upstreams[section] ??= {})[name] = {
      remote,
      ...(entry.branch ? { branch: entry.branch } : {}),
      autoPush: entry.autoPush ?? false,
    };
  }
  return { git: { remotes, upstreams } };
}

function createStorage(files: Map<string, string>) {
  return {
    async mkdir() {
      /* no-op */
    },
    async readFile(p: string) {
      const value = files.get(p);
      if (value === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return value;
    },
    async writeFile(p: string, data: string | Uint8Array) {
      files.set(p, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
  };
}

function createCtx(config: unknown, opts: { files?: Map<string, string> } = {}) {
  const files = opts.files ?? new Map<string, string>();
  const notifications = { show: vi.fn(async () => "notif-id") };
  const rpc = {
    call: vi.fn(async (_target: string, method: string) => {
      if (method === "workspace.getConfig") return config;
      throw new Error(`unexpected rpc call: ${method}`);
    }),
  };
  const credentials = { gitHttp: vi.fn(() => ({ request: vi.fn() })) };
  const ctx = {
    workspace: { getInfo: async () => ({ path: "/tmp/ws" }) },
    credentials,
    notifications,
    rpc,
    storage: createStorage(files),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { ctx, files, notifications, rpc, credentials };
}

function createBridge(
  opts: {
    exportResult?: { exported: number; headCommit: string | null };
  } = {}
) {
  const exportLockedInner = vi.fn(async () => opts.exportResult ?? { exported: 1, headCommit: "head-sha" });
  const importLockedInner = vi.fn(async () => ({ stateHash: "state-hash", changed: true }));
  const repoGitDir = vi.fn(async (repo: string) => `/repos/${repo}`);
  return {
    bridge: { exportLockedInner, importLockedInner, repoGitDir },
    exportLockedInner,
    repoGitDir,
  };
}

function readStored(files: Map<string, string>): {
  version: number;
  repos: Record<string, { status?: string; lastPushedSha?: string; lastError?: string }>;
} {
  const raw = files.get(STATE_FILE);
  return raw ? JSON.parse(raw) : { version: 1, repos: {} };
}

function makeEngine(config: unknown, bridge: unknown, opts: { files?: Map<string, string> } = {}) {
  const created = createCtx(config, opts);
  const engine = new UpstreamEngine(created.ctx as never, bridge as never);
  return { engine, ...created };
}

/** Fire and drain the debounce timer + all chained async work. */
async function tick(ms = 2_100): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("UpstreamEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(gitFns)) fn.mockReset();
    gitFns.setRemote.mockResolvedValue(undefined);
    gitFns.fetch.mockResolvedValue(undefined);
    gitFns.push.mockResolvedValue(undefined);
    gitFns.resolveRef.mockResolvedValue(null);
    gitFns.compareRefs.mockResolvedValue(null);
    gitFns.getCurrentBranch.mockResolvedValue(null);
    gitFns.log.mockResolvedValue([]);
    gitFns.getCurrentCommit.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-exports without pushing when autoPush is false", async () => {
    const repo = "projects/a";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, exportLockedInner } = createBridge();
    const { engine } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await tick();

    expect(exportLockedInner).toHaveBeenCalledTimes(1);
    expect(gitFns.push).not.toHaveBeenCalled();
  });

  it("pushes the checkout's actual branch to refs/heads/<branch> when autoPush is true", async () => {
    const repo = "projects/b";
    const config = buildConfig([{ repo, autoPush: true, branch: "main" }]);
    const { bridge, exportLockedInner } = createBridge({
      exportResult: { exported: 1, headCommit: "abc123" },
    });
    // Imported repos may not be on `main`: the push must use the ACTUAL branch.
    gitFns.getCurrentBranch.mockResolvedValue("master");
    const { engine } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await tick();

    expect(exportLockedInner).toHaveBeenCalledTimes(1);
    expect(gitFns.push).toHaveBeenCalledTimes(1);
    expect(gitFns.push).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "origin",
        ref: "master",
        remoteRef: "refs/heads/main",
        force: false,
      })
    );
  });

  it("coalesces rapid onMainAdvanced calls for the same repo into one export", async () => {
    const repo = "projects/c";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, exportLockedInner } = createBridge();
    const { engine } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    engine.onMainAdvanced([repo]);
    await tick();

    expect(exportLockedInner).toHaveBeenCalledTimes(1);
  });

  it("skips the wire push when the exported head is already the last-pushed sha", async () => {
    const repo = "projects/d";
    const config = buildConfig([{ repo, autoPush: true }]);
    const files = new Map<string, string>([
      [STATE_FILE, JSON.stringify({ version: 1, repos: { [repo]: { lastPushedSha: "same-sha" } } })],
    ]);
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "same-sha" } });
    const { engine } = makeEngine(config, bridge, { files });

    // Auto job: exports, but the head equals lastPushedSha so no wire push.
    engine.onMainAdvanced([repo]);
    await tick();
    expect(gitFns.push).not.toHaveBeenCalled();

    // Manual push: same skip, reports pushed:false without touching the wire.
    const result = await engine.pushUpstream(repo);
    expect(result.pushed).toBe(false);
    expect(gitFns.push).not.toHaveBeenCalled();
  });

  it("marks auth-failed with a notification and no retry when push hits GitAuthError", async () => {
    const repo = "projects/e";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge, exportLockedInner } = createBridge();
    gitFns.push.mockRejectedValue(new GitAuthError("401 Unauthorized", 401));
    const { engine, files, notifications } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await tick();

    expect(readStored(files).repos[repo]?.status).toBe("auth-failed");
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: expect.stringContaining("failed") })
    );

    // No retry timer was scheduled: further time passes with no new attempts.
    const exportsSoFar = exportLockedInner.mock.calls.length;
    const pushesSoFar = gitFns.push.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(exportLockedInner).toHaveBeenCalledTimes(exportsSoFar);
    expect(gitFns.push).toHaveBeenCalledTimes(pushesSoFar);
  });

  it("marks diverged on a non-fast-forward push, then keeps exporting but pauses the push", async () => {
    const repo = "projects/f";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge, exportLockedInner } = createBridge();
    gitFns.push.mockRejectedValue(new Error("Updates were rejected: non-fast-forward"));
    const { engine, files, notifications } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await tick();

    expect(readStored(files).repos[repo]?.status).toBe("diverged");
    expect(notifications.show).toHaveBeenCalledTimes(1);
    expect(exportLockedInner).toHaveBeenCalledTimes(1);
    expect(gitFns.push).toHaveBeenCalledTimes(1);

    // Next auto job still EXPORTS (keeps the checkout current) but the wire
    // push stays paused while diverged.
    gitFns.push.mockClear();
    engine.onMainAdvanced([repo]);
    await tick();

    expect(exportLockedInner).toHaveBeenCalledTimes(2);
    expect(gitFns.push).not.toHaveBeenCalled();
  });

  it("marks error and schedules a 30s backoff retry on a generic network failure", async () => {
    const repo = "projects/g";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge, exportLockedInner } = createBridge();
    gitFns.push.mockRejectedValue(new Error("ECONNRESET: connection reset by peer"));
    const { engine, files } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    // Advance exactly the debounce so the 30s backoff timer is scheduled at a
    // known instant (t = 2000 + 30000) and the boundary assertions below line up.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(readStored(files).repos[repo]?.status).toBe("error");
    expect(exportLockedInner).toHaveBeenCalledTimes(1);

    // Backoff is 30s for the first transient failure: nothing fires before it.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(exportLockedInner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exportLockedInner).toHaveBeenCalledTimes(2);
  });

  it("persists lastPushedSha so a fresh engine over the same storage reads it back", async () => {
    const repo = "projects/h";
    const config = buildConfig([{ repo, autoPush: true }]);
    const files = new Map<string, string>();
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "persist-sha" } });
    const { engine } = makeEngine(config, bridge, { files });

    engine.onMainAdvanced([repo]);
    await tick();
    expect(gitFns.push).toHaveBeenCalledTimes(1);

    // A brand-new engine over the same storage map must recover the sha.
    const bridge2 = createBridge().bridge;
    const ctx2 = createCtx(config, { files }).ctx;
    const engine2 = new UpstreamEngine(ctx2 as never, bridge2 as never);
    const rows = await engine2.upstreamStatus([repo]);
    expect(rows[0]?.lastPushedSha).toBe("persist-sha");
  });

  it("tolerates a broken upstream declaration during activate and reports it as error", async () => {
    const healthy = "projects/ok";
    const broken = "projects/bad";
    const config = buildConfig([
      { repo: healthy, autoPush: false },
      { repo: broken, declareRemote: false }, // upstream references an undeclared remote
    ]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);

    await expect(engine.activate()).resolves.toBeUndefined();

    const rows = await engine.upstreamStatus();
    const brokenRow = rows.find((row) => row.repoPath === broken);
    const healthyRow = rows.find((row) => row.repoPath === healthy);
    expect(brokenRow?.state).toBe("error");
    expect(healthyRow).toBeDefined();
    expect(healthyRow?.state).not.toBe("error");
  });

  it("clears the running state after an export failure", async () => {
    const repo = "projects/i";
    const config = buildConfig([{ repo, autoPush: true }]);
    const exportLockedInner = vi.fn(async () => {
      throw new Error("export blew up");
    });
    const bridge = {
      exportLockedInner,
      importLockedInner: vi.fn(),
      repoGitDir: vi.fn(async (r: string) => `/repos/${r}`),
    };
    const { engine } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await tick();

    const rows = await engine.upstreamStatus([repo]);
    expect(rows[0]?.state).not.toBe("exporting");
    expect(rows[0]?.state).not.toBe("pushing");
  });

  it("does not fetch for status by default, but fetches when asked", async () => {
    const repo = "projects/j";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);

    await engine.upstreamStatus([repo]);
    expect(gitFns.fetch).not.toHaveBeenCalled();

    await engine.upstreamStatus([repo], { fetch: true });
    expect(gitFns.fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes cross-repo state writes so two concurrent failures both survive", async () => {
    const repoA = "projects/rmwa";
    const repoB = "projects/rmwb";
    const config = buildConfig([
      { repo: repoA, autoPush: true },
      { repo: repoB, autoPush: true },
    ]);
    const { bridge } = createBridge();
    gitFns.push.mockImplementation(async (opts: { dir: string }) => {
      if (opts.dir.endsWith("rmwa")) throw new GitAuthError("auth boom", 401);
      throw new Error("non-fast-forward: rejected");
    });
    const { engine, files } = makeEngine(config, bridge);

    engine.onMainAdvanced([repoA, repoB]);
    await tick();

    const stored = readStored(files).repos;
    expect(stored[repoA]?.status).toBe("auth-failed");
    expect(stored[repoB]?.status).toBe("diverged");
  });
});
