import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import { DODispatch } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE, type InternalDOBundle } from "./internalDOs/internalDoLoader.js";
import { postToDurableObject, type DORef } from "./workerdRpcRelay.js";
import {
  WorkerdManager,
  type WorkerdManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./workerdManager.js";
import { LifecycleDriver } from "./services/lifecycleDriver.js";
import { AlarmDriver } from "./services/alarmDriver.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { BuildResult } from "./buildV2/buildStore.js";
import {
  collectWorkspaceRpcCatalog,
  type WorkspaceRpcMethodDoc,
} from "./buildV2/workspaceRpcCatalog.js";
import { workspaceRpcSchema } from "./buildV2/workspaceRpcSchemas.js";
import { createHostDoAuthorityAttester } from "./bootstrap/workerd.js";
import {
  buildWorkerdPrograms,
  type WorkerdProgramSources,
} from "../../scripts/build-workerd-programs.mjs";

let compiledWorkerdPrograms: WorkerdProgramSources;
let compiledInternalDOBundle: InternalDOBundle;

function runtimeArtifact(source: string, ref = "main"): ExecutionArtifactRefV1 {
  const contentRoots = [
    { repoPath: source, stateHash: `state:${sha256(`state:${source}:${ref}`)}` },
  ];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:internal-workerd-test",
      effectiveVersion: sha256(`ev:${source}:${ref}`),
      state: { kind: "event" as const, eventId: `event:${source}:${ref}` },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: sha256(`recipe:${source}`),
    buildKey: sha256(`build:${source}:${ref}`),
    artifactDigest: sha256(`artifact:${source}:${ref}`),
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

beforeAll(async () => {
  const [internalDoBuild, programs] = await Promise.all([
    esbuild.build({
      entryPoints: ["src/server/internalDOs/index.ts"],
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      outfile: "internal-do.bundle.mjs",
      conditions: ["worker", "browser"],
      external: ["node:*", "electron"],
      logLevel: "silent",
      write: false,
    }),
    buildWorkerdPrograms({ write: false }),
  ]);
  const bundle = internalDoBuild.outputFiles?.[0]?.text;
  if (!bundle) throw new Error("Internal DO test bundle did not produce an in-memory output");
  compiledInternalDOBundle = {
    bundle,
    buildKey: createHash("sha256").update(bundle).digest("hex"),
  };
  compiledWorkerdPrograms = programs;
});

// Loader gateway servers started by harnesses; closed in afterEach. Userland
// DOs route through the UniversalDO facet host, which fetches `/_docode` from
// `getServerUrl`, so the harness must serve those loader endpoints.
const activeLoaderServers: Server[] = [];

async function createWorkerdHarness(
  overrides: Partial<WorkerdManagerDeps> & {
    getBuild?: (source: string, ref?: string) => Promise<BuildResult>;
    mainRpc?: (method: string, args: unknown[], target: string) => Promise<unknown>;
    bindWorkspaceProvider?: boolean;
  } = {}
) {
  const tokenManager = new TokenManager();
  const { getBuild, mainRpc, bindWorkspaceProvider = true, ...managerOverrides } = overrides;
  const builds = new Map<string, BuildResult>();
  // Construct the manager first (getServerUrl reads the port lazily via the
  // holder) so the loader-server closure can reference a `const` manager.
  const portHolder = { value: 0 };
  const manager = new WorkerdManager({
    tokenManager,
    fsService: {
      closeHandlesForCaller: () => {},
    } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    workspaceId: "workspace:internal-workerd-test",
    workerdPrograms: compiledWorkerdPrograms,
    internalDOBundle: compiledInternalDOBundle,
    getInternalDoEnv: () => ({}),
    workspacePath: mkdtempSync(join(tmpdir(), "vibestudio-workerd-workspace-")),
    statePath: mkdtempSync(join(tmpdir(), "vibestudio-workerd-state-")),
    // Internal DO outbound RPCs route through the same loopback harness. The
    // port is resolved only when a DO class is registered, after the server
    // below has bound and populated the holder.
    getProxyPort: () => (mainRpc ? portHolder.value : 9),
    getSharedEgressPort: () => Promise.resolve(mainRpc ? portHolder.value : 10),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: "internal-storage-egress-secret",
    getWorkerdGatewayToken: () => "internal-test-workerd-gateway-token",
    ...managerOverrides,
  } satisfies WorkerdManagerDeps);
  const provider: WorkerdWorkspaceProvider = {
    bindRuntimeImage: async (source: string, ref?: string) => {
      if (!getBuild) throw new Error("workspace builds are not used by internal DO tests");
      const build = await getBuild(source, ref);
      if (!build.metadata.execution || !build.metadata.authority) {
        throw new Error(`fixture build ${build.buildKey} has no sealed execution identity`);
      }
      const artifact = build.metadata.execution;
      builds.set(build.buildKey, build);
      return {
        source,
        unitName: source,
        artifact,
        authority: build.metadata.authority,
      };
    },
    getBuildByKey: (key: string) => builds.get(key) ?? null,
    getBuildByExecution: (key: string, executionDigest: string) => {
      const build = builds.get(key) ?? null;
      return build?.metadata.execution?.executionDigest === executionDigest ? build : null;
    },
    getManifestRoutes: () => [],
    getManifestDoClasses: () => [],
    singletonRegistry: new SingletonRegistry([]),
  };
  if (bindWorkspaceProvider) manager.bindWorkspaceProvider(provider);
  const attestHostDoCall = createHostDoAuthorityAttester({
    manager,
    workspaceId: "workspace:internal-workerd-test",
    services: [],
    callerId: "internal-workerd-test",
    callerSubject: {
      userId: "internal-workerd-test-user",
      handle: "internal-workerd-test-user",
    },
  });

  const loaderServer = createServer(async (req, res) => {
    const u = req.url ?? "";
    if (u === "/rpc" && req.method === "POST" && mainRpc) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        from: string;
        target: string;
        message: { requestId: string; method: string; args: unknown[] };
      };
      let result: unknown;
      let error: string | undefined;
      try {
        result = await mainRpc(envelope.message.method, envelope.message.args, envelope.target);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: { callerId: "main", callerKind: "server" } },
          provenance: [],
          message: {
            type: "response",
            requestId: envelope.message.requestId,
            ...(error === undefined ? { result } : { error, errorKind: "internal" }),
          },
        })
      );
      return;
    }
    if (u.startsWith("/_doversion/") || u.startsWith("/_docode/")) {
      if (req.headers["x-vibestudio-loader-secret"] !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const isV = u.startsWith("/_doversion/");
      const segs = (u.slice((isV ? "/_doversion/" : "/_docode/").length).split("?")[0] ?? "").split(
        "/"
      );
      const source = decodeURIComponent(segs[0] ?? "");
      const className = decodeURIComponent(segs[1] ?? "");
      if (isV) {
        const v = manager.getDoVersion(source, className);
        if (v === null) {
          res.writeHead(404);
          res.end("nf");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: v }));
        return;
      }
      void manager.getDoCode(source, className).then((code) => {
        if (!code) {
          res.writeHead(404);
          res.end("nf");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(code));
      });
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  portHolder.value = await new Promise<number>((r) =>
    loaderServer.listen(0, "127.0.0.1", () => {
      const a = loaderServer.address();
      r(typeof a === "object" && a ? a.port : 0);
    })
  );
  activeLoaderServers.push(loaderServer);

  const sealedEntities = new Map<
    string,
    Parameters<WorkerdManager["restoreDurableObjectEntity"]>[0]
  >();
  const attachDurableObject = async (ref: DORef): Promise<void> => {
    const targetId = `do:${ref.source}:${ref.className}:${ref.objectKey}`;
    let record = sealedEntities.get(targetId);
    if (!record) {
      const prepared = await manager.ensureDurableObjectEntity({
        source: ref.source,
        className: ref.className,
        key: ref.objectKey,
        contextId: `ctx:test:${sha256(targetId)}`,
      });
      record = {
        id: prepared.targetId,
        kind: "do",
        source: {
          repoPath: ref.source,
          effectiveVersion: prepared.effectiveVersion,
        },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: prepared.authority,
        contextId: `ctx:test:${sha256(targetId)}`,
        className: ref.className,
        key: ref.objectKey,
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      };
      sealedEntities.set(targetId, record);
    }
    await manager.restoreDurableObjectEntity(record);
  };

  const callDurableObject = async (
    ref: DORef,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    await attachDurableObject(ref);
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return postToDurableObject(ref, method, args, {
      workerdUrl: `http://127.0.0.1:${port}`,
      workerdGatewayToken: manager.getWorkerdGatewayToken(),
      workerdDispatchSecret: manager.getDispatchSecret(),
      callerId: "internal-workerd-test",
      callerKind: "server",
      userId: "internal-workerd-test-user",
      authorization: attestHostDoCall(ref, method, args),
    });
  };

  return { manager, tokenManager, callDurableObject, attachDurableObject };
}

