import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { GitAuthError, GitClient } from "@vibestudio/git";
import {
  getDeclaredRemoteForRepo,
  getDeclaredRemotesForRepo,
  getDeclaredUpstreamForRepo,
  listDeclaredUpstreams,
  normalizeWorkspaceRepoPath,
  validateWorkspaceGitRemoteBranch,
  validateWorkspaceGitRemoteName,
  type ResolvedWorkspaceGitUpstream,
} from "@vibestudio/shared/workspace/remotes";
import {
  WORKSPACE_IMPORT_PARENT_DIRS,
  assertWorkspaceCreateTargetSafe,
  isSupportedImportRepoPath,
  resolveWorkspaceRepoPath,
} from "@vibestudio/shared/workspace/pathPolicy";
import type {
  GitOverwritePreview,
  GitUpstreamState,
  GitUpstreamStatusRow,
} from "@vibestudio/shared/gitUpstream";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/shared/workspace/types";
import { getRemoteProvider } from "@workspace/integrations/remoteProviders";
import { GitBridge, type ExportResult, type ImportResult } from "./bridge.js";
import type { ExtensionContextLike } from "./context.js";
import { withRepoLock } from "./repoLocks.js";

const STATE_FILE = "state/upstream-state.json";
const GIT_BRIDGE_EXTENSION = "@workspace-extensions/git-bridge";
const DEFAULT_BRANCH = "main";
const TRANSIENT_BACKOFF_MIN_MS = 30_000;
const TRANSIENT_BACKOFF_MAX_MS = 15 * 60_000;

export type UpstreamStatusState = GitUpstreamState;

interface StoredRepoState {
  lastPushedSha?: string;
  lastPushedAt?: number;
  status?: UpstreamStatusState;
  lastError?: string;
}

interface StoredState {
  version: 1;
  repos: Record<string, StoredRepoState>;
}

