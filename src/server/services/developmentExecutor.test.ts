import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";
import type {
  DevelopmentExecutionSnapshot,
  DevelopmentRun,
  DevelopmentSession,
} from "@vibestudio/service-schemas/development";
import { setBuildExecutionIdentityContext, get as getBuild } from "../buildV2/buildStore.js";
import {
  DevelopmentExecutor,
  hashDevelopmentPackageClosure,
  type PreparedDevelopmentBuild,
} from "./developmentExecutor.js";
import { developmentRecipes } from "@panticonic/builtin/development/recipes";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

function session(): DevelopmentSession {
  return {
    sessionId: "development-session",
    idempotencyKey: "open",
    state: "ready",
    mode: "semantic",
    nativeTool: null,
    native: null,
    repository: { repositoryId: "repository:vibestudio", repoPath: "projects/vibestudio" },
    contextId: "context:development",
    parentContextId: "context:parent",
    basis: {
      parentWorkingHead: { kind: "event", eventId: "event:parent" },
      childBaseState: { kind: "event", eventId: "event:base" },
    },
    owner: { runtimeId: "worker:one", runtimeKind: "worker", userId: "user:one" },
    contextEffect: "owned",
    repairAttention: null,
    createdAt: 1,
    updatedAt: 1,
    primaryDiagnostic: null,
    cleanupDiagnostics: [],
  };
}

function sourcePlan(): ExactRepositorySnapshotPlan {
  const base = {
    version: 1 as const,
    contextId: "context:development",
    repositoryId: "repository:vibestudio",
    repoPath: "projects/vibestudio",
    sourceState: { kind: "application" as const, applicationId: "application:dirty" },
    contentRoot: `state:${digest("a")}`,
    repositoryManifestDigest: digest("b"),
    materializedTreeDigest: digest("c"),
    requiredFiles: [{ path: "pnpm-lock.yaml", contentHash: digest("d"), byteLength: 4 }],
    realization: {
      repository: {
        repositoryId: "repository:vibestudio",
        repoPath: "projects/vibestudio",
        presence: "present" as const,
        fileManifestId: "manifest:dirty",
        source: { kind: "content-root" as const, contentRoot: `state:${digest("a")}` },
      },
      blobs: [],
    },
  };
  return { ...base, planDigest: digest("f") };
}

function runFor(plan: PreparedDevelopmentBuild): DevelopmentRun {
  return {
    version: 1,
    runId: plan.runId,
    sessionId: plan.snapshot.sessionId,
    ownerRuntimeId: "worker:one",
    ownerRuntimeKind: "worker",
    ownerUserId: "user:one",
    attachedHostAuthorityCeiling: null,
    target: { kind: "build-only" },
    recipe: plan.recipe,
    snapshot: plan.snapshot,
    state: "installing",
    commitPoint: "snapshot-retained",
    artifact: null,
    instance: null,
    hostReadiness: null,
    client: null,
    attachedHost: null,
    repair: null,
    createdAt: 1,
    updatedAt: 1,
    terminalAt: null,
  };
}

async function manualPlan(runId: string, pnpmCliPath: string): Promise<PreparedDevelopmentBuild> {
  const recipe = developmentRecipes(process.platform, process.arch)[0]!;
  const pnpmRootPath = path.dirname(pnpmCliPath);
  const nodeDigest = createHash("sha256")
    .update(await fsp.readFile(process.execPath))
    .digest("hex");
  const snapshot: DevelopmentExecutionSnapshot = {
    version: 1,
    sessionId: "development-session",
    contextId: "context:development",
    repositoryId: "repository:vibestudio",
    repoPath: "projects/vibestudio",
    repositoryState: { kind: "application", applicationId: "application:dirty" },
    repositoryManifestDigest: digest("b"),
    materializedTreeDigest: digest("c"),
    contentRoot: `state:${digest("a")}`,
    sourcePlanDigest: digest("f"),
    recipeDigest: digest("1"),
    toolchain: {
      executorId: digest("2"),
      node: {
        digest: nodeDigest,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      pnpm: {
        digest: await hashDevelopmentPackageClosure(pnpmRootPath),
        version: "test",
      },
      hostSourceBuild: { digest: digest("9") },
    },
    declaredEnvironment: recipe.declaredEnvironment,
    environmentDigest: digest("6"),
    lockfileDigest: digest("7"),
    snapshotDigest: digest("8"),
  };
  return {
    version: 1,
    runId,
    sourcePlan: sourcePlan(),
    snapshot,
    recipe,
    executables: {
      nodePath: process.execPath,
      pnpmCliPath,
      pnpmRootPath,
      pnpmCliRelativePath: path.relative(pnpmRootPath, pnpmCliPath),
    },
  };
}

async function pnpmFixture(root: string, name: string, source: string): Promise<string> {
  const packageRoot = path.join(root, name);
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "pnpm" }));
  const cli = path.join(packageRoot, "pnpm.cjs");
  await fsp.writeFile(cli, source);
  return cli;
}