function createDODispatch(
  manager: WorkerdManager,
  tokenManager: TokenManager,
  ensureUserlandDoReady: (ref: DORef) => Promise<void>
): DODispatch {
  const dispatch = new DODispatch(ensureUserlandDoReady);
  dispatch.setTokenManager(tokenManager);
  dispatch.setGetWorkerdGatewayToken(() => manager.getWorkerdGatewayToken());
  dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
  dispatch.setGetWorkerdUrl(() => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return `http://127.0.0.1:${port}`;
  });
  dispatch.setAuthorityAttester(
    createHostDoAuthorityAttester({
      manager,
      workspaceId: "workspace:internal-workerd-test",
      services: [],
      callerId: "internal-workerd-test",
    })
  );
  // These transport integration tests do not instantiate RpcServer. Production
  // wires this callback to RpcServer.withAuthorityParent so nested RPC remains
  // authorized for exactly the awaited durable-object invocation.
  dispatch.setAuthorityParentRunner(async (_receiverRuntimeId, _authorization, invoke) => invoke());
  return dispatch;
}

async function bundleWorker(
  source: string,
  entryPoint: string,
  ev: string,
  unitRoot = dirname(entryPoint)
): Promise<BuildResult> {
  const packageJsonPath = join(unitRoot, "package.json");
  const manifest = existsSync(packageJsonPath)
    ? (
        JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          vibestudio?: {
            authority?: unknown;
            durable?: { classes?: Array<{ className: string; rpcSchema?: string }> };
          };
        }
      ).vibestudio
    : undefined;
  const authority =
    manifest?.authority === undefined
      ? { requests: [], provides: [], serviceRequests: [] }
      : parseUnitAuthorityManifest(manifest.authority);
  const rpcSchemas = Object.fromEntries(
    (manifest?.durable?.classes ?? [])
      .filter(
        (entry): entry is { className: string; rpcSchema: string } =>
          typeof entry.rpcSchema === "string"
      )
      .map((entry) => {
        const schema = workspaceRpcSchema(entry.rpcSchema);
        if (!schema) throw new Error(`Unknown workspace RPC schema ${entry.rpcSchema}`);
        return [entry.className, schema];
      })
  );
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    write: false,
    conditions: ["worker", "browser"],
    // Keep this direct fixture bundle aligned with the workerd worker builder:
    // bare fs/path are resolved by the sandbox runtime, while node:* remains
    // external for nodejs_compat.
    external: ["node:*", "fs", "path", "electron"],
    logLevel: "silent",
  });
  return buildResult(
    source,
    ev,
    result.outputFiles[0]!.text,
    await collectWorkspaceRpcCatalog(unitRoot, {
      provider: source,
      authority,
      rpcSchemas,
    })
  );
}

