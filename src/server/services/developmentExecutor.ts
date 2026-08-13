import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type DevelopmentExecutionSnapshot,
  type DevelopmentRecipe,
  type DevelopmentRun,
  type DevelopmentSession,
  type DevelopmentPairSelection,
} from "@vibestudio/service-schemas/development";
import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash } from "@vibestudio/shared/execution/identity";
import type { ExecutionArtifactRefV1 } from "@vibestudio/shared/execution/retention";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";
import {
  artifactFilePath,
  contentTypeForPath,
  get as getBuild,
  put as putBuild,
  type BuildArtifactInput,
} from "../buildV2/buildStore.js";
import { executionArtifactRefFromBuild } from "../executionRootProviders.js";

const execFileAsync = promisify(execFile);
const REDACT = /(?:token|password|secret|authorization|cookie|private[_-]?key)\s*[=:]\s*[^\s]+/giu;
const RUN_ID = /^[A-Za-z0-9._-]{1,160}$/u;
const MARKER = ".vibestudio-development-run.json";
const REGULAR_MODE = 0o100644;
const EXECUTABLE_MODE = 0o100755;

interface ExactToolchain {
  executorId: string;
  nodePath: string;
  pnpmCliPath: string;
  pnpmRootPath: string;
  pnpmCliRelativePath: string;
  node: DevelopmentExecutionSnapshot["toolchain"]["node"];
  pnpm: DevelopmentExecutionSnapshot["toolchain"]["pnpm"];
  hostSourceBuild: DevelopmentExecutionSnapshot["toolchain"]["hostSourceBuild"];
}

export interface PreparedDevelopmentBuild {
  version: 1;
  runId: string;
  sourcePlans: {
    host: ExactRepositorySnapshotPlan;
    base: ExactRepositorySnapshotPlan;
  };
  snapshot: DevelopmentExecutionSnapshot;
  recipe: DevelopmentRecipe;
  executables: {
    nodePath: string;
    pnpmCliPath: string;
    pnpmRootPath: string;
    pnpmCliRelativePath: string;
  };
  clientExecutor?: {
    providerId: string;
    ownerRuntimeId: string;
    ownerUserId: string;
    platform: string;
    arch: string;
    executorDigest: string;
  };
}

export interface OwnedDevelopmentLaunch {
  runRoot: string;
  sourceRoot: string;
  nodePath: string;
  serverEntryPath: string;
  serverBuildId: string;
}

export interface DevelopmentClientArtifactSource {
  mainEntryBuildId: string;
  manifest: readonly { path: string; integrity: string; byteLength: number }[];
  read(path: string, offset: number, length: number): Buffer;
}

interface OwnedChild {
  child: ChildProcess;
  exit: Promise<void>;
  attempt: number;
  runRoot: string;
  snapshotDigest: string;
}

/**
 * Narrow host-native executor for the reviewed Vibestudio recipe.
 *
 * Preparation is read-only. All writes begin only after dispatcher authority
 * and remain below a marker-proven, run-owned root.
 */
export class DevelopmentExecutor {
  private readonly children = new Map<string, OwnedChild>();
  private readonly attempts = new Map<string, number>();
  private readonly stopping = new Map<string, number>();
  private toolchainPromise: Promise<ExactToolchain> | null = null;

  constructor(
    private readonly deps: {
      workspaceId: string;
      hostExecutionDigest: string;
      root: string;
      planSource(input: {
        contextId: string;
        repositoryId: string;
        requiredFiles: readonly string[];
      }): Promise<ExactRepositorySnapshotPlan>;
      materializeSource(plan: ExactRepositorySnapshotPlan, destination: string): Promise<void>;
      onLog?: (runId: string, stream: "stdout" | "stderr", line: string) => void;
    }
  ) {}