interface RuntimeRepoState {
  running?: UpstreamStatusState;
  backoffMs?: number;
  retryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export type UpstreamStatusRow = GitUpstreamStatusRow;

export interface UpstreamStatusOptions {
  remote?: string;
  branch?: string;
  credentialId?: string;
  fetch?: boolean;
}

export interface PublishRepoInput {
  repoPath: string;
  provider?: string;
  name?: string;
  private?: boolean;
  description?: string;
  remote?: string;
  branch?: string;
  credentialId?: string;
  authorEmail?: string;
  authorName?: string;
  autoPush?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export class UpstreamEngine {
  private runtime = new Map<string, RuntimeRepoState>();
  private stateWrite = Promise.resolve();

  constructor(
    private readonly ctx: ExtensionContextLike,
    private readonly bridge: GitBridge
  ) {}

  async activate(): Promise<void> {
    const config = await this.readConfig();
    // Tolerant enumeration: one unresolvable declaration must not stop the
    // engine from serving every other repo.
    for (const entry of listDeclaredUpstreams(config)) {
      if (entry.upstream) this.enqueue(entry.repoPath, 100);
    }
    await this.reportHealth();
  }

  onMainAdvanced(repoPaths: string[]): void {
    for (const repoPath of repoPaths) this.enqueue(repoPath);
  }

  async pushUpstream(
    repoPath: string,
    opts: { force?: boolean } = {}
  ): Promise<
    ExportResult & { pushed: boolean; status: UpstreamStatusState; overwrites?: OverwritePreview }
  > {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    return withRepoLock(repo, async () => {
      try {
        const result = await this.syncLocked(repo, { push: true, force: opts.force });
        await this.reportHealth();
        return {
          ...result.exported,
          pushed: result.pushed,
          status: "in-sync",
          ...(result.overwrites ? { overwrites: result.overwrites } : {}),
        };
      } catch (err) {
        await this.handlePushFailure(repo, err, opts.force === true);
        throw err;
      }
    });
  }

  /**
   * The one export→push sequence, shared by manual pushes and auto jobs.
   * Callers hold the repo lock and own failure classification. Pushes the
   * checkout's ACTUAL branch (imported repos may not be on `main`) to the
   * declared upstream branch. Skips the wire push when the exported head is
   * already the last-pushed commit (unless forcing).
   */
  private async syncLocked(
    repo: string,
    opts: { push: boolean; force?: boolean }
  ): Promise<{ exported: ExportResult; pushed: boolean; overwrites?: OverwritePreview }> {
    const config = await this.readConfig();
    const upstream = this.requireUpstream(config, repo);
    const remote = this.requireRemote(config, repo, upstream.remote);
    const git = this.gitClient(upstream.credentialId);
    const dir = await this.bridge.repoGitDir(repo);
    await this.ensureGitRemote(git, dir, remote);
    let exported: ExportResult;
    this.setRunning(repo, "exporting");
    try {
      exported = await this.bridge.exportLockedInner(repo, {
        authorEmail: upstream.authorEmail,
        authorName: upstream.authorName,
      });
    } finally {
      this.clearRunning(repo);
    }
    if (!opts.push || !exported.headCommit) {
      return { exported, pushed: false };
    }
    const stored = (await this.readState()).repos[repo];
    if (!opts.force && exported.headCommit === stored?.lastPushedSha) {
      await this.updateRepoState(repo, { status: "in-sync", lastError: undefined });
      return { exported, pushed: false };
    }
    let overwrites: OverwritePreview | undefined;
    if (opts.force) {
      overwrites = await this.previewOverwrites(git, dir, upstream, exported.headCommit);
    }
    const localRef = (await git.getCurrentBranch(dir)) ?? DEFAULT_BRANCH;
    this.setRunning(repo, "pushing");
    try {
      const pushGit = opts.force
        ? this.gitClient(upstream.credentialId, { force: true, overwrites })
        : git;
      await pushGit.push({
        dir,
        remote: upstream.remote,
        ref: localRef,
        remoteRef: `refs/heads/${upstream.branch}`,
        force: opts.force ?? false,
      });
    } finally {
      this.clearRunning(repo);
    }
    await this.updateRepoState(repo, {
      status: "in-sync",
      lastError: undefined,
      lastPushedSha: exported.headCommit,
      lastPushedAt: Date.now(),
    });
    this.clearBackoff(repo);
    return { exported, pushed: true, ...(overwrites ? { overwrites } : {}) };
  }

  private clearBackoff(repo: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime) {
      runtime.backoffMs = undefined;
      runtime.retryAt = undefined;
    }
  }

  async pullUpstream(
    repoPath: string,
    opts: { dryRun?: boolean } = {}
  ): Promise<{
    behindBy: number;
    aheadBy: number;
    incoming: Array<{ sha: string; summary: string }>;
    imported?: ImportResult;
  }> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    return withRepoLock(repo, async () => {
      const config = await this.readConfig();
      const resolved = this.requireUpstream(config, repo);
      const dir = await this.bridge.repoGitDir(repo);
      const git = this.gitClient(resolved.credentialId);
      const remote = this.requireRemote(config, repo, resolved.remote);
      await this.ensureGitRemote(git, dir, remote);
      await git.fetch({ dir, remote: resolved.remote, ref: resolved.branch });
      const remoteRef = `refs/remotes/${resolved.remote}/${resolved.branch}`;
      const remoteHead = await git.resolveRef(dir, remoteRef);
      if (!remoteHead) {
        // The upstream branch doesn't exist yet — nothing to pull.
        return { behindBy: 0, aheadBy: 1, incoming: [] };
      }
      const tracking = (await git.compareRefs(dir, "HEAD", remoteRef)) ?? {
        // Both refs exist with no merge base: unrelated histories.
        ahead: 1,
        behind: 1,
        diverged: true,
      };
      const incoming = await this.commitSummaries(git, dir, remoteRef, tracking.behind);
      if (opts.dryRun) {
        return { behindBy: tracking.behind, aheadBy: tracking.ahead, incoming };
      }
      try {
        if (tracking.diverged) {
          await git.pull({
            dir,
            remote: resolved.remote,
            ref: resolved.branch,
            author: this.gitAuthor(resolved),
          });
        } else {
          await git.fastForward({ dir, remote: resolved.remote, ref: resolved.branch });
        }
      } catch (err) {
        await this.handlePullFailure(repo, err);
        throw err;
      }
      const head = await git.getCurrentCommit(dir);
      const imported = await this.bridge.importLockedInner(repo, {
        summary: `Pull ${resolved.remote}/${resolved.branch}${head ? ` @ ${head.slice(0, 7)}` : ""}`,
      });
      const postPull = await this.aheadBehind(config, repo, resolved, { fetch: false }).catch(
        () => null
      );
      await this.updateRepoState(repo, {
        status: postPull
          ? statusFromCounts(postPull.aheadBy, postPull.behindBy, postPull.diverged)
          : "in-sync",
        lastError: undefined,
      });
      await this.reportHealth();
      return { behindBy: tracking.behind, aheadBy: tracking.ahead, incoming, imported };
    });
  }

