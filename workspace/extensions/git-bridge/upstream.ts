import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { GitAuthError, GitClient, SYSTEM_GIT_AUTHOR } from "@vibestudio/git";
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
  GitPublishRepoInput,
  GitPublishRepoResult,
  GitUpstreamState,
  GitUpstreamStatusOptions,
  GitUpstreamStatusRow,
} from "@vibestudio/shared/serviceSchemas/gitInterop";
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
const DEFAULT_BRANCH = "main";
const TRANSIENT_BACKOFF_MIN_MS = 30_000;
const TRANSIENT_BACKOFF_MAX_MS = 15 * 60_000;

interface StoredRepoState {
  configFingerprint: string;
  lastPushedSha?: string;
  lastPushedAt?: number;
  status?: StoredUpstreamState;
  lastError?: string;
}
type StoredUpstreamState = Exclude<GitUpstreamState, "exporting" | "pushing" | "local-only">;
type StoredRepoStatePatch = Partial<Omit<StoredRepoState, "configFingerprint">>;

interface StoredState {
  version: 2;
  repos: Record<string, StoredRepoState>;
}

interface RuntimeRepoState {
  configFingerprint?: string;
  running?: "exporting" | "pushing";
  backoffMs?: number;
  retryAt?: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface RepoOperationScope {
  upstream: ResolvedWorkspaceGitUpstream;
  remote: WorkspaceGitRemoteConfig;
  fingerprint: string;
  stored: StoredRepoState;
  transportRemote: string;
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
    ExportResult & {
      pushed: boolean;
      status: GitUpstreamState;
      overwrites?: GitOverwritePreview;
    }
  > {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    return withRepoLock(repo, async () => {
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo);
        const result = await this.syncLocked(repo, scope, { push: true, force: opts.force });
        return {
          ...result.exported,
          pushed: result.pushed,
          status: "in-sync",
          ...(result.overwrites ? { overwrites: result.overwrites } : {}),
        };
      } catch (err) {
        if (scope) {
          await this.handlePushFailure(repo, scope.fingerprint, err, opts.force === true);
        }
        throw err;
      } finally {
        await this.reportHealth();
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
    scope: RepoOperationScope,
    opts: { push: boolean; force?: boolean }
  ): Promise<{ exported: ExportResult; pushed: boolean; overwrites?: GitOverwritePreview }> {
    const { upstream, remote, fingerprint, stored, transportRemote } = scope;
    const git = this.gitClient(upstream.credentialId);
    const dir = await this.bridge.repoGitDir(repo);
    let exported: ExportResult;
    this.setRunning(repo, fingerprint, "exporting");
    try {
      exported = await this.bridge.exportLockedInner(repo, {
        authorEmail: upstream.authorEmail,
        authorName: upstream.authorName,
      });
    } finally {
      this.clearRunning(repo, fingerprint);
    }
    if (!opts.push || !exported.headCommit) {
      return { exported, pushed: false };
    }
    if (!opts.force && exported.headCommit === stored?.lastPushedSha) {
      await this.updateRepoState(repo, fingerprint, {
        status: "in-sync",
        lastError: undefined,
      });
      return { exported, pushed: false };
    }
    let overwrites: GitOverwritePreview | undefined;
    if (opts.force) {
      overwrites = await this.previewOverwrites(git, dir, scope, exported.headCommit);
    }
    const localRef = (await git.getCurrentBranch(dir)) ?? DEFAULT_BRANCH;
    this.setRunning(repo, fingerprint, "pushing");
    try {
      const pushGit = opts.force
        ? this.gitClient(upstream.credentialId, { force: true, overwrites })
        : git;
      await pushGit.push({
        dir,
        url: remote.url,
        remote: transportRemote,
        ref: localRef,
        remoteRef: `refs/heads/${upstream.branch}`,
        force: opts.force ?? false,
      });
    } finally {
      this.clearRunning(repo, fingerprint);
    }
    await this.updateRepoState(repo, fingerprint, {
      status: "in-sync",
      lastError: undefined,
      lastPushedSha: exported.headCommit,
      lastPushedAt: Date.now(),
    });
    this.clearBackoff(repo, fingerprint);
    return { exported, pushed: true, ...(overwrites ? { overwrites } : {}) };
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
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo);
        const { upstream, remote, fingerprint, transportRemote } = scope;
        const dir = await this.bridge.repoGitDir(repo);
        const git = this.gitClient(upstream.credentialId);
        await git.fetch({
          dir,
          url: remote.url,
          remote: transportRemote,
          ref: upstream.branch,
        });
        const remoteRef = `refs/remotes/${transportRemote}/${upstream.branch}`;
        const remoteHead = await git.resolveRef(dir, remoteRef);
        if (!remoteHead) {
          if (!opts.dryRun) {
            await this.updateRepoState(repo, fingerprint, {
              status: "ahead",
              lastError: undefined,
            });
            this.clearBackoff(repo, fingerprint);
          }
          return { behindBy: 0, aheadBy: 1, incoming: [] };
        }
        const tracking = (await git.compareRefs(dir, "HEAD", remoteRef)) ?? {
          ahead: 1,
          behind: 1,
          diverged: true,
        };
        const incoming = await this.commitSummaries(git, dir, remoteRef, tracking.behind);
        if (opts.dryRun) {
          return { behindBy: tracking.behind, aheadBy: tracking.ahead, incoming };
        }
        const localRef = (await git.getCurrentBranch(dir)) ?? DEFAULT_BRANCH;
        if (tracking.diverged) {
          await git.pull({
            dir,
            url: remote.url,
            remote: transportRemote,
            ref: localRef,
            remoteRef: upstream.branch,
            author: this.gitAuthor(upstream),
          });
        } else {
          await git.fastForward({
            dir,
            url: remote.url,
            remote: transportRemote,
            ref: localRef,
            remoteRef: upstream.branch,
          });
        }
        const head = await git.getCurrentCommit(dir);
        const imported = await this.bridge.importLockedInner(repo, {
          summary: `Pull ${upstream.remote}/${upstream.branch}${head ? ` @ ${head.slice(0, 7)}` : ""}`,
        });
        const postPull = await this.aheadBehind(repo, scope, { fetch: false }).catch(() => null);
        await this.updateRepoState(repo, fingerprint, {
          status: postPull
            ? statusFromCounts(postPull.aheadBy, postPull.behindBy, postPull.diverged)
            : "in-sync",
          lastError: undefined,
        });
        this.clearBackoff(repo, fingerprint);
        return { behindBy: tracking.behind, aheadBy: tracking.ahead, incoming, imported };
      } catch (err) {
        if (scope) await this.handlePullFailure(repo, scope.fingerprint, err);
        throw err;
      } finally {
        await this.reportHealth();
      }
    });
  }

  async upstreamStatus(
    repoPaths: string[],
    options: GitUpstreamStatusOptions = {}
  ): Promise<GitUpstreamStatusRow[]> {
    const listedConfig = await this.readConfig();
    const repos = repoPaths.length
      ? repoPaths.map((repo) => normalizeWorkspaceRepoPath(repo))
      : listDeclaredUpstreams(listedConfig).map((entry) => entry.repoPath);
    const rows = await Promise.all(
      repos.map((repo) =>
        withRepoLock(repo, async () => {
          const config = await this.readConfig();
          let resolved: ResolvedWorkspaceGitUpstream | null = null;
          let remote: WorkspaceGitRemoteConfig | null = null;
          try {
            resolved = getDeclaredUpstreamForRepo(config, repo);
            if (resolved) remote = this.requireRemote(config, repo, resolved.remote);
          } catch (err) {
            await this.clearRepoState(repo);
            return {
              repoPath: repo,
              autoPush: false,
              state: "error" as const,
              aheadBy: 0,
              behindBy: 0,
              lastError: errorMessage(err),
            };
          }
          if (!resolved) {
            await this.clearRepoState(repo);
            return {
              repoPath: repo,
              autoPush: false,
              state: "local-only" as const,
              aheadBy: 0,
              behindBy: 0,
            };
          }
          let stored = await this.reconcileRepoState(repo, resolved, remote!);
          const runtime = this.runtime.get(repo);
          // Status-only remote/branch/credential overrides are observational.
          // Persisted push/failure state remains scoped to the declared config.
          const observesDeclaredTarget =
            options.remote === undefined &&
            options.branch === undefined &&
            options.credentialId === undefined;
          resolved = this.applyStatusOptions(config, repo, resolved, options);
          const operationalRemote = this.requireRemote(config, repo, resolved.remote);
          const operationalFingerprint = upstreamConfigFingerprint(
            repo,
            resolved,
            operationalRemote
          );
          const transportRemote = transportRemoteForFingerprint(operationalFingerprint);
          let counts: { aheadBy: number; behindBy: number; diverged: boolean };
          let statusError: { state: "auth-failed" | "error"; message: string } | null = null;
          try {
            counts = await this.aheadBehind(
              repo,
              {
                upstream: resolved,
                remote: operationalRemote,
                fingerprint: operationalFingerprint,
                stored,
                transportRemote,
              },
              options
            );
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
          if (observesDeclaredTarget && options.fetch === true && !statusError) {
            const recoveredStatus = statusFromCounts(
              counts.aheadBy,
              counts.behindBy,
              counts.diverged
            );
            if (
              await this.updateRepoState(repo, stored.configFingerprint, {
                status: recoveredStatus,
                lastError: undefined,
              })
            ) {
              stored = { ...stored, status: recoveredStatus };
              delete stored.lastError;
              this.clearBackoff(repo, stored.configFingerprint);
            }
          }
          // A persisted failure (the thing pausing auto-push) outranks live
          // counts: showing "ahead" while pushes are paused would lie to the
          // user. It clears on the next successful push/pull.
          const storedFailure =
            observesDeclaredTarget &&
            (stored.status === "diverged" ||
              stored.status === "auth-failed" ||
              stored.status === "error")
              ? stored.status
              : undefined;
          const computed =
            (observesDeclaredTarget && runtime?.configFingerprint === stored.configFingerprint
              ? runtime.running
              : undefined) ??
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
            lastPushedSha: observesDeclaredTarget ? stored.lastPushedSha : undefined,
            lastPushedAt: observesDeclaredTarget ? stored.lastPushedAt : undefined,
            lastError:
              statusError?.message ?? (observesDeclaredTarget ? stored.lastError : undefined),
          };
        })
      )
    );
    await this.reportHealth();
    return rows;
  }

  async publishRepo(input: GitPublishRepoInput): Promise<GitPublishRepoResult> {
    const repo = normalizeWorkspaceRepoPath(input.repoPath);
    const providerId = input.provider ?? "github";
    const provider = getRemoteProvider(providerId);
    if (!provider) throw new Error(`Unknown remote provider: ${providerId}`);
    const repoName = (input.name ?? repo.split("/").at(-1) ?? repo).split("/").at(-1) ?? repo;
    const remoteName = input.remote ? validateWorkspaceGitRemoteName(input.remote) : "origin";
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

  private async setUpstream(
    repoPath: string,
    config: WorkspaceGitUpstreamConfig
  ): Promise<unknown> {
    const repo = normalizeWorkspaceRepoPath(repoPath);
    const result = await this.ctx.rpc.call("main", "gitInterop.setUpstream", repo, config);
    await this.clearRepoState(repo);
    await this.reportHealth();
    return result;
  }

  private async setRemote(repoPath: string, remote: WorkspaceGitRemoteConfig): Promise<unknown> {
    return this.ctx.rpc.call(
      "main",
      "gitInterop.setSharedRemote",
      normalizeWorkspaceRepoPath(repoPath),
      remote
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
    if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    runtime.debounceTimer = setTimeout(() => {
      const current = this.runtime.get(repo);
      if (current) delete current.debounceTimer;
      void this.runAutoJob(repo).catch((err) => {
        this.ctx.log.warn?.("git upstream auto job failed", {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    this.runtime.set(repo, runtime);
  }

  private scheduleRetry(repo: string, fingerprint: string, delayMs: number): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => {
      const current = this.runtime.get(repo);
      if (current?.configFingerprint !== fingerprint) return;
      delete current.retryTimer;
      void this.runAutoJob(repo).catch((err) => {
        this.ctx.log.warn?.("git upstream retry failed", {
          repo,
          error: errorMessage(err),
        });
      });
    }, delayMs);
  }

  private async runAutoJob(repo: string): Promise<void> {
    await withRepoLock(repo, async () => {
      let scope: RepoOperationScope | null = null;
      try {
        scope = await this.resolveRepoScope(repo);
        const runtime = this.runtime.get(repo);
        if (
          runtime?.configFingerprint === scope.fingerprint &&
          runtime.retryAt &&
          Date.now() < runtime.retryAt
        ) {
          this.scheduleRetry(repo, scope.fingerprint, runtime.retryAt - Date.now());
          return;
        }
        // Tracking always exports (local-only, keeps the checkout current).
        // Divergence/auth failures pause only the wire push, never the export.
        const paused = scope.stored.status === "diverged" || scope.stored.status === "auth-failed";
        await this.syncLocked(repo, scope, {
          push: scope.upstream.autoPush && !paused,
        });
      } catch (err) {
        if (scope) {
          await this.handleAutoFailure(repo, scope.fingerprint, scope.upstream, err);
          return;
        }
        // A missing/broken declaration has no operational state. Clearing it
        // also detaches any timer/backoff from the previous configuration.
        await this.clearRepoState(repo);
      }
    });
    await this.reportHealth();
  }

  private async handlePushFailure(
    repo: string,
    fingerprint: string,
    err: unknown,
    force: boolean
  ): Promise<void> {
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(errorMessage(err))) {
      await this.updateRepoState(repo, fingerprint, {
        status: "auth-failed",
        lastError: errorMessage(err),
      });
      return;
    }
    if (
      !force &&
      /non-fast-forward|failed to push|not fast-forward|PushRejected|rejected/i.test(
        errorMessage(err)
      )
    ) {
      await this.updateRepoState(repo, fingerprint, {
        status: "diverged",
        lastError: errorMessage(err),
      });
      return;
    }
    await this.updateRepoState(repo, fingerprint, {
      status: "error",
      lastError: errorMessage(err),
    });
  }

  private async handlePullFailure(repo: string, fingerprint: string, err: unknown): Promise<void> {
    const message = errorMessage(err);
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(message)) {
      await this.updateRepoState(repo, fingerprint, {
        status: "auth-failed",
        lastError: message,
      });
      return;
    }
    if (/merge|conflict|non-fast-forward|not fast-forward|diverg/i.test(message)) {
      const guidance =
        `Pull could not merge upstream changes automatically: ${message}. ` +
        `Resolve the conflict in the workspace/<repo> checkout with git tooling and re-run pull, ` +
        `or push --force to overwrite upstream.`;
      await this.updateRepoState(repo, fingerprint, {
        status: "diverged",
        lastError: guidance,
      });
      return;
    }
    await this.updateRepoState(repo, fingerprint, { status: "error", lastError: message });
  }

  private async handleAutoFailure(
    repo: string,
    fingerprint: string,
    upstream: ResolvedWorkspaceGitUpstream,
    err: unknown
  ): Promise<void> {
    const message = errorMessage(err);
    if (err instanceof GitAuthError || /credential|auth|401|403/i.test(message)) {
      if (
        await this.updateRepoState(repo, fingerprint, {
          status: "auth-failed",
          lastError: message,
        })
      ) {
        await this.showFailureNotification(repo, upstream, message);
      }
      return;
    }
    if (/non-fast-forward|failed to push|not fast-forward|PushRejected|rejected/i.test(message)) {
      if (
        await this.updateRepoState(repo, fingerprint, {
          status: "diverged",
          lastError: message,
        })
      ) {
        await this.showFailureNotification(repo, upstream, message);
      }
      return;
    }
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    const nextBackoff = Math.min(
      runtime.backoffMs ? runtime.backoffMs * 2 : TRANSIENT_BACKOFF_MIN_MS,
      TRANSIENT_BACKOFF_MAX_MS
    );
    if (await this.updateRepoState(repo, fingerprint, { status: "error", lastError: message })) {
      runtime.backoffMs = nextBackoff;
      runtime.retryAt = Date.now() + nextBackoff;
      this.scheduleRetry(repo, fingerprint, nextBackoff);
    }
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
            extension: this.ctx.name,
            method: "retryUpstreamPush",
            args: [repo],
          },
        },
        {
          id: "open-git-tab",
          label: "Open Git tab",
          invoke: {
            kind: "extension",
            extension: this.ctx.name,
            method: "openGitTab",
            args: [repo],
          },
        },
        {
          id: "pause-auto-push",
          label: "Pause auto-push",
          invoke: {
            kind: "extension",
            extension: this.ctx.name,
            method: "pauseAutoPush",
            args: [repo],
          },
        },
      ],
    });
  }

  private async previewOverwrites(
    git: GitClient,
    dir: string,
    scope: RepoOperationScope,
    localHead: string
  ): Promise<GitOverwritePreview> {
    await git.fetch({
      dir,
      url: scope.remote.url,
      remote: scope.transportRemote,
      ref: scope.upstream.branch,
    });
    const remoteRef = `refs/remotes/${scope.transportRemote}/${scope.upstream.branch}`;
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
    repo: string,
    scope: RepoOperationScope,
    options: { fetch?: boolean } = {}
  ): Promise<{ aheadBy: number; behindBy: number; diverged: boolean }> {
    const dir = await this.bridge.repoGitDir(repo);
    const git = this.gitClient(scope.upstream.credentialId);
    if (options.fetch === true) {
      await git.fetch({
        dir,
        url: scope.remote.url,
        remote: scope.transportRemote,
        ref: scope.upstream.branch,
      });
    }
    const remoteRef = `refs/remotes/${scope.transportRemote}/${scope.upstream.branch}`;
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

  private setRunning(repo: string, fingerprint: string, state: "exporting" | "pushing"): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    runtime.running = state;
  }

  private clearRunning(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime?.configFingerprint === fingerprint) delete runtime.running;
  }

  private clearBackoff(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (!runtime || runtime.configFingerprint !== fingerprint) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    delete runtime.retryTimer;
    delete runtime.backoffMs;
    delete runtime.retryAt;
  }

  private resetRuntimeScope(repo: string, fingerprint: string): void {
    const runtime = this.runtime.get(repo);
    if (runtime?.configFingerprint === fingerprint) return;
    if (runtime?.retryTimer) clearTimeout(runtime.retryTimer);
    this.runtime.set(repo, {
      configFingerprint: fingerprint,
      ...(runtime?.debounceTimer ? { debounceTimer: runtime.debounceTimer } : {}),
    });
  }

  private async resolveRepoScope(repo: string): Promise<RepoOperationScope> {
    const config = await this.readConfig();
    const upstream = this.requireUpstream(config, repo);
    const remote = this.requireRemote(config, repo, upstream.remote);
    const stored = await this.reconcileRepoState(repo, upstream, remote);
    return {
      upstream,
      remote,
      fingerprint: stored.configFingerprint,
      stored,
      transportRemote: transportRemoteForFingerprint(stored.configFingerprint),
    };
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
    options: GitUpstreamStatusOptions
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
    gitIntent?: { force: boolean; overwrites?: GitOverwritePreview }
  ): GitClient {
    return new GitClient(fsp, {
      http: this.gitHttp(credentialId, gitIntent),
    });
  }

  private gitHttp(
    credentialId?: string,
    gitIntent?: { force: boolean; overwrites?: GitOverwritePreview }
  ) {
    return this.ctx.credentials.gitHttp({
      ...(credentialId ? { credentialId } : {}),
      ...(gitIntent ? { gitIntent } : {}),
    });
  }

  private gitAuthor(upstream: ResolvedWorkspaceGitUpstream): { name: string; email: string } {
    if (!upstream.authorName && !upstream.authorEmail) return SYSTEM_GIT_AUTHOR;
    return {
      name: upstream.authorName ?? "Vibestudio Git Bridge",
      email: upstream.authorEmail ?? "git-bridge@vibestudio.local",
    };
  }

  private async readState(): Promise<StoredState> {
    try {
      const raw = await this.ctx.storage.readFile(STATE_FILE, "utf8");
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      return parseStoredState(parsed) ?? emptyStoredState();
    } catch {
      return emptyStoredState();
    }
  }

  /** Serializes the WHOLE state transaction: concurrent per-repo jobs share
   *  one state file, so an unserialized read would clobber sibling repos. */
  private stateTransaction<T>(
    transact: (state: StoredState) => { result: T; changed: boolean }
  ): Promise<T> {
    const run = this.stateWrite.then(async () => {
      const state = await this.readState();
      const outcome = transact(state);
      if (outcome.changed) {
        await this.ctx.storage.mkdir("state", { recursive: true });
        await this.ctx.storage.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      }
      return outcome.result;
    });
    this.stateWrite = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async reconcileRepoState(
    repo: string,
    upstream: ResolvedWorkspaceGitUpstream,
    remote: WorkspaceGitRemoteConfig
  ): Promise<StoredRepoState> {
    const configFingerprint = upstreamConfigFingerprint(repo, upstream, remote);
    const stored = await this.stateTransaction((state) => {
      const current = state.repos[repo];
      if (current?.configFingerprint === configFingerprint) {
        return { result: { ...current }, changed: false };
      }
      const next: StoredRepoState = { configFingerprint };
      state.repos[repo] = next;
      return { result: { ...next }, changed: true };
    });
    this.resetRuntimeScope(repo, configFingerprint);
    return stored;
  }

  private async clearRepoState(repo: string): Promise<void> {
    await this.stateTransaction((state) => {
      if (!(repo in state.repos)) return { result: undefined, changed: false };
      delete state.repos[repo];
      return { result: undefined, changed: true };
    });
    const runtime = this.runtime.get(repo);
    if (runtime?.debounceTimer) clearTimeout(runtime.debounceTimer);
    if (runtime?.retryTimer) clearTimeout(runtime.retryTimer);
    this.runtime.delete(repo);
  }

  private updateRepoState(
    repo: string,
    fingerprint: string,
    patch: StoredRepoStatePatch
  ): Promise<boolean> {
    return this.stateTransaction((state) => {
      const current = state.repos[repo];
      // This is a configuration-token compare-and-set. A completion from an
      // operation started under config A can never mutate config B's state.
      if (current?.configFingerprint !== fingerprint) {
        return { result: false, changed: false };
      }
      const next = { ...current, ...patch };
      if (patch.status === undefined) delete next.status;
      if (patch.lastError === undefined) delete next.lastError;
      state.repos[repo] = next;
      return { result: true, changed: true };
    });
  }

  private async reportHealth(): Promise<void> {
    if (!this.ctx.health) return;
    await this.stateWrite;
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

function statusFromCounts(
  aheadBy: number,
  behindBy: number,
  diverged = aheadBy > 0 && behindBy > 0
): StoredUpstreamState {
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

function upstreamConfigFingerprint(
  repo: string,
  upstream: ResolvedWorkspaceGitUpstream,
  remote: WorkspaceGitRemoteConfig
): string {
  const identity = {
    repoPath: repo,
    upstream: {
      remote: upstream.remote,
      branch: upstream.branch,
      autoPush: upstream.autoPush,
      credentialId: upstream.credentialId ?? null,
      authorEmail: upstream.authorEmail ?? null,
      authorName: upstream.authorName ?? null,
    },
    remote: {
      name: remote.name,
      url: remote.url,
      branch: remote.branch ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function transportRemoteForFingerprint(fingerprint: string): string {
  return `vibestudio-${fingerprint.slice(0, 24)}`;
}

function emptyStoredState(): StoredState {
  return { version: 2, repos: {} };
}

const STORED_UPSTREAM_STATES = new Set<StoredUpstreamState>([
  "in-sync",
  "ahead",
  "behind",
  "diverged",
  "auth-failed",
  "error",
]);

function parseStoredState(value: unknown): StoredState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "repos"])) return null;
  const version = value["version"];
  const repoValues = value["repos"];
  if (version !== 2 || !isRecord(repoValues)) return null;
  const repos: Record<string, StoredRepoState> = {};
  for (const [repo, candidate] of Object.entries(repoValues)) {
    try {
      if (normalizeWorkspaceRepoPath(repo) !== repo) return null;
    } catch {
      return null;
    }
    if (!isRecord(candidate)) return null;
    const configFingerprint = candidate["configFingerprint"];
    const lastPushedSha = candidate["lastPushedSha"];
    const lastPushedAt = candidate["lastPushedAt"];
    const status = candidate["status"];
    const lastError = candidate["lastError"];
    if (
      !hasOnlyKeys(candidate, [
        "configFingerprint",
        "lastPushedSha",
        "lastPushedAt",
        "status",
        "lastError",
      ]) ||
      typeof configFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(configFingerprint) ||
      (lastPushedSha !== undefined &&
        (typeof lastPushedSha !== "string" || lastPushedSha.length === 0)) ||
      (lastPushedAt !== undefined &&
        (typeof lastPushedAt !== "number" ||
          !Number.isInteger(lastPushedAt) ||
          lastPushedAt < 0)) ||
      (status !== undefined &&
        (typeof status !== "string" ||
          !STORED_UPSTREAM_STATES.has(status as StoredUpstreamState))) ||
      (lastError !== undefined && typeof lastError !== "string")
    ) {
      return null;
    }
    repos[repo] = {
      configFingerprint,
      ...(lastPushedSha !== undefined ? { lastPushedSha } : {}),
      ...(lastPushedAt !== undefined ? { lastPushedAt } : {}),
      ...(status !== undefined ? { status: status as StoredUpstreamState } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
    };
  }
  return { version: 2, repos };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