function buildResult(
  source: string,
  ev: string,
  bundle: string,
  workspaceRpcCatalog: WorkspaceRpcMethodDoc[] = []
): BuildResult {
  const execution = runtimeArtifact(source, ev);
  const buildKey = execution.buildKey;
  return {
    dir: `/tmp/vibestudio-${ev}-build`,
    buildKey,
    sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
    metadata: {
      kind: "worker",
      name: source,
      buildKey,
      sourcePath: source,
      ev,
      sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
      sourceState: execution.sourceState.state,
      sourcemap: false,
      authority: { requests: [], provides: [], serviceRequests: [] },
      workspaceRpcCatalog,
      execution,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

describe("internal storage DOs under workerd", () => {
  let manager: WorkerdManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
    while (activeLoaderServers.length) {
      const server = activeLoaderServers.pop()!;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("resets and restores internal DO storage through a graceful workerd stop", async () => {
    // BrowserVaultDO writes are host-capability attested, which requires the
    // installed product identity; synthesize one for this process the same way
    // a packaged build ships it.
    if (!process.env["VIBESTUDIO_APP_ROOT"]) {
      const appRoot = mkdtempSync(join(tmpdir(), "vibestudio-host-root-"));
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(appRoot, "dist"), { recursive: true });
      writeFileSync(
        join(appRoot, "dist", "host-build-fingerprint.json"),
        JSON.stringify({ fingerprint: "ab".repeat(32) })
      );
      process.env["VIBESTUDIO_APP_ROOT"] = appRoot;
    }
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "BrowserVaultDO",
      objectKey: "resettable-browser-environment",
    };

    await doDispatch.dispatch(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "keep me",
      actionUrl: "https://example.com/session",
      realm: "",
    });
    expect((await doDispatch.dispatch(ref, "listPasswordSummaries")) as unknown[]).toHaveLength(1);

    // Internal quiesce is a graceful workerd stop (no per-facet abort exists);
    // the next dispatch lazily restarts workerd against fresh storage.
    const reset = await manager.resetDOStorage(ref, "exercise internal maintenance");
    expect((await doDispatch.dispatch(ref, "listPasswordSummaries")) as unknown[]).toHaveLength(0);
    expect(await manager.listDOStorageBackups(ref)).toEqual([
      expect.objectContaining({ operationId: reset.operationId }),
    ]);

    await manager.restoreDOStorageBackup(ref, reset.operationId, "restore the password");
    expect((await doDispatch.dispatch(ref, "listPasswordSummaries")) as unknown[]).toHaveLength(1);
  }, 60_000);

  // Manual empirical probe (~37s; opt-in via `.only` or removing `.skip`) behind
  // the unbounded eval design: real workerd does NOT cap a DO `fetch` handler
  // the way it caps a regular Worker (~30s). Held 35s here and returned cleanly,
  // proving workerd itself is not the short cap in this path. The relay's bare
  // `fetch` adds undici's ~300s `headersTimeout`, defeatable with a custom
  // dispatcher for held calls.
  it.skip("real workerd holds a DO fetch handler open past the ~30s regular-Worker wall limit", async () => {
    // Probe at 35s; a workerd-level cap would instead error around 30s. A
    // separate manual probe confirmed a HELD request runs 150s+ cleanly —
    // workerd does not cap long-held requests; only no-connection waitUntil is capped.
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-sleep"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "sleep-probe",
    };

    // Sanity: a short hold returns its value through the full relay path.
    const shortStart = Date.now();
    const short = await harness.callDurableObject(ref, "sleepProbe", 2_000);
    expect(short).toEqual({ requestedMs: 2_000, ok: true });
    expect(Date.now() - shortStart).toBeGreaterThanOrEqual(1_800);

    // The real question: a hold LONGER than a regular Worker's ~30s wall limit.
    const longStart = Date.now();
    const long = await harness.callDurableObject(ref, "sleepProbe", 35_000);
    const elapsed = Date.now() - longStart;
    expect(long).toEqual({ requestedMs: 35_000, ok: true });
    expect(elapsed).toBeGreaterThanOrEqual(34_000);
  }, 90_000);

  it("measures whether a DO runs waitUntil work and I/O after its request returns", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-bg"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
      mainRpc: async () => [],
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "bg-probe",
    };

    const probeRet = await harness.callDurableObject(ref, "bgRunProbe");
    // Wait well past the 3s background timer, WITHOUT touching the DO, so the
    // background task only runs if the isolate keeps itself alive on its own.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const result = (await harness.callDurableObject(ref, "bgRunResult")) as Record<string, string>;

    const startedAt = Number(result["started_at"]);
    const ranAt = result["ran_at"] ? Number(result["ran_at"]) : null;
    const deltaMs = ranAt != null && !Number.isNaN(startedAt) ? ranAt - startedAt : null;
    console.log("BG-PROBE RESULT:", JSON.stringify({ probeRet, result, deltaMs }));
    expect(probeRet).toEqual({ hasWaitUntil: true });
    expect(deltaMs).toBeGreaterThanOrEqual(2_800);
    expect(deltaMs).toBeLessThan(6_000);
    expect(result["bg_io"]).toBe("ok");
  }, 40_000);

  it("admits ordinary, alarm, lifecycle, and a second held call during a held DO call", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-held-admission"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "held-admission-probe",
    };
    await harness.callDurableObject(ref, "currentBootGeneration");

    const first = doDispatch.dispatchHeld(ref, "heldSqlProbe", "first", 2_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const admissionStartedAt = Date.now();
    const [ordinary, alarm, prepare, second] = await Promise.all([
      doDispatch.dispatch(ref, "currentBootGeneration"),
      doDispatch.dispatchAlarm(ref),
      doDispatch.dispatchLifecycle(ref, "prepare", {
        epoch: "held-admission",
        mode: "suspend",
        reason: "probe",
        deadlineMs: 1_000,
      }),
      doDispatch.dispatchHeld(ref, "heldSqlProbe", "second", 250),
    ]);
    const admissionMs = Date.now() - admissionStartedAt;

    expect(ordinary).toBe("1");
    expect(alarm).toEqual({ nextAlarm: null });
    expect(prepare).toEqual({ status: "ready" });
    expect(second).toEqual({ label: "second", ok: true });
    expect(admissionMs).toBeLessThan(1_000);
    await expect(first).resolves.toEqual({ label: "first", ok: true });
  }, 30_000);

  it.skip("PROBE: how long does ctx.waitUntil keep a DO alive in the background?", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-bgdur"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "bg-dur-probe",
    };

    // 150s background task. Don't touch the DO meanwhile.
    await harness.callDurableObject(ref, "bgRunProbe", 150_000);
    await new Promise((resolve) => setTimeout(resolve, 155_000));
    const result = (await harness.callDurableObject(ref, "bgRunResult")) as Record<string, string>;
    const startedAt = Number(result["started_at"]);
    const ranAt = result["ran_at"] ? Number(result["ran_at"]) : null;
    const deltaMs = ranAt != null && !Number.isNaN(startedAt) ? ranAt - startedAt : null;
    console.log("BG-DURATION RESULT:", JSON.stringify({ result, deltaMs }));
    expect(result["started_at"]).toBeDefined();
  }, 240_000);

  it("starts internal workerd before a workspace provider is attached", async () => {
    // Regression: the EvalDO binding was emitted as `unsafeEval = ()` (empty
    // struct), which workerd rejects with "Type mismatch; expected Void", so the
    // whole runtime failed to boot once EvalDO was registered. Other workerd tests
    // register only WorkspaceDO/BrowserVaultDO, so they never exercised this binding.
    const harness = await createWorkerdHarness({ bindWorkspaceProvider: false });
    manager = harness.manager;
    // registerAllDOClasses writes the capnp config and (re)starts workerd; a
    // malformed config makes workerd exit before accepting HTTP and this rejects.
    await expect(
      manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "EvalDO" }])
    ).resolves.not.toThrow();
    expect(manager.getBootGeneration()).toBeGreaterThanOrEqual(1);
  });

  it("EvalDO durable job queue: startRun schedules, remains idempotent, and persists a terminal", async () => {
    // With no eval engine declared, background execution fails immediately. That is useful here:
    // the real workerd test proves startRun acknowledges the durable row, schedules under the DO
    // lifetime, and makes the terminal failure observable without a held host request.
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "EvalDO" }]);
    const ref = { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey: "job-queue-test" };

    // The first call acknowledges the newly inserted row before background guest work runs.
    expect(
      await harness.callDurableObject(ref, "startRun", {
        runId: "run-1",
        code: "1+1",
        gatewayToken: "gateway-job-queue-test",
      })
    ).toMatchObject({
      runId: "run-1",
      status: "pending",
      existing: false,
      scopeInputRevision: "scope:initial",
      runDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    // Idempotent on runId and exact input: replay returns the same row in whichever durable state
    // it has reached, while different work cannot alias the identity.
    const replay = (await harness.callDurableObject(ref, "startRun", {
      runId: "run-1",
      code: "1+1",
      gatewayToken: "gateway-job-queue-test",
    })) as { runId: string; status: string };
    expect(replay.runId).toBe("run-1");
    expect(["pending", "running", "done"]).toContain(replay.status);
    await expect(
      harness.callDurableObject(ref, "startRun", {
        runId: "run-1",
        code: "DIFFERENT",
        gatewayToken: "gateway-job-queue-test",
      })
    ).rejects.toThrow("runId run-1 was reused with different input");

    // getRun reaches the canonical terminal without relying on a held executeRun response.
    let observed = (await harness.callDurableObject(ref, "getRun", "run-1")) as {
      status: string;
      result?: { success?: boolean; error?: string };
    };
    for (let attempt = 0; attempt < 20 && observed.status !== "done"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed = (await harness.callDurableObject(ref, "getRun", "run-1")) as typeof observed;
    }
    expect(observed).toMatchObject({ status: "done", result: { success: false } });
    expect(await harness.callDurableObject(ref, "getRun", "nope")).toEqual({ status: "unknown" });

    // Reset preserves terminal history.
    expect(await harness.callDurableObject(ref, "reset")).toEqual({ ok: true });
    expect(await harness.callDurableObject(ref, "getRun", "run-1")).toMatchObject({
      status: "done",
    });

    // A fresh run after reset is independent.
    expect(
      await harness.callDurableObject(ref, "startRun", {
        runId: "run-2",
        code: "2+2",
        gatewayToken: "gateway-job-queue-test",
      })
    ).toMatchObject({ runId: "run-2" });
  }, 30_000);

  it("round-trips entity activate / resolve / retire / gc through WorkspaceDO under workerd", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" }]);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-test",
    };

    const activateInput = {
      kind: "panel",
      source: { repoPath: "panels/example", effectiveVersion: "v1" },
      contextId: "ctx-1",
      key: "entry-1",
    };
    const record = (await harness.callDurableObject(ref, "entityActivate", activateInput)) as {
      id: string;
      kind: string;
      status: string;
    };
    expect(record.kind).toBe("panel");
    expect(record.status).toBe("active");

    const resolved = (await harness.callDurableObject(ref, "entityResolveActive", record.id)) as {
      id: string;
      status: string;
    };
    expect(resolved.id).toBe(record.id);
    expect(resolved.status).toBe("active");

    const retired = (await harness.callDurableObject(ref, "entityRetire", record.id)) as {
      id: string;
      status: string;
    };
    expect(retired.status).toBe("retired");

    const deleted = (await harness.callDurableObject(ref, "entityGc", {
      all: true,
      graceMs: 0,
    })) as string[];
    expect(deleted).toEqual([record.id]);
    await expect(
      harness.callDurableObject(ref, "entityResolveActive", record.id)
    ).resolves.toBeNull();
  }, 30_000);

  it("drives lifecycle prepare and resume through real workerd restart hooks", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-test"
    );
    const triggerBuild = buildResult(
      "workers/restart-trigger",
      "restart-trigger-test",
      `export default { fetch() { return new Response("trigger"); } };`
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        if (source === "workers/restart-trigger") return triggerBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const lifecycleDriver = new LifecycleDriver({
      workerdManager: manager,
      doDispatch,
      workspaceId: "workspace-lifecycle",
      prepareDeadlineMs: 3_000,
      concurrency: 2,
    });
    const workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-lifecycle",
    };
    const probeRef = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "probe-1",
    };

    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" },
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    lifecycleDriver.start();
    try {
      // A raw caller cannot drive lifecycle. `harness.callDurableObject` reaches
      // the DO via the converged envelope relay, where `__lifecycle/prepare` is
      // not an exposed method (the reserved server-gated path is only reachable
      // through the server's instance-token DODispatch channel) — so it is
      // rejected. Either rejection ("not exposed" / 403) proves the gate holds.
      await expect(
        harness.callDurableObject(probeRef, "__lifecycle/prepare", {
          epoch: "raw",
          mode: "suspend",
          reason: "raw",
          deadlineMs: 1_000,
        })
      ).rejects.toThrow(/no direct authority declaration|403/);

      await doDispatch.dispatch(workspaceRef, "lifecycleLeaseUpsert", {
        source: probeRef.source,
        className: probeRef.className,
        objectKey: probeRef.objectKey,
        detail: { test: "planned-restart" },
      });

      // A planned workerd restart drives the prepare/resume lifecycle hooks on
      // registered DOs. (Worker create no longer restarts — the worker host is
      // static — so trigger a real restart explicitly via the internal entry.)
      await (manager as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();

      expect(manager.getBootGeneration()).toBe(2);
      await expect(doDispatch.dispatch(probeRef, "currentBootGeneration")).resolves.toBe("2");
      await expect(doDispatch.dispatch(probeRef, "lifecycleEvents")).resolves.toMatchObject([
        {
          kind: "prepare",
          input: expect.objectContaining({ reason: "planned" }),
          bootGeneration: "1",
        },
        {
          kind: "resume",
          input: expect.objectContaining({
            reason: "planned",
            previousGeneration: 1,
            currentGeneration: 2,
          }),
          bootGeneration: "2",
        },
      ]);

      const leases = await doDispatch.dispatch(workspaceRef, "lifecycleListLeases");
      expect(leases).toEqual([
        expect.objectContaining({
          source: probeRef.source,
          className: probeRef.className,
          objectKey: probeRef.objectKey,
        }),
      ]);
    } finally {
      lifecycleDriver.stop();
    }
  }, 30_000);

  it("fires server-driven alarms on a real DO via the AlarmDriver", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "alarm-probe-test"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const alarmDriver = new AlarmDriver({ doDispatch, workspaceId: "workspace-alarm" });
    const workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-alarm",
    };
    const probeRef = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "alarm-probe-1",
    };

    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" },
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);

    try {
      await doDispatch.dispatch(workspaceRef, "entityActivate", {
        kind: "do",
        source: { repoPath: probeRef.source, effectiveVersion: probeBuild.metadata.ev },
        contextId: "ctx-alarm-probe",
        className: probeRef.className,
        key: probeRef.objectKey,
      });
      // Register an already-due alarm directly in WorkspaceDO, then start the
      // driver: it should drain the due alarm and fire `__alarm` → probe.alarm().
      await doDispatch.dispatch(workspaceRef, "alarmSet", {
        source: probeRef.source,
        className: probeRef.className,
        objectKey: probeRef.objectKey,
        wakeAt: Date.now() - 1,
      });
      alarmDriver.start();

      // Poll until the probe records the alarm fire (driver fires ~immediately).
      let events: Array<{ kind: string }> = [];
      for (let i = 0; i < 40; i++) {
        events = (await doDispatch.dispatch(probeRef, "lifecycleEvents")) as Array<{
          kind: string;
        }>;
        if (events.some((e) => e.kind === "alarm")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(events.some((e) => e.kind === "alarm")).toBe(true);

      // The alarm fired once and was drained — no longer pending.
      await expect(
        doDispatch.dispatch(workspaceRef, "alarmNextWakeAt", Date.now())
      ).resolves.toBeNull();
    } finally {
      alarmDriver.stop();
    }
  }, 30_000);

  it("returns affected counts for BrowserVaultDO cookie clears", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    await harness.callDurableObject(ref, "addCookiesBatch", {
      jobId: "cookie-clear-job",
      batchIndex: 0,
      cookies: [
        {
          name: "sid",
          value: "one",
          domain: ".example.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          sourceScheme: "secure",
          sourcePort: 443,
        },
        {
          name: "sid",
          value: "two",
          domain: ".other.test",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          sourceScheme: "secure",
          sourcePort: 443,
        },
      ],
    });

    await expect(
      harness.callDurableObject(ref, "clearCookiesForOrigin", "https://example.com")
    ).resolves.toBe(1);
    await expect(harness.callDurableObject(ref, "clearAllCookies")).resolves.toBe(1);
  }, 30_000);

  it("round-trips BrowserVaultDO encrypted passwords in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const id = await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "correct horse battery staple",
      actionUrl: "https://example.com/session",
      realm: "",
    });

    expect(typeof id).toBe("number");
    await expect(harness.callDurableObject(ref, "listPasswordSummaries")).resolves.toEqual([
      expect.not.objectContaining({ password: expect.anything() }),
    ]);
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com/login")
    ).resolves.toMatchObject([
      {
        origin_url: "https://example.com",
        username: "ada",
        password: "correct horse battery staple",
        action_url: "https://example.com/session",
      },
    ]);

    await harness.callDurableObject(ref, "updatePassword", id, { password: "updated secret" });
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([{ id, username: "ada", password: "updated secret" }]);
  }, 30_000);

  it("supports BrowserVaultDO autofill password lookup semantics in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const id = (await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 0,
    })) as number;

    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([
      {
        id,
        origin_url: "https://example.com",
        username: "ada",
        password: "first secret",
      },
    ]);

    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(false);
    await harness.callDurableObject(ref, "addNeverSave", "https://never.example");
    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(true);

    await harness.callDurableObject(ref, "updateLastUsed", id);
    await expect(harness.callDurableObject(ref, "listPasswordSummaries")).resolves.toMatchObject([
      { id, times_used: 1 },
    ]);
  }, 30_000);

  it("upserts duplicate BrowserVaultDO password batch imports in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const password = {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 1,
    };
    await expect(
      harness.callDurableObject(ref, "addPasswordsBatch", [password], {
        sourceId: "chrome:test-source",
      })
    ).resolves.toBe(1);
    await expect(
      harness.callDurableObject(
        ref,
        "addPasswordsBatch",
        [{ ...password, password: "second secret", timesUsed: 7 }],
        { sourceId: "chrome:test-source" }
      )
    ).resolves.toBe(1);
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([
      {
        origin_url: "https://example.com",
        username: "ada",
        password: "second secret",
        times_used: 7,
      },
    ]);
  }, 30_000);
});