  async upstreamStatus(
    repoPaths?: string[],
    options: UpstreamStatusOptions = {}
  ): Promise<UpstreamStatusRow[]> {
    const config = await this.readConfig();
    const repos = repoPaths?.length
      ? repoPaths.map((repo) => normalizeWorkspaceRepoPath(repo))
      : listDeclaredUpstreams(config).map((entry) => entry.repoPath);
    const state = await this.readState();
    return Promise.all(
      repos.map(async (repo) => {
        const runtime = this.runtime.get(repo);
        const stored = state.repos[repo] ?? {};
        let resolved: ResolvedWorkspaceGitUpstream | null = null;
        try {
          resolved = getDeclaredUpstreamForRepo(config, repo);
        } catch (err) {
          return {
            repoPath: repo,
            autoPush: false,
            state: "error" as const,
            aheadBy: 0,
            behindBy: 0,
            lastError: err instanceof Error ? err.message : String(err),
          };
        }
        if (!resolved) {
          return {
            repoPath: repo,
            autoPush: false,
            state: "local-only" as const,
            aheadBy: 0,
            behindBy: 0,
          };
        }
        resolved = this.applyStatusOptions(config, repo, resolved, options);
        let counts: { aheadBy: number; behindBy: number; diverged: boolean };
        let statusError: { state: "auth-failed" | "error"; message: string } | null = null;
        try {
          counts = await this.aheadBehind(config, repo, resolved, options);
        } catch (err) {
          counts = { aheadBy: 0, behindBy: 0, diverged: false };
          statusError = {
            state:
              err instanceof GitAuthError || /credential|auth|401|403/i.test(errorMessage(err))
                ? "auth-failed"
                : "error",
            message: errorMessage(err),
          };
        }
        // A persisted failure (the thing pausing auto-push) outranks live
        // counts: showing "ahead" while pushes are paused would lie to the
        // user. It clears on the next successful push/pull.
        const storedFailure =
          stored.status === "diverged" ||
          stored.status === "auth-failed" ||
          stored.status === "error"
            ? stored.status
            : undefined;
        const computed =
          runtime?.running ??
          statusError?.state ??
          storedFailure ??
          statusFromCounts(counts.aheadBy, counts.behindBy, counts.diverged);
        return {
          repoPath: repo,
          remote: resolved.remote,
          branch: resolved.branch,
          autoPush: resolved.autoPush,
          state: computed,
          aheadBy: counts.aheadBy,
          behindBy: counts.behindBy,
          lastPushedSha: stored.lastPushedSha,
          lastPushedAt: stored.lastPushedAt,
          lastError: statusError?.message ?? stored.lastError,
        };
      })
    );
  }