  async prepareExact(input: {
    session: DevelopmentSession;
    runId: string;
    recipe: DevelopmentRecipe;
    pair: DevelopmentPairSelection;
  }): Promise<PreparedDevelopmentBuild> {
    if (process.platform === "win32") {
      throw Object.assign(
        new Error(
          "Development builds require a Windows job-object executor, which is not installed"
        ),
        { code: "EEXECUTOR_UNAVAILABLE" }
      );
    }
    this.assertRunId(input.runId);
    const recipe = input.recipe;
    if (recipe.platform !== process.platform || recipe.arch !== process.arch) {
      throw Object.assign(
        new Error(
          `Recipe ${recipe.recipeId} targets ${recipe.platform}/${recipe.arch}, ` +
            `not ${process.platform}/${process.arch}`
        ),
        { code: "EEXECUTOR_UNAVAILABLE" }
      );
    }
    const [hostSourcePlan, baseSourcePlan, toolchain] = await Promise.all([
      this.deps.planSource({
        contextId: input.session.contextId,
        repositoryId: input.pair.hostRepositoryId,
        requiredFiles: recipe.install.lockfiles,
      }),
      this.deps.planSource({
        contextId: input.session.contextId,
        repositoryId: input.pair.baseRepositoryId,
        requiredFiles: ["meta/template.yml", "meta/vibestudio.yml", "pnpm-lock.yaml"],
      }),
      this.toolchain(),
    ]);
    if (
      hostSourcePlan.repositoryId !== input.pair.hostRepositoryId ||
      baseSourcePlan.repositoryId !== input.pair.baseRepositoryId
    ) {
      throw Object.assign(
        new Error("Development pair repository identity changed while preparing"),
        {
          code: "EIDENTITYDRIFT",
        }
      );
    }
    const selectedRepository = input.session.repository.repositoryId;
    const selectedSide =
      input.pair.kind === "host-only"
        ? input.pair.hostRepositoryId
        : input.pair.kind === "base-only"
          ? input.pair.baseRepositoryId
          : selectedRepository;
    if (
      selectedRepository !== selectedSide ||
      (input.pair.kind === "combined" &&
        selectedRepository !== input.pair.hostRepositoryId &&
        selectedRepository !== input.pair.baseRepositoryId)
    ) {
      throw Object.assign(
        new Error("Development session does not own the selected pair candidate"),
        {
          code: "EIDENTITYDRIFT",
        }
      );
    }
    const lockfileDigest = domainHash(
      "vibestudio/development-lockfiles/v1",
      canonicalJson({
        host: hostSourcePlan.requiredFiles,
        base: baseSourcePlan.requiredFiles,
      })
    );
    const { reviewDigest, ...reviewedRecipeBody } = recipe;
    if (
      domainHash("vibestudio/development-recipe-review/v1", canonicalJson(reviewedRecipeBody)) !==
      reviewDigest
    ) {
      throw Object.assign(new Error(`Recipe ${recipe.recipeId} has an invalid review digest`), {
        code: "EIDENTITYDRIFT",
      });
    }
    const recipeDigest = domainHash("vibestudio/development-recipe/v1", canonicalJson(recipe));
    const environmentDigest = domainHash(
      "vibestudio/development-environment/v1",
      canonicalJson(recipe.declaredEnvironment)
    );
    const component = (plan: ExactRepositorySnapshotPlan) => ({
      repositoryId: plan.repositoryId,
      repoPath: plan.repoPath,
      repositoryState: plan.sourceState,
      repositoryManifestDigest: plan.repositoryManifestDigest,
      materializedTreeDigest: plan.materializedTreeDigest,
      contentRoot: plan.contentRoot,
      sourcePlanDigest: plan.planDigest,
    });
    const host = component(hostSourcePlan);
    const base = component(baseSourcePlan);
    const pairBody = { kind: input.pair.kind, host, base };
    const pair = {
      ...pairBody,
      pairDigest: domainHash("vibestudio/development-pair/v1", canonicalJson(pairBody)),
    };
    const snapshotBase = {
      version: 1 as const,
      sessionId: input.session.sessionId,
      contextId: input.session.contextId,
      pair,
      recipeDigest,
      toolchain: {
        executorId: toolchain.executorId,
        node: toolchain.node,
        pnpm: toolchain.pnpm,
        hostSourceBuild: toolchain.hostSourceBuild,
      },
      declaredEnvironment: recipe.declaredEnvironment,
      environmentDigest,
      lockfileDigest,
    };
    const snapshot: DevelopmentExecutionSnapshot = {
      ...snapshotBase,
      snapshotDigest: domainHash("vibestudio/development-snapshot/v1", canonicalJson(snapshotBase)),
    };
    return {
      version: 1,
      runId: input.runId,
      sourcePlans: { host: hostSourcePlan, base: baseSourcePlan },
      snapshot,
      recipe,
      executables: {
        nodePath: toolchain.nodePath,
        pnpmCliPath: toolchain.pnpmCliPath,
        pnpmRootPath: toolchain.pnpmRootPath,
        pnpmCliRelativePath: toolchain.pnpmCliRelativePath,
      },
    };
  }

