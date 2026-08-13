import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { DevelopmentRun } from "@vibestudio/service-schemas/development";
import { developmentRecipeFixture } from "./developmentRecipeFixture.test-helper.js";
import {
  IsolatedDevelopmentHostExecutor,
  type IsolatedDevelopmentManager,
} from "./isolatedDevelopmentHostExecutor.js";
import type { PreparedDevelopmentBuild } from "./developmentExecutor.js";
import type { DevInstanceSupervisorOptions } from "../../dev/devInstanceSupervisor.js";

const roots: string[] = [];
const digest = (character: string) => character.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-isolated-executor-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const generationId = "1".repeat(32);
  const manager: IsolatedDevelopmentManager = {
    mintClientInvite: vi.fn(async () => "vibestudio://connect?child"),
    waitForClientAttestation: vi.fn(async (requestId, _timeout, assertGeneration) => {
      assertGeneration();
      return { requestId, childRuntimeId: "shell:child", attestedAt: 40 };
    }),
  };
  const unregister = vi.fn();
  let resolveExit: ((code: number) => void) | null = null;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let supervisorOptions: DevInstanceSupervisorOptions | null = null;
  const executor = new IsolatedDevelopmentHostExecutor({
    controlRepoRoot: root,
    buildExecutor: {
      resolveOwnedLaunch: vi.fn(async () => ({
        runRoot: root,
        sourceRoot,
        nodePath: process.execPath,
        serverEntryPath: path.join(sourceRoot, "dist", "server.mjs"),
        serverBuildId: digest("a"),
      })),
    },
    register(input) {
      return {
        schemaVersion: 1,
        ...input,
        generationId,
      };
    },
    unregister,
    bootstrap: vi.fn(async () => ({ status: "paired" as const, workspaceName: "main" })),
    createManager: vi.fn(async () => manager),
    supervisor(options) {
      supervisorOptions = options;
      const childProcess = {
        pid: 4242,
        stdout: null,
        stderr: null,
      } as unknown as ChildProcess;
      return {
        process: childProcess,
        async start() {
          await options.onSpawn?.({
            version: 1,
            platform: globalThis.process.platform === "darwin" ? "darwin" : "linux",
            pid: 4242,
            processGroupId: 4242,
            startCoordinate: "test-start",
          });
          await options.readiness!.onReady({
            mode: "hub",
            gatewayUrl: "http://127.0.0.1:4243",
            rootInvite: null,
            serverId: `srv_${"s".repeat(24)}`,
            serverBootId: `boot_${"b".repeat(24)}`,
            gatewayPort: 4243,
            pid: 4242,
            version: "test",
            buildId: digest("a"),
            workspaces: [
              {
                workspaceId: "workspace:main",
                name: "main",
                lastOpened: 1,
                running: true,
                ephemeral: true,
              },
            ],
          });
        },
        wait: () => exit,
        stop: vi.fn(async () => {
          resolveExit?.(0);
          await Promise.resolve();
          return 0;
        }),
      } as never;
    },
    now: () => 30,
  });
  return {
    executor,
    manager,
    unregister,
    generationId,
    options: () => supervisorOptions,
  };
}

function runAndPlan(): { run: DevelopmentRun; plan: PreparedDevelopmentBuild } {
  const recipe = developmentRecipeFixture(process.platform, process.arch, {
    kind: "isolated-host",
    includeClient: true,
  });
  const snapshot = {
    version: 1 as const,
    sessionId: "session:one",
    contextId: "context:one",
    pair: {
      kind: "combined" as const,
      host: {
        repositoryId: "repository:one",
        repoPath: "projects/vibestudio",
        repositoryState: { kind: "event" as const, eventId: "event:one" },
        repositoryManifestDigest: digest("1"),
        materializedTreeDigest: digest("2"),
        contentRoot: `state:${digest("3")}`,
        sourcePlanDigest: digest("4"),
      },
      base: {
        repositoryId: "repository:base",
        repoPath: "templates/base",
        repositoryState: { kind: "event" as const, eventId: "event:base" },
        repositoryManifestDigest: digest("a"),
        materializedTreeDigest: digest("b"),
        contentRoot: `state:${digest("c")}`,
        sourcePlanDigest: digest("d"),
      },
      pairDigest: digest("0"),
    },
    recipeDigest: digest("5"),
    toolchain: {
      executorId: digest("6"),
      node: { digest: digest("7"), version: "v24", platform: process.platform, arch: process.arch },
      pnpm: { digest: digest("8"), version: "10" },
      hostSourceBuild: { digest: digest("9") },
    },
    declaredEnvironment: recipe.declaredEnvironment,
    environmentDigest: digest("b"),
    lockfileDigest: digest("c"),
    snapshotDigest: digest("d"),
  };
  const run: DevelopmentRun = {
    version: 1,
    runId: "run:isolated",
    sessionId: snapshot.sessionId,
    ownerRuntimeId: "shell:initiating",
    ownerRuntimeKind: "shell",
    ownerUserId: "user:one",
    attachedHostAuthorityCeiling: [{ capability: "*", resource: { kind: "prefix", prefix: "" } }],
    target: { kind: "isolated-host", includeClient: true, executorId: "shell:desktop" },
    recipe,
    snapshot,
    state: "starting",
    commitPoint: "artifacts-verified",
    artifact: {
      version: 1,
      buildKey: digest("e"),
      executionDigest: digest("f"),
    } as unknown as NonNullable<DevelopmentRun["artifact"]>,
    instance: null,
    hostReadiness: "starting",
    client: null,
    attachedHost: null,
    repair: null,
    createdAt: 1,
    updatedAt: 1,
    terminalAt: null,
  };
  return {
    run,
    plan: {
      version: 1,
      runId: run.runId,
      sourcePlans: {} as PreparedDevelopmentBuild["sourcePlans"],
      snapshot,
      recipe,
      executables: {
        nodePath: process.execPath,
        pnpmCliPath: "/pnpm/pnpm.cjs",
        pnpmRootPath: "/pnpm",
        pnpmCliRelativePath: "pnpm.cjs",
      },
    },
  };
}