describe("DevelopmentExecutor exact private execution", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-development-executor-"));
    roots.push(root);
    setUserDataPath(path.join(root, "state"));
    setBuildExecutionIdentityContext({
      workspaceId: "workspace:test",
      executionStateForContent: () => ({
        kind: "application",
        applicationId: "application:dirty",
      }),
    });
  });

  afterEach(() => {
    delete process.env["DEVELOPMENT_EXECUTOR_SECRET"];
    for (const target of roots.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("prepares stable exact identities without creating a run root or process", async () => {
    const planSource = vi.fn(async () => sourcePlan());
    const executor = new DevelopmentExecutor({
      workspaceId: "workspace:test",
      hostExecutionDigest: digest("9"),
      root: path.join(root, "runs"),
      planSource,
      materializeSource: vi.fn(),
    });

    const recipe = developmentRecipes(process.platform, process.arch)[0]!;
    const first = await executor.prepareExact({
      session: session(),
      runId: "run-one",
      recipe,
    });
    const second = await executor.prepareExact({
      session: session(),
      runId: "run-two",
      recipe,
    });

    expect(first.snapshot.toolchain).toEqual(second.snapshot.toolchain);
    expect(first.snapshot.toolchain.hostSourceBuild.digest).toBe(digest("9"));
    expect(first.snapshot.environmentDigest).toBe(second.snapshot.environmentDigest);
    expect(first.snapshot.recipeDigest).toBe(second.snapshot.recipeDigest);
    expect(first.snapshot.declaredEnvironment).toEqual({ CI: "1", NODE_ENV: "production" });
    expect(first.snapshot.declaredEnvironment).not.toHaveProperty("HOME");
    expect(first.snapshot.declaredEnvironment).not.toHaveProperty("PATH");
    expect(planSource).toHaveBeenCalledTimes(2);
    await expect(fsp.stat(path.join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds only inside the marker-owned root, strips ambient secrets, redacts logs, and publishes artifacts", async () => {
    const logs: string[] = [];
    const pnpmCli = await pnpmFixture(root, "pnpm-test", "process.exit(0);\n");
    const executor = new DevelopmentExecutor({
      workspaceId: "workspace:test",
      hostExecutionDigest: digest("9"),
      root: path.join(root, "runs"),
      planSource: async () => sourcePlan(),
      async materializeSource(_source, destination) {
        await fsp.writeFile(path.join(destination, "pnpm-lock.yaml"), "lock");
        await fsp.mkdir(path.join(destination, "workspace"), { recursive: true });
        await fsp.writeFile(path.join(destination, "workspace", "pnpm-lock.yaml"), "lock");
        await fsp.writeFile(
          path.join(destination, "build.mjs"),
          [
            "import fs from 'node:fs';",
            "console.log('token=should-not-survive');",
            "fs.mkdirSync('dist', {recursive:true});",
            "fs.writeFileSync('dist/server.mjs', 'export const exact = true;\\n');",
            "fs.writeFileSync('dist/environment.json', JSON.stringify({",
            "  cwd: process.cwd(),",
            "  declared: process.env.NODE_ENV,",
            "  ambient: process.env.DEVELOPMENT_EXECUTOR_SECRET ?? null",
            "}));",
          ].join("\n")
        );
      },
      onLog: (_runId, _stream, line) => logs.push(line),
    });
    const plan = await manualPlan("run-exact", pnpmCli);
    process.env["DEVELOPMENT_EXECUTOR_SECRET"] = "must-not-cross";

    await executor.materialize(plan);
    const artifact = await executor.execute(runFor(plan), plan, vi.fn());
    const stored = getBuild(plan.snapshot.snapshotDigest);

    expect(artifact.buildKey).toBe(plan.snapshot.snapshotDigest);
    expect(stored?.metadata.sourceStateHash).toBe(plan.snapshot.contentRoot);
    expect(stored?.metadata.sourceState).toEqual(plan.snapshot.repositoryState);
    const environment = stored?.artifacts.find((entry) => entry.path === "dist/environment.json");
    expect(environment?.encoding).toBe("utf8");
    expect(JSON.parse(environment?.content ?? "{}")).toEqual({
      cwd: path.join(root, "runs", plan.runId, "source"),
      declared: "production",
      ambient: null,
    });
    expect(logs).toContain("[REDACTED]");
    expect(logs.join("\n")).not.toContain("should-not-survive");
  });

  it("refuses path escapes and foreign owner markers before execution or deletion", async () => {
    const executor = new DevelopmentExecutor({
      workspaceId: "workspace:test",
      hostExecutionDigest: digest("9"),
      root: path.join(root, "runs"),
      planSource: async () => sourcePlan(),
      materializeSource: async () => {},
    });
    const pnpmCli = await pnpmFixture(root, "pnpm-test", "process.exit(0);\n");
    const escaped = await manualPlan("../outside", pnpmCli);
    await expect(executor.materialize(escaped)).rejects.toMatchObject({ code: "EINVAL" });

    const plan = await manualPlan("run-owned", pnpmCli);
    await executor.materialize(plan);
    const marker = path.join(root, "runs", plan.runId, ".vibestudio-development-run.json");
    await fsp.writeFile(
      marker,
      JSON.stringify({ version: 1, runId: "foreign", snapshotDigest: digest("8") })
    );
    const run = runFor(plan);
    await expect(executor.execute(run, plan, vi.fn())).rejects.toMatchObject({
      code: "EOWNERSHIP",
    });
    await expect(executor.retire(run)).rejects.toMatchObject({ code: "EOWNERSHIP" });
    await expect(fsp.stat(path.join(root, "runs", plan.runId))).resolves.toBeDefined();
  });

  it("re-verifies the complete retained toolchain before spawning after drift", async () => {
    const pnpmCli = await pnpmFixture(root, "pnpm-drift", "process.exit(0);\n");
    const spawnEvidence: string[] = [];
    const executor = new DevelopmentExecutor({
      workspaceId: "workspace:test",
      hostExecutionDigest: digest("9"),
      root: path.join(root, "runs"),
      planSource: async () => sourcePlan(),
      async materializeSource(_source, destination) {
        await fsp.writeFile(path.join(destination, "build.mjs"), "");
      },
      onLog: (_runId, _stream, line) => spawnEvidence.push(line),
    });
    const plan = await manualPlan("run-drift", pnpmCli);
    await executor.materialize(plan);
    const projectedPnpm = path.join(root, "runs", plan.runId, "toolchain", "pnpm");
    await fsp.chmod(projectedPnpm, 0o700);
    await fsp.writeFile(path.join(projectedPnpm, "injected.js"), "changed");

    await expect(executor.execute(runFor(plan), plan, vi.fn())).rejects.toMatchObject({
      code: "ETOOLCHAIN_DRIFT",
    });
    expect(spawnEvidence).toEqual([]);
  });

  it("stops the exact owned process group cooperatively", async () => {
    const lines: string[] = [];
    let materializations = 0;
    const pnpmCli = await pnpmFixture(
      root,
      "pnpm-hang",
      [
        "console.log('owned-process-ready');",
        "if (require('node:fs').existsSync('retry-ok')) process.exit(0);",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n")
    );
    const executor = new DevelopmentExecutor({
      workspaceId: "workspace:test",
      hostExecutionDigest: digest("9"),
      root: path.join(root, "runs"),
      planSource: async () => sourcePlan(),
      async materializeSource(_source, destination) {
        materializations += 1;
        if (materializations > 1) {
          await fsp.writeFile(path.join(destination, "retry-ok"), "");
        }
        await fsp.writeFile(
          path.join(destination, "build.mjs"),
          "import fs from 'node:fs'; fs.mkdirSync('dist'); fs.writeFileSync('dist/server.mjs', 'ok');"
        );
      },
      onLog: (_runId, _stream, line) => lines.push(line),
    });
    const plan = await manualPlan("run-stop", pnpmCli);
    await executor.materialize(plan);
    const executing = executor.execute(runFor(plan), plan, vi.fn());
    await vi.waitFor(() => expect(lines).toContain("owned-process-ready"));

    await expect(executor.stop(plan.runId)).resolves.toBeUndefined();
    await expect(executing).rejects.toMatchObject({ code: "ECANCELLED" });

    await executor.materialize(plan);
    await expect(executor.execute(runFor(plan), plan, vi.fn())).resolves.toMatchObject({
      buildKey: plan.snapshot.snapshotDigest,
    });
  });
});