  async publishRepo(input: PublishRepoInput): Promise<{
    repoPath: string;
    provider: string;
    remote: string;
    branch: string;
    remoteUrl: string;
    webUrl: string;
    owner: string;
    exported: number;
    headCommit: string | null;
    pushed: boolean;
  }> {
    if (input.dryRun) {
      throw new Error("publishRepo dryRun is not supported because publishing creates a remote repo");
    }
    const repo = normalizeWorkspaceRepoPath(input.repoPath);
    const providerId = input.provider ?? "github";
    const provider = getRemoteProvider(providerId);
    if (!provider) throw new Error(`Unknown remote provider: ${providerId}`);
    const repoName = (input.name ?? repo.split("/").at(-1) ?? repo).split("/").at(-1) ?? repo;
    const remoteName = input.remote
      ? validateWorkspaceGitRemoteName(input.remote)
      : "origin";
    const branch = input.branch ? validateWorkspaceGitRemoteBranch(input.branch) : DEFAULT_BRANCH;
    const created = await provider.createRepo(this.ctx.credentials, {
      name: repoName,
      private: input.private ?? true,
      description: input.description,
    });
    await this.setRemote(repo, {
      name: remoteName,
      url: created.cloneUrl,
      branch,
    });
    await this.setUpstream(repo, {
      remote: remoteName,
      branch,
      autoPush: input.autoPush ?? false,
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.authorEmail ? { authorEmail: input.authorEmail } : {}),
      ...(input.authorName ? { authorName: input.authorName } : {}),
    });
    let pushed;
    try {
      pushed = await this.pushUpstream(repo, { force: input.force });
    } catch (err) {
      // The remote repo and the remote/upstream config all exist at this
      // point — don't unwind them; tell the caller how to finish.
      throw new Error(
        `Created ${created.webUrl} and configured ${repo}, but the first push failed: ` +
          `${errorMessage(err)}. Retry with \`vibestudio vcs git push --repo ${repo}\`.`
      );
    }
    return {
      repoPath: repo,
      provider: provider.id,
      remote: remoteName,
      branch,
      remoteUrl: created.cloneUrl,
      webUrl: created.webUrl,
      owner: created.owner,
      exported: pushed.exported,
      headCommit: pushed.headCommit,
      pushed: pushed.pushed,
    };
  }

  async cloneRepo(input: { repoPath: string }): Promise<ImportResult> {
    const repo = normalizeWorkspaceRepoPath(input.repoPath);
    return withRepoLock(repo, async () => {
      const config = await this.readConfig();
      const upstream = getDeclaredUpstreamForRepo(config, repo);
      if (!upstream) throw new Error(`No approved upstream is declared for ${repo}`);
      const remote = getDeclaredRemoteForRepo(config, repo, upstream.remote);
      if (!remote) throw new Error(`No approved remote ${upstream.remote} is declared for ${repo}`);
      const root = await this.workspaceRoot();
      const { absolutePath } = resolveWorkspaceRepoPath(root, repo);
      if (!isSupportedImportRepoPath(repo)) {
        throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
      }
      try {
        await fsp.access(absolutePath);
        throw new Error(`Path already exists: ${repo}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      assertWorkspaceCreateTargetSafe(root, absolutePath, "cloneRepo");
      await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
      try {
        const git = this.gitClient(upstream.credentialId);
        await git.clone({
          url: remote.url,
          dir: absolutePath,
          ref: upstream.branch ?? remote.branch,
          depth: undefined,
        });
        if (remote.name !== "origin") {
          await git.addRemote(absolutePath, remote.name, remote.url).catch(() => undefined);
        }
        return await this.bridge.importLockedInner(repo, {
          summary: `Import ${repo} from ${displayRemote(remote.url)}`,
        });
      } catch (err) {
        await fsp.rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    });
  }

  async importRepo(input: {
    url: string;
    path: string;
    branch?: string;
    credentialId?: string;
  }): Promise<unknown> {
    return this.ctx.rpc.call("main", "gitInterop.importProject", {
      path: input.path,
      remote: { name: "origin", url: input.url, ...(input.branch ? { branch: input.branch } : {}) },
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    });
  }

  async setUpstream(repoPath: string, config: WorkspaceGitUpstreamConfig): Promise<unknown> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const result = await this.ctx.rpc.call("main", "gitInterop.setUpstream", repo, config);
    await this.updateRepoState(repo, { status: undefined, lastError: undefined });
    return result;
  }

  async removeUpstream(repoPath: string): Promise<unknown> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const result = await this.ctx.rpc.call("main", "gitInterop.removeUpstream", repo);
    await this.mutateState((state) => {
      delete state.repos[repo];
    });
    await this.reportHealth();
    return result;
  }

  async setAutoPush(repoPath: string, on = true): Promise<unknown> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const config = await this.readConfig();
    const upstream = this.requireUpstream(config, repo);
    return this.setUpstream(repo, {
      remote: upstream.remote,
      branch: upstream.branch,
      autoPush: on,
      ...(upstream.credentialId ? { credentialId: upstream.credentialId } : {}),
      ...(upstream.authorEmail ? { authorEmail: upstream.authorEmail } : {}),
      ...(upstream.authorName ? { authorName: upstream.authorName } : {}),
    });
  }

  async setRemote(repoPath: string, remote: WorkspaceGitRemoteConfig): Promise<unknown> {
    return this.ctx.rpc.call(
      "main",
      "gitInterop.setSharedRemote",
      normalizeWorkspaceRepoPath(repoPath),
      remote
    );
  }

  async removeRemote(repoPath: string, remoteName = "origin"): Promise<unknown> {
    return this.ctx.rpc.call(
      "main",
      "gitInterop.removeSharedRemote",
      normalizeWorkspaceRepoPath(repoPath),
      remoteName
    );
  }

  async openGitTab(repoPath?: string): Promise<{
    opened: false;
    repoPath?: string;
    openPanel: { source: string; stateArgs?: Record<string, unknown>; name?: string };
  }> {
    const normalized = repoPath ? normalizeWorkspaceRepoPath(repoPath) : undefined;
    return {
      opened: false,
      ...(normalized ? { repoPath: normalized } : {}),
      openPanel: {
        source: "panels/gad-browser",
        name: "Git upstreams",
        ...(normalized ? { stateArgs: { gitRepo: normalized } } : { stateArgs: { gitRepo: "" } }),
      },
    };
  }

  private enqueue(repoPath: string, delayMs = 2_000): void {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const runtime = this.runtime.get(repo) ?? {};
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      const current = this.runtime.get(repo);
      if (current) delete current.timer;
      void this.runAutoJob(repo).catch((err) => {
        this.ctx.log.warn?.("git upstream auto job failed", {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    this.runtime.set(repo, runtime);
  }

  private async runAutoJob(repo: string): Promise<void> {
    const runtime = this.runtime.get(repo);
    if (runtime?.retryAt && Date.now() < runtime.retryAt) {
      this.enqueue(repo, runtime.retryAt - Date.now());
      return;
    }
    const config = await this.readConfig();
    let upstream: ResolvedWorkspaceGitUpstream | null;
    try {
      upstream = getDeclaredUpstreamForRepo(config, repo);
    } catch (err) {
      // Broken declaration (e.g. remote removed): surface via status, keep
      // serving every other repo.
      await this.updateRepoState(repo, { status: "error", lastError: errorMessage(err) });
      return;
    }
    if (!upstream) return;
    // Tracking always exports (local-only, keeps the checkout current);
    // divergence/auth failures pause only the WIRE push, never the export.
    const stored = (await this.readState()).repos[repo];
    const paused = stored?.status === "diverged" || stored?.status === "auth-failed";
    const wantPush = upstream.autoPush && !paused;
    await withRepoLock(repo, async () => {
      try {
        await this.syncLocked(repo, { push: wantPush });
      } catch (err) {
        await this.handleAutoFailure(repo, upstream, err);
      } finally {
        await this.reportHealth();
      }
    });
  }

  private async handlePushFailure(repo: string, err: unknown, force: boolean): Promise<void> {
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(errorMessage(err))) {
      await this.updateRepoState(repo, { status: "auth-failed", lastError: errorMessage(err) });
      await this.reportHealth();
      return;
    }
    if (
      !force &&
      /non-fast-forward|failed to push|not fast-forward|PushRejected|rejected/i.test(
        errorMessage(err)
      )
    ) {
      await this.updateRepoState(repo, { status: "diverged", lastError: errorMessage(err) });
      await this.reportHealth();
      return;
    }
    await this.updateRepoState(repo, { status: "error", lastError: errorMessage(err) });
    await this.reportHealth();
  }

  private async handlePullFailure(repo: string, err: unknown): Promise<void> {
    const message = errorMessage(err);
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(message)) {
      await this.updateRepoState(repo, { status: "auth-failed", lastError: message });
      await this.reportHealth();
      return;
    }
    if (/merge|conflict|non-fast-forward|not fast-forward|diverg/i.test(message)) {
      const guidance =
        `Pull could not merge upstream changes automatically: ${message}. ` +
        `Resolve the conflict in the workspace/<repo> checkout with git tooling and re-run pull, ` +
        `or push --force to overwrite upstream.`;
      await this.updateRepoState(repo, { status: "diverged", lastError: guidance });
      await this.reportHealth();
      return;
    }
    await this.updateRepoState(repo, { status: "error", lastError: message });
    await this.reportHealth();
  }

  private async handleAutoFailure(
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    err: unknown
  ): Promise<void> {
    const message = errorMessage(err);
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(message)) {
      await this.updateRepoState(repo, { status: "auth-failed", lastError: message });
      await this.showFailureNotification(repo, upstream, message);
      return;
    }
    if (/non-fast-forward|failed to push|not fast-forward|PushRejected|rejected/i.test(message)) {
      await this.updateRepoState(repo, { status: "diverged", lastError: message });
      await this.showFailureNotification(repo, upstream, message);
      return;
    }
    const runtime = this.runtime.get(repo) ?? {};
    const nextBackoff = Math.min(
      runtime.backoffMs ? runtime.backoffMs * 2 : TRANSIENT_BACKOFF_MIN_MS,
      TRANSIENT_BACKOFF_MAX_MS
    );
    runtime.backoffMs = nextBackoff;
    runtime.retryAt = Date.now() + nextBackoff;
    this.runtime.set(repo, runtime);
    await this.updateRepoState(repo, { status: "error", lastError: message });
    this.enqueue(repo, nextBackoff);
  }

  private async showFailureNotification(
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    reason: string
  ): Promise<void> {
    const remote = `${upstream.remote}/${upstream.branch}`;
    await this.ctx.notifications.show({
      id: `git-upstream:${encodeURIComponent(repo)}`,
      type: "warning",
      title: `Push to ${remote} failed`,
      message: reason,
      actions: [
        {
          id: "retry",
          label: "Retry",
          invoke: {
            kind: "extension",
            extension: GIT_BRIDGE_EXTENSION,
            method: "pushUpstream",
            args: [repo, {}],
          },
        },
        {
          id: "open-git-tab",
          label: "Open Git tab",
          invoke: {
            kind: "extension",
            extension: GIT_BRIDGE_EXTENSION,
            method: "openGitTab",
            args: [repo],
          },
        },
        {
          id: "pause-auto-push",
          label: "Pause auto-push",
          invoke: {
            kind: "extension",
            extension: GIT_BRIDGE_EXTENSION,
            method: "setAutoPush",
            args: [repo, false],
          },
        },
      ],
    });
  }

  private async previewOverwrites(
    git: GitClient,
    dir: string,
    upstream: ResolvedWorkspaceGitUpstream,
    localHead: string
  ): Promise<OverwritePreview> {
    await git.fetch({ dir, remote: upstream.remote, ref: upstream.branch });
    const remoteRef = `refs/remotes/${upstream.remote}/${upstream.branch}`;
    const remoteHead = await git.resolveRef(dir, remoteRef);
    if (!remoteHead || remoteHead === localHead) return { count: 0, commits: [] };
    const counts = await git.compareRefs(dir, "HEAD", remoteRef);
    const count = counts?.behind ?? 0;
    return {
      count,
      commits: await this.commitSummaries(git, dir, remoteRef, Math.min(count, 20)),
    };
  }

  private async commitSummaries(
    git: GitClient,
    dir: string,
    ref: string,
    limit: number
  ): Promise<Array<{ sha: string; summary: string }>> {
    if (limit <= 0) return [];
    const commits = await git.log(dir, { ref, depth: limit });
    return commits.map((commit) => ({
      sha: commit.oid,
      summary: firstLine(commit.message),
    }));
  }

  /**
   * Local comparison against the remote-tracking ref. Does NOT fetch unless
   * asked (`fetch: true`) — status surfaces poll this, and a poll must never
   * turn into per-repo network traffic.
   */
  private async aheadBehind(
    config: WorkspaceConfig,
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    options: { fetch?: boolean } = {}
  ): Promise<{ aheadBy: number; behindBy: number; diverged: boolean }> {
    const dir = await this.bridge.repoGitDir(repo);
    const git = this.gitClient(upstream.credentialId);
    const remote = this.requireRemote(config, repo, upstream.remote);
    await this.ensureGitRemote(git, dir, remote);
    if (options.fetch === true) {
      await git.fetch({ dir, remote: upstream.remote, ref: upstream.branch });
    }
    const remoteRef = `refs/remotes/${upstream.remote}/${upstream.branch}`;
    const remoteHead = await git.resolveRef(dir, remoteRef);
    if (!remoteHead) {
      // Nothing known upstream (never fetched, or the branch doesn't exist
      // yet): everything local is ahead — NOT diverged.
      return { aheadBy: 1, behindBy: 0, diverged: false };
    }
    const counts = await git.compareRefs(dir, "HEAD", remoteRef);
    // Both refs exist but share no merge base: genuinely unrelated histories.
    if (!counts) return { aheadBy: 1, behindBy: 1, diverged: true };
    return { aheadBy: counts.ahead, behindBy: counts.behind, diverged: counts.diverged };
  }

  private setRunning(repo: string, state: UpstreamStatusState): void {
    const runtime = this.runtime.get(repo) ?? {};
    runtime.running = state;
    this.runtime.set(repo, runtime);
  }

  private clearRunning(repo: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime) delete runtime.running;
  }

  private requireUpstream(config: WorkspaceConfig, repo: string): ResolvedWorkspaceGitUpstream {
    const upstream = getDeclaredUpstreamForRepo(config, repo);
    if (!upstream) throw new Error(`No upstream is configured for ${repo}`);
    return upstream;
  }

  private requireRemote(
    config: WorkspaceConfig,
    repo: string,
    remoteName: string
  ): WorkspaceGitRemoteConfig {
    const remote = getDeclaredRemoteForRepo(config, repo, remoteName);
    if (!remote) throw new Error(`No approved remote ${remoteName} is declared for ${repo}`);
    return remote;
  }

  private applyStatusOptions(
    config: WorkspaceConfig,
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    options: UpstreamStatusOptions
  ): ResolvedWorkspaceGitUpstream {
    const remoteName = options.remote
      ? validateWorkspaceGitRemoteName(options.remote)
      : upstream.remote;
    const remote = this.requireRemote(config, repo, remoteName);
    const branch = options.branch
      ? validateWorkspaceGitRemoteBranch(options.branch)
      : remoteName === upstream.remote
        ? upstream.branch
        : (remote.branch ?? DEFAULT_BRANCH);
    return {
      ...upstream,
      remote: remoteName,
      branch,
      ...(options.credentialId ? { credentialId: options.credentialId } : {}),
    };
  }

  private async ensureGitRemote(
    git: GitClient,
    dir: string,
    remote: WorkspaceGitRemoteConfig
  ): Promise<void> {
    await git.setRemote(dir, remote.name, remote.url);
  }

  private async readConfig(): Promise<WorkspaceConfig> {
    const config = await this.ctx.rpc.call<WorkspaceConfig | null>("main", "workspace.getConfig");
    if (!config) throw new Error("Workspace config is unavailable");
    return config;
  }

  private async workspaceRoot(): Promise<string> {
    return (await this.ctx.workspace.getInfo()).path;
  }

  private gitClient(
    credentialId?: string,
    gitIntent?: { force: boolean; overwrites?: OverwritePreview }
  ): GitClient {
    return new GitClient(fsp, {
      http: this.gitHttp(credentialId, gitIntent),
    });
  }

  private gitHttp(
    credentialId?: string,
    gitIntent?: { force: boolean; overwrites?: OverwritePreview }
  ) {
    return this.ctx.credentials.gitHttp({
      ...(credentialId ? { credentialId } : {}),
      ...(gitIntent ? { gitIntent } : {}),
    });
  }

  private gitAuthor(
    upstream: ResolvedWorkspaceGitUpstream
  ): { name: string; email: string } | undefined {
    if (!upstream.authorName && !upstream.authorEmail) return undefined;
    return {
      name: upstream.authorName ?? "Vibestudio Git Bridge",
      email: upstream.authorEmail ?? "git-bridge@vibestudio.local",
    };
  }

  private async readState(): Promise<StoredState> {
    try {
      const raw = await this.ctx.storage.readFile(STATE_FILE, "utf8");
      const parsed = JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf8")
      ) as StoredState;
      return parsed.version === 1 && parsed.repos ? parsed : { version: 1, repos: {} };
    } catch {
      return { version: 1, repos: {} };
    }
  }

  /** Serializes the WHOLE read-modify-write: concurrent per-repo jobs share
   *  one state file, so an unserialized read would clobber sibling repos. */
  private mutateState(mutate: (state: StoredState) => void): Promise<void> {
    const run = this.stateWrite.then(async () => {
      const state = await this.readState();
      mutate(state);
      await this.ctx.storage.mkdir("state", { recursive: true });
      await this.ctx.storage.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    });
    this.stateWrite = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private updateRepoState(repo: string, patch: StoredRepoState): Promise<void> {
    return this.mutateState((state) => {
      const current = state.repos[repo] ?? {};
      const next = { ...current, ...patch };
      if (patch.status === undefined) delete next.status;
      if (patch.lastError === undefined) delete next.lastError;
      state.repos[repo] = next;
    });
  }

  private async reportHealth(): Promise<void> {
    if (!this.ctx.health) return;
    const state = await this.readState();
    const degraded = Object.entries(state.repos)
      .filter(([, repo]) => repo.status === "auth-failed" || repo.status === "diverged")
      .map(([repo, status]) => `${repo}: ${status.status}`);
    if (degraded.length === 0) {
      this.ctx.health.healthy({ summary: "git upstream healthy" });
      return;
    }
    this.ctx.health.report("degraded", {
      summary: "git upstream attention required",
      reasons: degraded,
    });
  }
}

export type OverwritePreview = GitOverwritePreview;

function statusFromCounts(
  aheadBy: number,
  behindBy: number,
  diverged = aheadBy > 0 && behindBy > 0
): UpstreamStatusState {
  if (diverged) return "diverged";
  if (aheadBy > 0) return "ahead";
  if (behindBy > 0) return "behind";
  return "in-sync";
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() || "(no summary)";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayRemote(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.replace(/\.git$/, "")}`;
  } catch {
    return url;
  }
}