  async materialize(plan: PreparedDevelopmentBuild): Promise<void> {
    const runRoot = this.runRoot(plan.runId);
    await this.claimRunRoot(runRoot, plan.runId, plan.snapshot.snapshotDigest);
    const sourceRoot = path.join(runRoot, "source");
    const baseRoot = path.join(runRoot, "base");
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(baseRoot, { recursive: true, force: true });
    await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(baseRoot, { recursive: true, mode: 0o700 });
    await this.deps.materializeSource(plan.sourcePlans.host, sourceRoot);
    await this.deps.materializeSource(plan.sourcePlans.base, baseRoot);
    await this.projectExactToolchain(plan, runRoot);
    const attempt = (this.attempts.get(plan.runId) ?? 0) + 1;
    this.attempts.set(plan.runId, attempt);
    this.stopping.delete(plan.runId);
  }

  async execute(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild,
    onPhase: (phase: "installing" | "building") => void
  ): Promise<ExecutionArtifactRefV1> {
    this.verifyRunPlan(run, plan);
    const runRoot = this.runRoot(run.runId);
    await this.assertOwnedRoot(runRoot, run.runId, run.snapshot.snapshotDigest);
    const sourceRoot = path.join(runRoot, "source");
    const home = path.join(runRoot, "home");
    const store = path.join(runRoot, "pnpm-store");
    await Promise.all([
      fs.mkdir(home, { recursive: true, mode: 0o700 }),
      fs.mkdir(store, { recursive: true, mode: 0o700 }),
    ]);
    const environment = this.executionEnvironment(run.recipe, home, path.join(runRoot, "base"));

    for (const command of run.recipe.commands) {
      if (command.id === "build-host") {
        onPhase("building");
        const executable = await this.verifyExecutableIdentity(plan, false);
        await this.runCommand(
          run,
          plan,
          command.id,
          executable.nodePath,
          command.args,
          sourceRoot,
          environment
        );
        continue;
      }
      onPhase("installing");
      const executable = await this.verifyExecutableIdentity(plan, true);
      const args = [
        executable.pnpmCliPath,
        ...command.args,
        "--store-dir",
        store,
        "--registry",
        run.recipe.install.registry,
      ];
      await this.runCommand(
        run,
        plan,
        command.id,
        executable.nodePath,
        args,
        sourceRoot,
        environment
      );
    }
    return this.publishArtifacts(run, sourceRoot);
  }

