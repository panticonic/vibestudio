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
import { GitAuthError, GitPushRejectedError } from "@vibestudio/git";
import { UpstreamEngine } from "./upstream.js";

const STATE_FILE = "state/upstream-state.json";

// Shared network-method fakes. Hoisted so the (hoisted) vi.mock factory can
// close over them; each test resets and configures them in beforeEach/body.
const gitFns = vi.hoisted(() => ({
  push: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  fastForward: vi.fn(),
  resolveRef: vi.fn(),
  compareRefs: vi.fn(),
  getCurrentBranch: vi.fn(),
  log: vi.fn(),
  getCurrentCommit: vi.fn(),
  diffCommits: vi.fn(),
  getRemoteDefaultBranch: vi.fn(),
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
  class GitPushRejectedError extends Error {
    reasons: string[];
    constructor(message: string, reasons: string[] = []) {
      super(message);
      this.name = "GitPushRejectedError";
      this.reasons = reasons;
    }
  }
  class GitClient {
    push = gitFns.push;
    fetch = gitFns.fetch;
    pull = gitFns.pull;
    fastForward = gitFns.fastForward;
    resolveRef = gitFns.resolveRef;
    compareRefs = gitFns.compareRefs;
    getCurrentBranch = gitFns.getCurrentBranch;
    log = gitFns.log;
    getCurrentCommit = gitFns.getCurrentCommit;
    diffCommits = gitFns.diffCommits;
    getRemoteDefaultBranch = gitFns.getRemoteDefaultBranch;
    constructor(..._args: unknown[]) {
      void _args;
    }
  }
  return { GitClient, GitAuthError, GitPushRejectedError };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ConfigEntry {
  repo: string;
  remote?: string;
  branch?: string;
  autoPush?: boolean;
  credentialId?: string;
  authorEmail?: string;
  authorName?: string;
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
      ...(entry.credentialId ? { credentialId: entry.credentialId } : {}),
      ...(entry.authorEmail ? { authorEmail: entry.authorEmail } : {}),
      ...(entry.authorName ? { authorName: entry.authorName } : {}),
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

function createCtx(
  config: unknown,
  opts: {
    files?: Map<string, string>;
    health?: { report: ReturnType<typeof vi.fn>; healthy: ReturnType<typeof vi.fn> };
  } = {}
) {
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
    name: "@workspace-extensions/custom-git-provider",
    workspace: { getInfo: async () => ({ path: "/tmp/ws" }) },
    credentials,
    notifications,
    rpc,
    storage: createStorage(files),
    log: { info: vi.fn(), warn: vi.fn() },
    ...(opts.health ? { health: opts.health } : {}),
  };
  return { ctx, files, notifications, rpc, credentials };
}

function createBridge(
  opts: {
    exportResult?: { exported: number; headCommit: string | null; clobberedLocalEdits?: string[] };
  } = {}
) {
  const exportLockedInner = vi.fn(async () => ({
    clobberedLocalEdits: [],
    ...(opts.exportResult ?? { exported: 1, headCommit: "head-sha" }),
  }));
  const importLockedInner = vi.fn(async () => ({ stateHash: "state-hash", changed: true }));
  const repoGitDir = vi.fn(async (repo: string) => `/repos/${repo}`);
  const checkoutExists = vi.fn(async () => true);
  return {
    bridge: { exportLockedInner, importLockedInner, repoGitDir, checkoutExists },
    exportLockedInner,
    importLockedInner,
    repoGitDir,
    checkoutExists,
  };
}

function readStored(files: Map<string, string>): {
  version: number;
  repos: Record<
    string,
    {
      configFingerprint?: string;
      status?: string;
      lastPushedSha?: string;
      lastPushedAt?: number;
      lastError?: string;
      lastFailureAt?: number;
      nextRetryAt?: number;
    }
  >;
} {
  const raw = files.get(STATE_FILE);
  return raw ? JSON.parse(raw) : { version: 2, repos: {} };
}

function makeEngine(
  config: unknown,
  bridge: unknown,
  opts: {
    files?: Map<string, string>;
    health?: { report: ReturnType<typeof vi.fn>; healthy: ReturnType<typeof vi.fn> };
  } = {}
) {
  const created = createCtx(config, opts);
  const engine = new UpstreamEngine(created.ctx as never, bridge as never);
  return { engine, ...created };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fire and drain the debounce timer + all chained async work. */
async function tick(ms = 2_100): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("UpstreamEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(gitFns)) fn.mockReset();
    gitFns.fetch.mockResolvedValue(undefined);
    gitFns.pull.mockResolvedValue(undefined);
    gitFns.fastForward.mockResolvedValue(undefined);
    gitFns.push.mockResolvedValue(undefined);
    gitFns.resolveRef.mockResolvedValue(null);
    gitFns.compareRefs.mockResolvedValue(null);
    gitFns.getCurrentBranch.mockResolvedValue(null);
    gitFns.log.mockResolvedValue([]);
    gitFns.getCurrentCommit.mockResolvedValue(null);
    gitFns.diffCommits.mockResolvedValue([]);
    gitFns.getRemoteDefaultBranch.mockResolvedValue(null);
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
        url: "https://github.com/acme/b.git",
        remote: expect.stringMatching(/^vibestudio-[a-f0-9]{24}$/),
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

  it("does not cancel a queued main-advance job when a manual push succeeds", async () => {
    const repo = "projects/queued-after-push";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge, exportLockedInner } = createBridge();
    const enteredPush = deferred();
    const releasePush = deferred();
    gitFns.push.mockImplementationOnce(async () => {
      enteredPush.resolve();
      await releasePush.promise;
    });
    const { engine } = makeEngine(config, bridge);

    const manualPush = engine.pushUpstream(repo);
    await enteredPush.promise;
    engine.onMainAdvanced([repo]);
    releasePush.resolve();
    await manualPush;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(exportLockedInner).toHaveBeenCalledTimes(2);
  });

  it("skips the wire push when the exported head is already the last-pushed sha", async () => {
    const repo = "projects/d";
    const config = buildConfig([{ repo, autoPush: true }]);
    const files = new Map<string, string>();
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "same-sha" } });
    const { engine } = makeEngine(config, bridge, { files });

    // First push records a v2 state entry scoped to this declared upstream.
    await expect(engine.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    expect(gitFns.push).toHaveBeenCalledTimes(1);
    gitFns.push.mockClear();

    // A fresh engine using the same config and storage trusts that state.
    const engine2 = makeEngine(config, bridge, { files }).engine;

    // Auto job: exports, but the head equals lastPushedSha so no wire push.
    engine2.onMainAdvanced([repo]);
    await tick();
    expect(gitFns.push).not.toHaveBeenCalled();

    // Manual push: same skip, reports pushed:false without touching the wire.
    const result = await engine2.pushUpstream(repo);
    expect(result.pushed).toBe(false);
    expect(gitFns.push).not.toHaveBeenCalled();
  });

  it("ignores version 1 state instead of migrating its last-pushed sha", async () => {
    const repo = "projects/v1-cut";
    const config = buildConfig([{ repo, autoPush: true }]);
    const files = new Map<string, string>([
      [
        STATE_FILE,
        JSON.stringify({ version: 1, repos: { [repo]: { lastPushedSha: "same-sha" } } }),
      ],
    ]);
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "same-sha" } });
    const { engine } = makeEngine(config, bridge, { files });

    await expect(engine.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });

    expect(gitFns.push).toHaveBeenCalledTimes(1);
    expect(readStored(files)).toMatchObject({
      version: 2,
      repos: {
        [repo]: {
          configFingerprint: expect.any(String),
          lastPushedSha: "same-sha",
        },
      },
    });
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
      expect.objectContaining({
        type: "warning",
        title: expect.stringContaining("failed"),
        actions: expect.arrayContaining([
          expect.objectContaining({
            invoke: {
              kind: "extension",
              extension: "@workspace-extensions/custom-git-provider",
              method: "retryUpstreamPush",
              args: [repo],
            },
          }),
          expect.objectContaining({
            invoke: {
              kind: "extension",
              extension: "@workspace-extensions/custom-git-provider",
              method: "pauseAutoPush",
              args: [repo],
            },
          }),
        ]),
      })
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
    // Typed rejection + a confirming remote comparison: divergence policy is
    // never decided from error prose alone.
    gitFns.push.mockRejectedValue(
      new GitPushRejectedError("Updates were rejected: non-fast-forward")
    );
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 1, behind: 2, diverged: true });
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

  it("forces the same head to each changed remote URL and upstream branch", async () => {
    const repo = "projects/config-scope";
    const files = new Map<string, string>();
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "stable-head" } });
    const initialConfig = buildConfig([
      { repo, autoPush: true, url: "https://github.com/acme/first.git", branch: "main" },
    ]);
    const first = makeEngine(initialConfig, bridge, { files }).engine;

    await expect(first.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    const firstFingerprint = readStored(files).repos[repo]?.configFingerprint;
    expect(firstFingerprint).toEqual(expect.any(String));

    gitFns.push.mockClear();
    const changedRemoteConfig = buildConfig([
      { repo, autoPush: true, url: "https://github.com/acme/second.git", branch: "main" },
    ]);
    const second = makeEngine(changedRemoteConfig, bridge, { files }).engine;
    await expect(second.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    expect(gitFns.push).toHaveBeenCalledTimes(1);
    expect(gitFns.push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://github.com/acme/second.git",
        remote: expect.stringMatching(/^vibestudio-[a-f0-9]{24}$/),
      })
    );
    const secondFingerprint = readStored(files).repos[repo]?.configFingerprint;
    expect(secondFingerprint).not.toBe(firstFingerprint);

    gitFns.push.mockClear();
    const changedBranchConfig = buildConfig([
      { repo, autoPush: true, url: "https://github.com/acme/second.git", branch: "release" },
    ]);
    const third = makeEngine(changedBranchConfig, bridge, { files }).engine;
    await expect(third.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    expect(gitFns.push).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRef: "refs/heads/release" })
    );
    expect(readStored(files).repos[repo]?.configFingerprint).not.toBe(secondFingerprint);
  });

  it("clears a persisted failure when declared upstream configuration changes", async () => {
    const repo = "projects/failure-scope";
    const files = new Map<string, string>();
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "retry-head" } });
    const initialConfig = buildConfig([{ repo, autoPush: true, credentialId: "old-credential" }]);
    const first = makeEngine(initialConfig, bridge, { files }).engine;
    gitFns.push.mockRejectedValueOnce(new GitAuthError("401 Unauthorized", 401));

    await expect(first.pushUpstream(repo)).rejects.toThrow("401 Unauthorized");
    expect(readStored(files).repos[repo]?.status).toBe("auth-failed");

    gitFns.push.mockReset();
    gitFns.push.mockResolvedValue(undefined);
    const changedConfig = buildConfig([{ repo, autoPush: true, credentialId: "new-credential" }]);
    const second = makeEngine(changedConfig, bridge, { files }).engine;
    const [status] = await second.upstreamStatus([repo]);

    expect(status?.state).not.toBe("auth-failed");
    expect(status?.state).not.toBe("diverged");
    expect(status?.lastError).toBeUndefined();
    expect(readStored(files).repos[repo]).not.toHaveProperty("status");
    await expect(second.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    expect(gitFns.push).toHaveBeenCalledTimes(1);
  });

  it("clears runtime retry backoff when the declared remote changes", async () => {
    const repo = "projects/backoff-scope";
    const config = buildConfig([
      { repo, autoPush: true, url: "https://github.com/acme/before.git" },
    ]) as { git: unknown };
    const { bridge, exportLockedInner } = createBridge({
      exportResult: { exported: 1, headCommit: "backoff-head" },
    });
    const { engine, files } = makeEngine(config, bridge);
    gitFns.push.mockRejectedValue(new Error("ECONNRESET"));

    engine.onMainAdvanced([repo]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readStored(files).repos[repo]?.status).toBe("error");
    expect(exportLockedInner).toHaveBeenCalledTimes(1);

    gitFns.push.mockReset();
    gitFns.push.mockResolvedValue(undefined);
    config.git = (
      buildConfig([{ repo, autoPush: true, url: "https://github.com/acme/after.git" }]) as {
        git: unknown;
      }
    ).git;
    engine.onMainAdvanced([repo]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(exportLockedInner).toHaveBeenCalledTimes(2);
    expect(gitFns.push).toHaveBeenCalledTimes(1);
    expect(readStored(files).repos[repo]).toMatchObject({
      status: "in-sync",
      lastPushedSha: "backoff-head",
    });
  });

  it("does not rescope or reuse persisted state for status-only overrides", async () => {
    const repo = "projects/status-override";
    const config = buildConfig([{ repo, autoPush: true, branch: "main" }]);
    const files = new Map<string, string>();
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "same-head" } });
    const { engine } = makeEngine(config, bridge, { files });

    await expect(engine.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });
    const fingerprint = readStored(files).repos[repo]?.configFingerprint;
    gitFns.push.mockClear();

    const [status] = await engine.upstreamStatus([repo], {
      branch: "preview-only",
      credentialId: "status-only-credential",
    });
    expect(status?.branch).toBe("preview-only");
    expect(status?.lastPushedSha).toBeUndefined();
    expect(status?.lastPushedAt).toBeUndefined();
    expect(status?.lastError).toBeUndefined();
    expect(readStored(files).repos[repo]?.configFingerprint).toBe(fingerprint);

    await expect(engine.pushUpstream(repo)).resolves.toMatchObject({ pushed: false });
    expect(gitFns.push).not.toHaveBeenCalled();
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

    const rows = await engine.upstreamStatus([]);
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
      checkoutExists: vi.fn(async () => true),
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

  it("reuses only a successful fresh fetch for the same effective target", async () => {
    const repo = "projects/status-fetch-ttl";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);

    await engine.upstreamStatus([repo], { fetch: true, ttlMs: 60_000 });
    await engine.upstreamStatus([repo], { fetch: true, ttlMs: 60_000 });
    expect(gitFns.fetch).toHaveBeenCalledTimes(1);

    await engine.upstreamStatus([repo], {
      fetch: true,
      ttlMs: 60_000,
      branch: "other",
    });
    expect(gitFns.fetch).toHaveBeenCalledTimes(2);

    await engine.upstreamStatus([repo], { fetch: true, ttlMs: 0 });
    expect(gitFns.fetch).toHaveBeenCalledTimes(3);
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
      throw new GitPushRejectedError("non-fast-forward: rejected");
    });
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 1, behind: 1, diverged: true });
    const { engine, files } = makeEngine(config, bridge);

    engine.onMainAdvanced([repoA, repoB]);
    await tick();

    const stored = readStored(files).repos;
    expect(stored[repoA]?.status).toBe("auth-failed");
    expect(stored[repoB]?.status).toBe("diverged");
  });

  it("binds each push to its captured URL and fingerprint-specific transport remote", async () => {
    const repo = "projects/immutable-route";
    const config = buildConfig([
      { repo, autoPush: true, url: "https://example.com/before.git" },
    ]) as { git: unknown };
    const enteredExport = deferred();
    const releaseExport = deferred();
    let exportCount = 0;
    const bridge = {
      repoGitDir: vi.fn(async () => `/repos/${repo}`),
      importLockedInner: vi.fn(),
      checkoutExists: vi.fn(async () => true),
      exportLockedInner: vi.fn(async () => {
        exportCount += 1;
        if (exportCount === 1) {
          enteredExport.resolve();
          await releaseExport.promise;
        }
        return { exported: 1, headCommit: "stable-head", clobberedLocalEdits: [] };
      }),
    };
    const { engine } = makeEngine(config, bridge);

    const firstPush = engine.pushUpstream(repo);
    await enteredExport.promise;
    config.git = (
      buildConfig([{ repo, autoPush: true, url: "https://example.com/after.git" }]) as {
        git: unknown;
      }
    ).git;
    releaseExport.resolve();
    await firstPush;
    await engine.pushUpstream(repo);

    const firstOptions = gitFns.push.mock.calls[0]?.[0] as {
      url: string;
      remote: string;
    };
    const secondOptions = gitFns.push.mock.calls[1]?.[0] as {
      url: string;
      remote: string;
    };
    expect(firstOptions.url).toBe("https://example.com/before.git");
    expect(secondOptions.url).toBe("https://example.com/after.git");
    expect(firstOptions.remote).toMatch(/^vibestudio-[a-f0-9]{24}$/);
    expect(secondOptions.remote).toMatch(/^vibestudio-[a-f0-9]{24}$/);
    expect(secondOptions.remote).not.toBe(firstOptions.remote);
  });

  it("re-reads auto-push only after acquiring the repo lock", async () => {
    const repo = "projects/locked-auto-policy";
    const config = buildConfig([{ repo, autoPush: true }]) as { git: unknown };
    const enteredExport = deferred();
    const releaseExport = deferred();
    let exportCount = 0;
    const bridge = {
      repoGitDir: vi.fn(async () => `/repos/${repo}`),
      importLockedInner: vi.fn(),
      checkoutExists: vi.fn(async () => true),
      exportLockedInner: vi.fn(async () => {
        exportCount += 1;
        if (exportCount === 1) {
          enteredExport.resolve();
          await releaseExport.promise;
        }
        return { exported: 1, headCommit: `head-${exportCount}`, clobberedLocalEdits: [] };
      }),
    };
    const { engine } = makeEngine(config, bridge);

    const manualPush = engine.pushUpstream(repo);
    await enteredExport.promise;
    engine.onMainAdvanced([repo]);
    await vi.advanceTimersByTimeAsync(2_000);
    config.git = (buildConfig([{ repo, autoPush: false }]) as { git: unknown }).git;
    releaseExport.resolve();
    await manualPush;
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.exportLockedInner).toHaveBeenCalledTimes(2);
    expect(gitFns.push).toHaveBeenCalledTimes(1);
  });

  it("classifies pull fetch authentication failures in fingerprint-scoped state", async () => {
    const repo = "projects/pull-auth";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge();
    const { engine, files } = makeEngine(config, bridge);
    gitFns.fetch.mockRejectedValueOnce(new GitAuthError("403 Forbidden", 403));

    await expect(engine.pullUpstream(repo)).rejects.toThrow("403 Forbidden");

    expect(readStored(files).repos[repo]).toMatchObject({
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "auth-failed",
      lastError: "403 Forbidden",
    });
  });

  it("pulls the remote branch into the checkout's actual local branch", async () => {
    const repo = "projects/pull-branch-parity";
    const config = buildConfig([{ repo, autoPush: false, branch: "release" }]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 0, behind: 1, diverged: false });
    gitFns.getCurrentBranch.mockResolvedValue("master");

    await engine.pullUpstream(repo);

    expect(gitFns.fastForward).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://github.com/acme/pull-branch-parity.git",
        remote: expect.stringMatching(/^vibestudio-[a-f0-9]{24}$/),
        ref: "master",
        remoteRef: "release",
      })
    );
  });

  it("discards malformed version 2 state instead of accepting legacy-shaped fields", async () => {
    const repo = "projects/strict-v2";
    const config = buildConfig([{ repo, autoPush: true }]);
    const files = new Map<string, string>([
      [
        STATE_FILE,
        JSON.stringify({
          version: 2,
          repos: {
            [repo]: {
              configFingerprint: "0".repeat(64),
              lastPushedSha: "same-head",
              running: "pushing",
            },
          },
        }),
      ],
    ]);
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "same-head" } });
    const { engine } = makeEngine(config, bridge, { files });

    await expect(engine.pushUpstream(repo)).resolves.toMatchObject({ pushed: true });

    expect(gitFns.push).toHaveBeenCalledTimes(1);
    expect(readStored(files).repos[repo]).not.toHaveProperty("running");
  });

  it("reports recovered health when a configuration change clears a persisted failure", async () => {
    const repo = "projects/health-scope";
    const config = buildConfig([{ repo, autoPush: true, credentialId: "bad" }]) as {
      git: unknown;
    };
    const health = { report: vi.fn(), healthy: vi.fn() };
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge, { health });
    gitFns.push.mockRejectedValueOnce(new GitAuthError("401 Unauthorized", 401));

    await expect(engine.pushUpstream(repo)).rejects.toThrow("401 Unauthorized");
    expect(health.report).toHaveBeenLastCalledWith(
      "degraded",
      expect.objectContaining({ reasons: [`${repo}: auth-failed`] })
    );

    config.git = (
      buildConfig([{ repo, autoPush: true, credentialId: "good" }]) as { git: unknown }
    ).git;
    await engine.upstreamStatus([repo]);

    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "git upstream healthy" });
  });

  it("clears an authentication pause after a successful declared-target status fetch", async () => {
    const repo = "projects/health-fetch";
    const config = buildConfig([{ repo, autoPush: true }]);
    const health = { report: vi.fn(), healthy: vi.fn() };
    const { bridge } = createBridge();
    const { engine, files } = makeEngine(config, bridge, { health });
    gitFns.push.mockRejectedValueOnce(new GitAuthError("401 Unauthorized", 401));
    await expect(engine.pushUpstream(repo)).rejects.toThrow("401 Unauthorized");
    expect(readStored(files).repos[repo]?.status).toBe("auth-failed");

    gitFns.resolveRef.mockResolvedValue(null);
    const [status] = await engine.upstreamStatus([repo], { fetch: true });

    expect(status?.state).toBe("ahead");
    expect(status?.lastError).toBeUndefined();
    expect(readStored(files).repos[repo]?.status).toBe("ahead");
    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "git upstream healthy" });
  });

  it("exports gad main into the checkout BEFORE judging pull divergence", async () => {
    const repo = "projects/pull-export-first";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, exportLockedInner } = createBridge();
    const { engine } = makeEngine(config, bridge);
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 0, behind: 1, diverged: false });

    await engine.pullUpstream(repo);

    expect(exportLockedInner).toHaveBeenCalledTimes(1);
    const exportOrder = exportLockedInner.mock.invocationCallOrder[0]!;
    const fetchOrder = gitFns.fetch.mock.invocationCallOrder[0]!;
    const compareOrder = gitFns.compareRefs.mock.invocationCallOrder[0]!;
    expect(exportOrder).toBeLessThan(fetchOrder);
    expect(exportOrder).toBeLessThan(compareOrder);
  });

  it("reports a missing remote branch honestly instead of fabricating aheadBy", async () => {
    const repo = "projects/pull-no-remote-branch";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);
    gitFns.resolveRef.mockResolvedValue(null);

    const result = await engine.pullUpstream(repo);

    expect(result.remoteBranchExists).toBe(false);
    expect(result.aheadBy).toBe(0);
    expect(result.behindBy).toBe(0);
    expect(result.incoming).toEqual([]);
    expect(result.imported).toBeUndefined();
  });

  it("surfaces clobbered local checkout edits on pull results", async () => {
    const repo = "projects/pull-clobber";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge({
      exportResult: {
        exported: 1,
        headCommit: "head-sha",
        clobberedLocalEdits: ["src/hand-edited.ts"],
      },
    });
    const { engine } = makeEngine(config, bridge);
    gitFns.resolveRef.mockResolvedValue(null);

    const result = await engine.pullUpstream(repo);

    expect(result.clobberedLocalEdits).toEqual(["src/hand-edited.ts"]);
  });

  it("returns status 'empty' when a push has nothing exportable, never 'in-sync'", async () => {
    const repo = "projects/empty-push";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge({ exportResult: { exported: 0, headCommit: null } });
    const { engine } = makeEngine(config, bridge);

    const result = await engine.pushUpstream(repo);

    expect(result.status).toBe("empty");
    expect(result.pushed).toBe(false);
    expect(gitFns.push).not.toHaveBeenCalled();
  });

  it("reports a declared-but-never-cloned repo as not-materialized with the fix-it command", async () => {
    const repo = "projects/never-cloned";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, checkoutExists } = createBridge();
    checkoutExists.mockResolvedValue(false);
    const { engine } = makeEngine(config, bridge);

    const [row] = await engine.upstreamStatus([repo]);

    expect(row?.state).toBe("not-materialized");
    expect(row?.lastError).toContain("vibestudio vcs git import");
    expect(row?.lastError).toContain(repo);
  });

  it("does not materialize a declared import destination during background reconciliation", async () => {
    const repo = "projects/pending-import";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, checkoutExists, exportLockedInner } = createBridge();
    checkoutExists.mockResolvedValue(false);
    const { engine } = makeEngine(config, bridge);

    await engine.activate();
    await tick(150);

    expect(checkoutExists).toHaveBeenCalledWith(repo);
    expect(exportLockedInner).not.toHaveBeenCalled();
  });

  it("degrades to fetch-failed with local counts when a requested status fetch fails offline", async () => {
    const repo = "projects/offline-status";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge } = createBridge();
    const { engine } = makeEngine(config, bridge);
    gitFns.fetch.mockRejectedValue(new Error("ENOTFOUND github.com"));
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 2, behind: 0, diverged: false });

    const [row] = await engine.upstreamStatus([repo], { fetch: true });

    expect(row?.state).toBe("fetch-failed");
    expect(row?.aheadBy).toBe(2);
    expect(row?.lastError).toContain("ENOTFOUND");
  });

  it("does NOT pause auto-push on an auth-looking message without a typed GitAuthError", async () => {
    const repo = "projects/author-not-auth";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge, exportLockedInner } = createBridge();
    // The classic false positive: "author" prose is NOT a credential failure.
    gitFns.push.mockRejectedValue(new Error("Invalid author email"));
    const { engine, files } = makeEngine(config, bridge);

    engine.onMainAdvanced([repo]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(readStored(files).repos[repo]?.status).toBe("error");
    expect(readStored(files).repos[repo]?.lastFailureAt).toEqual(expect.any(Number));
    // Retryable: the 30s transient backoff fires instead of a hard pause.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exportLockedInner).toHaveBeenCalledTimes(2);
  });

  it("exposes pendingAutoPush, lastFailureAt and nextRetryAt in status rows", async () => {
    const repo = "projects/visibility";
    const config = buildConfig([{ repo, autoPush: true }]);
    const { bridge } = createBridge({ exportResult: { exported: 1, headCommit: "vis-head" } });
    const { engine, files } = makeEngine(config, bridge);
    gitFns.push.mockRejectedValue(new Error("ECONNRESET"));

    engine.onMainAdvanced([repo]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readStored(files).repos[repo]?.status).toBe("error");

    gitFns.resolveRef.mockResolvedValue(null); // local commits exist, remote empty → ahead
    const [row] = await engine.upstreamStatus([repo]);

    expect(row?.lastFailureAt).toEqual(expect.any(Number));
    expect(row?.nextRetryAt).toEqual(expect.any(Number));
    // Stored failure outranks live counts, so state stays `error` until a
    // success or recovery fetch — pendingAutoPush reflects that honestly.
    expect(row?.pendingAutoPush).toBe(false);
    expect(row?.state).toBe("error");
  });

  it("passes gathered upstream authorship to the import after a pull", async () => {
    const repo = "projects/pull-authorship";
    const config = buildConfig([{ repo, autoPush: false }]);
    const { bridge, importLockedInner } = createBridge();
    const { engine } = makeEngine(config, bridge);
    gitFns.resolveRef.mockResolvedValue("remote-head");
    gitFns.compareRefs.mockResolvedValue({ ahead: 0, behind: 1, diverged: false });
    gitFns.getCurrentCommit
      .mockResolvedValueOnce("old-head") // pre-pull
      .mockResolvedValue("new-head"); // post-pull
    gitFns.log.mockResolvedValue([
      {
        oid: "new-head",
        message: "Fix upstream bug\n\ndetails",
        author: { name: "Ada Lovelace", email: "ada@example.com", timestamp: 1_700_000_000 },
      },
      {
        oid: "old-head",
        message: "previous",
        author: { name: "Old", email: "old@example.com", timestamp: 1_600_000_000 },
      },
    ]);
    gitFns.diffCommits.mockResolvedValue(["src/upstream.ts"]);

    await engine.pullUpstream(repo);

    expect(importLockedInner).toHaveBeenCalledWith(
      repo,
      expect.objectContaining({
        upstreamAuthorship: {
          commits: [
            {
              sha: "new-head",
              authorName: "Ada Lovelace",
              authorEmail: "ada@example.com",
              summary: "Fix upstream bug",
              committedAt: 1_700_000_000_000,
            },
          ],
          byPath: { "src/upstream.ts": "new-head" },
        },
      })
    );
  });
});