describe("IsolatedDevelopmentHostExecutor", () => {
  it("carries includeClient through exact host readiness and its bounded child manager", async () => {
    const f = fixture();
    const { run, plan } = runAndPlan();
    let registered: DevelopmentRun["instance"] = null;
    const ready = vi.fn();
    const instance = await f.executor.start(run, plan, {
      onRegistered(value) {
        registered = value;
      },
      onReady: ready,
      onExit: vi.fn(),
    });

    expect(instance).toMatchObject({
      generationId: f.generationId,
      state: "ready",
      executionDigest: run.artifact!.executionDigest,
    });
    expect(ready).toHaveBeenCalledWith(instance);
    expect(f.options()?.env).toMatchObject({
      VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION: f.generationId,
      VIBESTUDIO_DEVELOPMENT_PARENT_RUN: run.runId,
    });
    const isolatedEnv = f.options()?.env ?? {};
    for (const forbidden of [
      "VIBESTUDIO_ADMIN_TOKEN",
      "VIBESTUDIO_WORKERD_GATEWAY_TOKEN",
      "VIBESTUDIO_HUB_RUNTIME_TOKEN",
      "VIBESTUDIO_IDENTITY_DB",
      "VIBESTUDIO_PROFILE_ENCRYPTION_KEY",
      "VIBESTUDIO_INSPECTOR_ENDPOINT",
      "VIBESTUDIO_DEVICE_CREDENTIALS",
    ]) {
      expect(isolatedEnv).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(isolatedEnv)).not.toContain("refreshToken");

    const managedRun: DevelopmentRun = {
      ...run,
      state: "awaiting-readiness",
      instance: registered,
      hostReadiness: "ready",
    };
    await expect(f.executor.mintClientInvite(managedRun)).resolves.toBe(
      "vibestudio://connect?child"
    );
    await expect(
      f.executor.waitForClientAttestation(managedRun, `development-client-${"2".repeat(32)}`)
    ).resolves.toMatchObject({ childRuntimeId: "shell:child" });
  });

  it("makes intentional stop own the exit race and refuses a foreign generation", async () => {
    const f = fixture();
    const { run, plan } = runAndPlan();
    let registered: DevelopmentRun["instance"] = null;
    const onExit = vi.fn();
    await f.executor.start(run, plan, {
      onRegistered(value) {
        registered = value;
      },
      onReady: vi.fn(),
      onExit,
    });
    const managedRun: DevelopmentRun = {
      ...run,
      state: "ready",
      instance: registered,
      hostReadiness: "ready",
    };
    await expect(f.executor.stop(managedRun)).resolves.toMatchObject({
      state: "stopped",
    });
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledOnce();

    const foreign = fixture();
    const foreignRun: DevelopmentRun = {
      ...run,
      state: "ready",
      instance: {
        instanceId: "development-foreign",
        generationId: "f".repeat(32),
        lifecycle: "ephemeral",
        state: "ready",
        executionDigest: run.artifact!.executionDigest,
        serverBuildId: digest("a"),
        serverId: "server-foreign",
        serverBootId: "boot-foreign",
        workspaceId: "workspace-foreign",
        workspaceName: "foreign",
        gatewayUrl: "http://127.0.0.1:4999",
        registeredAt: 1,
        readyAt: 2,
        stoppedAt: null,
      },
      hostReadiness: "ready",
    };
    await expect(foreign.executor.stop(foreignRun)).rejects.toMatchObject({
      code: "EOWNERSHIP",
    });
    expect(foreign.unregister).not.toHaveBeenCalled();
  });
});