  async stop(runId: string): Promise<void> {
    const attempt = this.attempts.get(runId);
    if (attempt !== undefined) this.stopping.set(runId, attempt);
    const owned = this.children.get(runId);
    if (!owned) return;
    this.signalOwned(owned.child, "SIGTERM");
    const graceful = await Promise.race([
      owned.exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!graceful) {
      this.signalOwned(owned.child, "SIGKILL");
      await owned.exit;
    }
  }

  async retire(run: DevelopmentRun): Promise<void> {
    await this.stop(run.runId);
    const runRoot = this.runRoot(run.runId);
    await this.assertOwnedRoot(runRoot, run.runId, run.snapshot.snapshotDigest);
    await fs.rm(runRoot, { recursive: true, force: true });
    this.attempts.delete(run.runId);
    this.stopping.delete(run.runId);
  }

  async resolveOwnedLaunch(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild
  ): Promise<OwnedDevelopmentLaunch> {
    this.verifyRunPlan(run, plan);
    const runRoot = this.runRoot(run.runId);
    await this.assertOwnedRoot(runRoot, run.runId, run.snapshot.snapshotDigest);
    if (!run.artifact) {
      throw Object.assign(new Error("Development launch has no verified artifact owner"), {
        code: "ESTATE",
      });
    }
    const build = getBuild(run.artifact.buildKey);
    if (
      !build?.metadata.execution ||
      canonicalJson(build.metadata.execution) !== canonicalJson(run.artifact)
    ) {
      throw Object.assign(new Error("Retained development artifacts no longer match the run"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    const serverArtifact = build.artifacts.find((artifact) => artifact.path === "dist/server.mjs");
    const expectedDigest = serverArtifact?.integrity?.match(/^sha256-([a-f0-9]{64})$/u)?.[1];
    if (!serverArtifact || !expectedDigest) {
      throw Object.assign(new Error("Reviewed build has no exact dist/server.mjs artifact"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    // Force the immutable store's lazy payload-integrity verification before
    // trusting its manifest as the launch identity.
    void serverArtifact.content;
    const sourceRoot = await fs.realpath(path.join(runRoot, "source"));
    const serverEntryPath = path.join(sourceRoot, "dist", "server.mjs");
    const entryStat = await fs.lstat(serverEntryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw Object.assign(new Error("Development server entry is not a regular owned file"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    const serverBuildId = sha256(await fs.readFile(serverEntryPath));
    if (serverBuildId !== expectedDigest) {
      throw Object.assign(new Error("Development server entry changed after artifact retention"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    await fs.chmod(serverEntryPath, 0o500);
    const { nodePath } = await this.verifyExecutableIdentity(plan, false);
    return { runRoot, sourceRoot, nodePath, serverEntryPath, serverBuildId };
  }

  async resolveClientArtifactSource(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild
  ): Promise<DevelopmentClientArtifactSource> {
    this.verifyRunPlan(run, plan);
    const runRoot = this.runRoot(run.runId);
    await this.assertOwnedRoot(runRoot, run.runId, run.snapshot.snapshotDigest);
    if (!run.artifact) {
      throw Object.assign(new Error("Development client has no verified artifact owner"), {
        code: "ESTATE",
      });
    }
    const build = getBuild(run.artifact.buildKey);
    if (
      !build?.metadata.execution ||
      canonicalJson(build.metadata.execution) !== canonicalJson(run.artifact)
    ) {
      throw Object.assign(new Error("Retained client artifacts no longer match the run"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    const entries = new Map<string, { filePath: string; integrity: string; byteLength: number }>();
    for (const artifact of build.artifacts) {
      if (
        !artifact.path.startsWith("dist/") ||
        !artifact.integrity ||
        artifact.byteLength === undefined
      ) {
        continue;
      }
      // Force BuildStore's lazy content hash before exposing a transport
      // coordinate. The selected device receives chunks, never this path.
      void artifact.content;
      entries.set(artifact.path, {
        filePath: artifactFilePath(build, artifact),
        integrity: artifact.integrity,
        byteLength: artifact.byteLength,
      });
    }
    const main = entries.get("dist/main.cjs");
    const mainEntryBuildId = main?.integrity.match(/^sha256-([a-f0-9]{64})$/u)?.[1];
    if (!main || !mainEntryBuildId) {
      throw Object.assign(new Error("Reviewed build has no exact dist/main.cjs artifact"), {
        code: "EARTIFACT_DRIFT",
      });
    }
    const manifest = [...entries.entries()]
      .map(([artifactPath, entry]) => ({
        path: artifactPath,
        integrity: entry.integrity,
        byteLength: entry.byteLength,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      mainEntryBuildId,
      manifest,
      read(artifactPath, offset, length) {
        const entry = entries.get(artifactPath);
        if (
          !entry ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          offset + length > entry.byteLength
        ) {
          throw Object.assign(new Error("Invalid development artifact range"), {
            code: "ERANGE",
          });
        }
        const fd = fsSync.openSync(entry.filePath, "r");
        try {
          const bytes = Buffer.alloc(length);
          const count = fsSync.readSync(fd, bytes, 0, length, offset);
          if (count !== length) {
            throw Object.assign(new Error("Retained development artifact was truncated"), {
              code: "EARTIFACT_DRIFT",
            });
          }
          return bytes;
        } finally {
          fsSync.closeSync(fd);
        }
      },
    };
  }

  private async publishArtifacts(
    run: DevelopmentRun,
    sourceRoot: string
  ): Promise<ExecutionArtifactRefV1> {
    const outputRoot = path.join(sourceRoot, "dist");
    const artifacts = await collectArtifacts(outputRoot);
    if (artifacts.length === 0) {
      throw Object.assign(new Error("Reviewed build produced no dist artifacts"), {
        code: "EEMPTY_BUILD",
      });
    }
    const effectiveVersion = domainHash(
      "vibestudio/development-source-effective-version/v1",
      canonicalJson({
        pairDigest: run.snapshot.pair.pairDigest,
        host: run.snapshot.pair.host,
        base: run.snapshot.pair.base,
      })
    );
    const build = await putBuild(
      run.snapshot.snapshotDigest,
      { entries: artifacts },
      {
        kind: "template",
        name: `development:${run.runId}`,
        buildKey: run.snapshot.snapshotDigest,
        sourcePath: run.snapshot.pair.host.repoPath,
        ev: effectiveVersion,
        sourceStateHash: run.snapshot.pair.host.contentRoot,
        sourceState: run.snapshot.pair.host.repositoryState,
        sourcemap: false,
        authority: { requests: [], provides: [] },
        details: { kind: "generic" },
        builtAt: new Date().toISOString(),
      }
    );
    return executionArtifactRefFromBuild(this.deps.workspaceId, build);
  }

  private runCommand(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild,
    commandId: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    if (this.children.has(run.runId)) {
      throw Object.assign(new Error(`Development run ${run.runId} already owns a process`), {
        code: "EALREADY",
      });
    }
    const attempt = this.attempts.get(run.runId);
    if (attempt === undefined) {
      throw Object.assign(new Error(`Development run ${run.runId} has no materialized attempt`), {
        code: "ESTATE",
      });
    }
    if (this.stopping.get(run.runId) === attempt) {
      throw Object.assign(new Error(`Development run ${run.runId} was cancelled`), {
        code: "ECANCELLED",
      });
    }
    const child = spawn(executable, [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const emit = (stream: "stdout" | "stderr", chunk: Buffer) => {
      for (const rawLine of chunk.toString("utf8").split(/\r?\n/u)) {
        if (!rawLine) continue;
        this.deps.onLog?.(
          run.runId,
          stream,
          rawLine.slice(0, 16_384).replace(REDACT, "[REDACTED]")
        );
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => emit("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => emit("stderr", chunk));
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          Object.assign(
            new Error(
              this.stopping.get(run.runId) === attempt
                ? `Development command ${commandId} was cancelled`
                : `Development command ${commandId} exited ${code ?? signal ?? "unknown"}`
            ),
            {
              code: this.stopping.get(run.runId) === attempt ? "ECANCELLED" : "EEXEC",
            }
          )
        );
      });
    }).finally(() => {
      if (this.children.get(run.runId)?.child === child) this.children.delete(run.runId);
    });
    this.children.set(run.runId, {
      child,
      exit,
      attempt,
      runRoot: this.runRoot(run.runId),
      snapshotDigest: plan.snapshot.snapshotDigest,
    });
    return exit;
  }

  private signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall through to the exact ChildProcess handle.
      }
    }
    child.kill(signal);
  }

  private executionEnvironment(
    recipe: DevelopmentRecipe,
    home: string,
    baseRoot: string
  ): NodeJS.ProcessEnv {
    const nodeDir = path.dirname(process.execPath);
    return {
      ...recipe.declaredEnvironment,
      HOME: home,
      USERPROFILE: home,
      VIBESTUDIO_USERLAND_ROOT: baseRoot,
      PATH:
        process.platform === "win32"
          ? `${nodeDir};${path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32")}`
          : `${nodeDir}:/usr/local/bin:/usr/bin:/bin`,
    };
  }

  private async toolchain(): Promise<ExactToolchain> {
    this.toolchainPromise ??= resolveExactToolchain(this.deps.hostExecutionDigest);
    return this.toolchainPromise;
  }

  private runRoot(runId: string): string {
    this.assertRunId(runId);
    return path.join(this.deps.root, runId);
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID.test(runId))
      throw Object.assign(new Error("Invalid development run id"), { code: "EINVAL" });
  }

  private async claimRunRoot(
    runRoot: string,
    runId: string,
    snapshotDigest: string
  ): Promise<void> {
    await fs.mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const base = await fs.realpath(this.deps.root);
    const relative = path.relative(base, path.resolve(runRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw Object.assign(new Error("Development run root escaped its owner"), {
        code: "EACCES",
      });
    }
    try {
      await this.assertOwnedRoot(runRoot, runId, snapshotDigest);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(runRoot, { recursive: false, mode: 0o700 });
    await fs.writeFile(
      path.join(runRoot, MARKER),
      `${JSON.stringify({ version: 1, runId, snapshotDigest })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
  }

  private async assertOwnedRoot(
    runRoot: string,
    runId: string,
    snapshotDigest: string
  ): Promise<void> {
    const marker = JSON.parse(await fs.readFile(path.join(runRoot, MARKER), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      marker["version"] !== 1 ||
      marker["runId"] !== runId ||
      marker["snapshotDigest"] !== snapshotDigest
    ) {
      throw Object.assign(new Error(`Development root ${runRoot} has a foreign owner marker`), {
        code: "EOWNERSHIP",
      });
    }
  }

  private verifyRunPlan(run: DevelopmentRun, plan: PreparedDevelopmentBuild): void {
    if (
      plan.runId !== run.runId ||
      plan.snapshot.snapshotDigest !== run.snapshot.snapshotDigest ||
      canonicalJson(plan.recipe) !== canonicalJson(run.recipe) ||
      plan.snapshot.toolchain.hostSourceBuild.digest !== this.deps.hostExecutionDigest
    ) {
      throw Object.assign(new Error("Stored development run does not match its execution plan"), {
        code: "EIDEMPOTENCYDRIFT",
      });
    }
  }

  private async verifyExecutableIdentity(
    plan: PreparedDevelopmentBuild,
    includePnpm: boolean
  ): Promise<{ nodePath: string; pnpmCliPath: string }> {
    const projectionRoot = path.join(this.runRoot(plan.runId), "toolchain");
    const nodePath = await fs.realpath(path.join(projectionRoot, "node"));
    const nodeDigest = sha256(await fs.readFile(nodePath));
    if (nodeDigest !== plan.snapshot.toolchain.node.digest) {
      throw Object.assign(new Error("Exact Node executable changed after preparation"), {
        code: "ETOOLCHAIN_DRIFT",
      });
    }
    const pnpmRootPath = await fs.realpath(path.join(projectionRoot, "pnpm"));
    const pnpmCliPath = await fs.realpath(
      path.join(pnpmRootPath, plan.executables.pnpmCliRelativePath)
    );
    if (!isWithin(pnpmRootPath, pnpmCliPath)) {
      throw Object.assign(new Error("Projected pnpm entry point escaped its package closure"), {
        code: "ETOOLCHAIN_DRIFT",
      });
    }
    if (!includePnpm) return { nodePath, pnpmCliPath };
    const pnpmDigest = await hashDevelopmentPackageClosure(pnpmRootPath);
    if (pnpmDigest !== plan.snapshot.toolchain.pnpm.digest) {
      throw Object.assign(new Error("Exact pnpm package changed after preparation"), {
        code: "ETOOLCHAIN_DRIFT",
      });
    }
    return { nodePath, pnpmCliPath };
  }

  private async projectExactToolchain(
    plan: PreparedDevelopmentBuild,
    runRoot: string
  ): Promise<void> {
    const projectionRoot = path.join(runRoot, "toolchain");
    await fs.rm(projectionRoot, { recursive: true, force: true });
    await fs.mkdir(projectionRoot, { recursive: true, mode: 0o700 });
    const nodeSource = await fs.realpath(plan.executables.nodePath);
    const nodeTarget = path.join(projectionRoot, "node");
    await fs.copyFile(nodeSource, nodeTarget, fsConstants.COPYFILE_FICLONE);
    await fs.chmod(nodeTarget, 0o500);
    if (sha256(await fs.readFile(nodeTarget)) !== plan.snapshot.toolchain.node.digest) {
      throw Object.assign(new Error("Exact Node executable changed before materialization"), {
        code: "ETOOLCHAIN_DRIFT",
      });
    }
    const pnpmSource = await fs.realpath(plan.executables.pnpmRootPath);
    const pnpmTarget = path.join(projectionRoot, "pnpm");
    await copyPackageClosure(pnpmSource, pnpmTarget);
    if ((await hashDevelopmentPackageClosure(pnpmTarget)) !== plan.snapshot.toolchain.pnpm.digest) {
      throw Object.assign(new Error("Exact pnpm package changed before materialization"), {
        code: "ETOOLCHAIN_DRIFT",
      });
    }
  }
}

async function resolveExactToolchain(hostExecutionDigest: string): Promise<ExactToolchain> {
  if (!/^[0-9a-f]{64}$/u.test(hostExecutionDigest)) {
    throw Object.assign(new Error("Trusted host execution digest is unavailable"), {
      code: "EEXECUTOR_UNAVAILABLE",
    });
  }
  const nodePath = await fs.realpath(process.execPath);
  const pnpmCliPath = await resolvePnpmCli(nodePath);
  const pnpmRootPath = await resolvePnpmPackageRoot(pnpmCliPath);
  const pnpmCliRelativePath = path.relative(pnpmRootPath, pnpmCliPath);
  if (
    !pnpmCliRelativePath ||
    pnpmCliRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(pnpmCliRelativePath)
  ) {
    throw Object.assign(new Error("The pnpm entry point is outside its package closure"), {
      code: "EEXECUTOR_UNAVAILABLE",
    });
  }
  const [nodeBytes, pnpmDigest, pnpmVersionResult] = await Promise.all([
    fs.readFile(nodePath),
    hashDevelopmentPackageClosure(pnpmRootPath),
    execFileAsync(nodePath, [pnpmCliPath, "--version"], {
      env: { PATH: path.dirname(nodePath) },
      windowsHide: true,
    }),
  ]);
  const node = {
    digest: sha256(nodeBytes),
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const pnpm = { digest: pnpmDigest, version: pnpmVersionResult.stdout.trim() };
  const hostSourceBuild = { digest: hostExecutionDigest };
  return {
    executorId: domainHash(
      "vibestudio/development-executor/v1",
      canonicalJson({ node, pnpm, hostSourceBuild })
    ),
    nodePath,
    pnpmCliPath,
    pnpmRootPath,
    pnpmCliRelativePath,
    node,
    pnpm,
    hostSourceBuild,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolvePnpmPackageRoot(pnpmCliPath: string): Promise<string> {
  let current = path.dirname(pnpmCliPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === "pnpm") return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw Object.assign(new Error("The exact pnpm package closure could not be resolved"), {
    code: "EEXECUTOR_UNAVAILABLE",
  });
}

export async function hashDevelopmentPackageClosure(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw Object.assign(
          new Error(`Unsupported entry in pnpm package closure: ${relativePath}`),
          { code: "EEXECUTOR_UNAVAILABLE" }
        );
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      const bytes = await fs.readFile(absolutePath);
      hash.update(relativePath);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

async function copyPackageClosure(sourceRoot: string, targetRoot: string): Promise<void> {
  const copy = async (source: string, target: string): Promise<void> => {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw Object.assign(new Error(`Unsupported entry in pnpm package closure: ${sourcePath}`), {
          code: "ETOOLCHAIN_DRIFT",
        });
      }
      if (entry.isDirectory()) {
        await copy(sourcePath, targetPath);
      } else {
        await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
        await fs.chmod(targetPath, 0o400);
      }
    }
  };
  await copy(sourceRoot, targetRoot);
}

async function resolvePnpmCli(nodePath: string): Promise<string> {
  const executableName = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const pathCandidates = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, executableName));
  const candidates = [
    process.env["npm_execpath"],
    path.join(path.dirname(nodePath), executableName),
    path.join(
      path.dirname(path.dirname(nodePath)),
      "lib",
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs"
    ),
    ...pathCandidates,
  ].filter((candidate): candidate is string => Boolean(candidate && path.isAbsolute(candidate)));
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) continue;
      const prefix = await fs.readFile(resolved, { encoding: "utf8" });
      if (!prefix.includes("pnpm")) continue;
      return resolved;
    } catch {
      // Try the next exact installed candidate.
    }
  }
  throw Object.assign(
    new Error("The exact installed pnpm CLI could not be resolved for development builds"),
    { code: "EEXECUTOR_UNAVAILABLE" }
  );
}

async function collectArtifacts(outputRoot: string): Promise<BuildArtifactInput[]> {
  const files: Array<{ relativePath: string; absolutePath: string; mode: number }> = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw Object.assign(new Error(`Unsupported build output entry ${relativePath}`), {
          code: "EUNSUPPORTED_OUTPUT",
        });
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else {
        const stat = await fs.stat(absolutePath);
        files.push({
          relativePath,
          absolutePath,
          mode: stat.mode & 0o111 ? EXECUTABLE_MODE : REGULAR_MODE,
        });
      }
    }
  };
  try {
    await walk(outputRoot, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const primary =
    files.find((file) => file.relativePath === "server.mjs")?.relativePath ??
    files[0]?.relativePath;
  const artifacts: BuildArtifactInput[] = [];
  for (const file of files) {
    const bytes = await fs.readFile(file.absolutePath);
    const contentType = contentTypeForPath(file.relativePath);
    const text =
      contentType.startsWith("text/") ||
      contentType.startsWith("application/json") ||
      contentType.startsWith("application/javascript");
    artifacts.push({
      path: `dist/${file.relativePath}`,
      role: file.relativePath === primary ? "primary" : "asset",
      contentType,
      encoding: text ? "utf8" : "base64",
      content: text ? bytes.toString("utf8") : bytes.toString("base64"),
      ...(file.mode === EXECUTABLE_MODE ? { platform: process.platform } : {}),
    });
  }
  return artifacts;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
