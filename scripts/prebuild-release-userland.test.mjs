import { joinChildProcess } from "./lib/join-child-process.mjs";
import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { Ownership } from "@vibestudio/shared/ownership";
import { scratchDirOf } from "@vibestudio/shared/ownershipLedger";
import {
  awaitHubReady,
  exportReleaseBuild,
  prepareInstalledTemplateRelease,
  runInstalledRpcBatch,
  verifyPreparedReleaseUserland,
  withStandaloneReleaseSession,
  verifyAndPublishSchemaEvidence,
} from "./prebuild-release-userland.mjs";
import {
  schemaProbeComponentPath,
  schemaProbeStagingPath,
  publishSchemaProbeComponent,
  retireSchemaProbeStaging,
} from "./lib/schema-evidence-publication.mjs";
import { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";
import {
  createConnectDeepLink,
  createConnectPairUrl,
  DEFAULT_IROH_RELAYS,
  PAIRING_PROTOCOL_VERSION,
} from "./cli/lib/connect-grammar.generated.mjs";
const roots = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-userland-test-"));
  roots.push(root);
  return root;
}

test("installed schema publication joins the genuine verifier owner before advertising its component", async () => {
  const root = await fixture();
  const records = verificationRecords();
  const context = await verificationFixture(root, records);
  const installation = {
    hostBuild: { version: 1, mode: "production", fingerprint: "a".repeat(64), inputCount: 1 },
    compilerProtocol: {
      cacheVersion: "test-protocol",
      panelEntryProtocolFingerprint: "b".repeat(64),
    },
    appDependencyFingerprint: "c".repeat(64),
  };
  await fs.writeFile(
    path.join(context.resources, "userland-builds/release.json"),
    JSON.stringify({
      builds: records,
      ...installation,
      platform: process.platform,
      arch: process.arch,
    })
  );
  for (const record of records) {
    const directory = path.join(context.resources, "userland-builds", record.buildKey);
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "metadata.json"),
      JSON.stringify({ execution: { artifactDigest: "d".repeat(64) } })
    );
  }
  // This boundary receives an already-proven compiled-runner artifact, never
  // interprets its schema contract or invokes another probe implementation.
  const component = {
    format: "vibestudio-installed-schema-evidence/1",
    installation,
    platform: process.platform,
    arch: process.arch,
    inventory: [],
    receipts: [],
  };
  let retire;
  const retirement = new Promise((resolve) => {
    retire = resolve;
  });
  let admitted;
  const stageReady = new Promise((resolve) => {
    admitted = resolve;
  });
  const cli = async (args) => (args[1] === "create-workspace" ? { name: "base-workspace" } : {});
  let pendingProof;
  const runBuildBatch = async (sources, evidence) => {
    if (evidence) {
      pendingProof = evidence.stagingPath;
      await fs.writeFile(evidence.stagingPath, JSON.stringify(component), {
        flag: "wx",
        mode: 0o600,
      });
    }
    return {
      outcomes: sources.map((source) => ({
        status: "fulfilled",
        source,
        buildKey: records.find((record) => record.source === source).buildKey,
      })),
      schemaEvidenceStaging: evidence?.stagingPath,
    };
  };
  const publication = verifyAndPublishSchemaEvidence(async (operation) => {
    await operation({
      ...context,
      cli,
      runBuildBatch,
    });
    admitted();
    await retirement;
  });
  await stageReady;
  if (process.platform !== "win32") assert.equal((await fs.stat(pendingProof)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(schemaProbeComponentPath(context.resources)), { code: "ENOENT" });
  retire();
  await publication;
  const published = JSON.parse(
    await fs.readFile(schemaProbeComponentPath(context.resources), "utf8")
  );
  assert.deepEqual(published, component);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(schemaProbeComponentPath(context.resources))).mode & 0o777, 0o644);
  assert.deepEqual(
    (await fs.readdir(context.resources)).filter((name) => name.includes(".tmp.")),
    []
  );
});

test("failed verifier serving retirement leaves no schema component or staged proof", async () => {
  const root = await fixture();
  const records = verificationRecords();
  const context = await verificationFixture(root, records);
  const original = new Error("independent serving retirement failure");
  const cli = async (args) => (args[1] === "create-workspace" ? { name: "base-workspace" } : {});
  const runBuildBatch = async (sources, evidence) => {
    if (evidence)
      await fs.writeFile(
        evidence.stagingPath,
        JSON.stringify({ format: "owned-compiled-proof-fixture" }),
        { flag: "wx" }
      );
    return {
      outcomes: sources.map((source) => ({
        status: "fulfilled",
        source,
        buildKey: records.find((record) => record.source === source).buildKey,
      })),
      schemaEvidenceStaging: evidence?.stagingPath,
    };
  };
  await assert.rejects(
    verifyAndPublishSchemaEvidence(async (operation) => {
      await operation({ ...context, cli, runBuildBatch });
      throw original;
    }),
    (error) => error === original
  );
  await assert.rejects(fs.stat(schemaProbeComponentPath(context.resources)), { code: "ENOENT" });
  assert.deepEqual(
    (await fs.readdir(context.resources)).filter((name) => name.includes(".tmp.")),
    []
  );
});

test("immutable schema publisher admits identical bytes and retains divergence with staging cleanup failure", async () => {
  const root = await fixture();
  const original = schemaProbeStagingPath(root);
  await fs.writeFile(original, "sealed-public-component", { mode: 0o600 });
  await publishSchemaProbeComponent(original, root);
  await retireSchemaProbeStaging(original, root);
  const repeated = schemaProbeStagingPath(root);
  await fs.writeFile(repeated, "sealed-public-component", { mode: 0o600 });
  await publishSchemaProbeComponent(repeated, root);
  await retireSchemaProbeStaging(repeated, root);
  const conflicting = schemaProbeStagingPath(root);
  await fs.writeFile(conflicting, "changed-component", { mode: 0o600 });
  const cleanupFailure = new Error("owned schema staging retirement failed");
  const rm = fs.rm;
  mock.method(fs, "rm", async (target, options) => {
    if (target === conflicting) throw cleanupFailure;
    return rm(target, options);
  });
  await assert.rejects(
    runWithOwnedCleanup(
      () => publishSchemaProbeComponent(conflicting, root),
      () => retireSchemaProbeStaging(conflicting, root),
      "Schema publication and retirement failed"
    ),
    (failure) => {
      assert.ok(failure instanceof AggregateError);
      assert.match(failure.errors[0].message, /immutable schema component cannot be changed/);
      assert.equal(failure.errors[0].cause.code, "EEXIST");
      assert.equal(failure.errors[1], cleanupFailure);
      return true;
    }
  );
  assert.equal(
    await fs.readFile(schemaProbeComponentPath(root), "utf8"),
    "sealed-public-component"
  );
});

test("schema publication preserves the original filesystem failure", async () => {
  const root = await fixture();
  const staging = schemaProbeStagingPath(root);
  await fs.writeFile(staging, "proof", { mode: 0o600 });
  const original = Object.assign(new Error("owned publication IO failed"), { code: "EIO" });
  mock.method(fs, "link", async () => {
    throw original;
  });
  await assert.rejects(
    publishSchemaProbeComponent(staging, root),
    (failure) => failure === original
  );
  await retireSchemaProbeStaging(staging, root);
  await assert.rejects(fs.stat(schemaProbeComponentPath(root)), { code: "ENOENT" });
});
afterEach(async () => {
  mock.restoreAll();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function releaseBuildFixture(
  root,
  key = "a".repeat(64),
  bytes = Buffer.from("export default {};")
) {
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "bundle.js"), bytes);
  await fs.writeFile(path.join(source, "metadata.json"), JSON.stringify({ buildKey: key }));
  await fs.writeFile(
    path.join(source, "artifacts.json"),
    JSON.stringify([
      {
        path: "bundle.js",
        byteLength: bytes.length,
        integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
      },
    ])
  );
  return { source, key, bytes };
}

async function verificationFixture(root, records) {
  const resources = path.join(root, "resources");
  const instanceRoot = path.join(root, "instance");
  await fs.mkdir(path.join(resources, "userland-builds"), { recursive: true });
  await fs.writeFile(
    path.join(resources, "userland-builds/release.json"),
    JSON.stringify({ builds: records })
  );
  for (const kind of ["base", "system", "personal"]) {
    const workspaceName = `${kind}-workspace`;
    for (const record of records.filter((candidate) => candidate.workspace === kind)) {
      const directory = path.join(
        instanceRoot,
        "workspaces",
        workspaceName,
        "state",
        "builds",
        record.buildKey
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "metadata.json"),
        JSON.stringify({ builtAt: record.builtAt })
      );
    }
  }
  return {
    resources,
    env: { VIBESTUDIO_INSTANCE_ROOT: instanceRoot },
    pair: {
      system: { name: "system-workspace" },
      personal: { name: "personal-workspace" },
    },
  };
}

function verificationRecords(baseCount = 1) {
  return [
    ...Array.from({ length: baseCount }, (_, index) => ({
      workspace: "base",
      source: `base/source-${index}`,
      buildKey: (index + 1).toString(16).padStart(64, "0"),
      builtAt: `base-${index}`,
    })),
    { workspace: "system", source: "system/source", buildKey: "b".repeat(64), builtAt: "system" },
    {
      workspace: "personal",
      source: "personal/source",
      buildKey: "c".repeat(64),
      builtAt: "personal",
    },
  ];
}

test("ready admission propagates the original process failure without a deadline", async () => {
  const root = await fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const error = new Error("native runtime failed to spawn");
  const ready = awaitHubReady(child, path.join(root, "ready.json"));
  const assertion = assert.rejects(ready, (failure) => failure === error);
  child.emit("error", error);
  await assertion;
  assert.equal(child.listenerCount("exit"), 0);
});

test("joins each selected-workspace batch before changing the shared CLI route", async () => {
  const root = await fixture();
  const records = verificationRecords(7);
  const context = await verificationFixture(root, records);
  const selected = [];
  let resolveBatch;
  let batchStarted;
  const started = new Promise((resolve) => (batchStarted = resolve));
  const pendingBatch = new Promise((resolve) => (resolveBatch = resolve));
  const cli = async (args) => {
    if (args[0] === "remote" && args[1] === "create-workspace") return { name: "base-workspace" };
    if (args[0] === "remote" && args[1] === "select") {
      selected.push(args[2]);
      return {};
    }
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  };
  let firstBatch = true;
  const runBuildBatch = async (sources) => {
    if (firstBatch) {
      firstBatch = false;
      batchStarted(sources);
      await pendingBatch;
    }
    return {
      outcomes: sources.map((source) => ({
        status: "fulfilled",
        source,
        buildKey: records.find((record) => record.source === source).buildKey,
      })),
    };
  };
  const verification = verifyPreparedReleaseUserland({ ...context, cli, runBuildBatch });
  const baseSources = await started;
  assert.deepEqual(
    baseSources,
    records.filter((record) => record.workspace === "base").map((r) => r.source)
  );
  assert.deepEqual(selected, ["base-workspace"]);
  resolveBatch();
  await verification;
  assert.deepEqual(selected, ["base-workspace", "system-workspace", "personal-workspace"]);
});

test("joins all failures for a selected role and preserves their input order and identity", async () => {
  const root = await fixture();
  const records = verificationRecords(8);
  const context = await verificationFixture(root, records);
  const selected = [];
  const failures = records
    .filter((record) => record.workspace === "base")
    .map((record) => new Error(`failed ${record.source}`));
  const cli = async (args) => {
    if (args[0] === "remote" && args[1] === "create-workspace") return { name: "base-workspace" };
    if (args[0] === "remote" && args[1] === "select") {
      selected.push(args[2]);
      return {};
    }
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  };
  const runBuildBatch = async (sources) => ({
    outcomes: sources.map((source) => ({
      status: "rejected",
      source,
      failure: failures[sources.indexOf(source)],
    })),
  });
  const verification = verifyPreparedReleaseUserland({ ...context, cli, runBuildBatch });
  await assert.rejects(verification, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.deepEqual(selected, ["base-workspace"]);
});

test("still rejects changed build keys and rebuilt artifacts during release verification", async () => {
  const root = await fixture();
  const records = verificationRecords();
  const context = await verificationFixture(root, records);
  const base = records[0];
  const cli = async (args) => {
    if (args[0] === "remote" && args[1] === "create-workspace") return { name: "base-workspace" };
    if (args[0] === "remote" && args[1] === "select") return {};
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  };
  const runBuildBatch = async (sources) => ({
    outcomes: sources.map((source) => ({
      status: "fulfilled",
      source,
      buildKey: "d".repeat(64),
    })),
  });
  await assert.rejects(
    verifyPreparedReleaseUserland({ ...context, cli, runBuildBatch }),
    new RegExp(`Release build identity changed for base:${base.source}`)
  );

  const matchingCli = async (args) => {
    if (args[0] === "remote" && args[1] === "create-workspace") return { name: "base-workspace" };
    if (args[0] === "remote" && args[1] === "select") return {};
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  };
  const matchingBuildBatch = async (sources) => ({
    outcomes: sources.map((source) => ({ status: "fulfilled", source, buildKey: base.buildKey })),
  });
  const metadataPath = path.join(
    context.env.VIBESTUDIO_INSTANCE_ROOT,
    "workspaces",
    "base-workspace",
    "state",
    "builds",
    base.buildKey,
    "metadata.json"
  );
  await fs.writeFile(metadataPath, JSON.stringify({ builtAt: "newer" }));
  await assert.rejects(
    verifyPreparedReleaseUserland({
      ...context,
      cli: matchingCli,
      runBuildBatch: matchingBuildBatch,
    }),
    /Fresh installation rebuilt base:base\/source-0 instead of reusing its release artifact/
  );
});

test("ready admission preserves the exact explicit cancellation reason", async () => {
  const root = await fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const controller = new AbortController();
  const reason = new Error("release startup cancelled by its owner");
  const ready = awaitHubReady(child, path.join(root, "ready.json"), controller.signal);
  const assertion = assert.rejects(ready, (failure) => failure === reason);
  controller.abort(reason);
  await assertion;
  assert.equal(child.listenerCount("exit"), 0);
});

test("a terminal server exit settles readiness even when no ready file was published", async () => {
  const root = await fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const ready = awaitHubReady(child, path.join(root, "ready.json"));
  const assertion = assert.rejects(ready, /exited \(1\)/);
  child.emit("exit", 1, null);
  await assertion;
});

test("joins an IPC-owned process and its streams after explicit owner revocation", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("disconnect", () => process.exit(0)); process.send("ready");'],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  const joined = joinChildProcess(child);
  child.stdout.resume();
  child.stderr.resume();
  await new Promise((resolve) => child.once("message", resolve));
  child.disconnect();
  assert.deepEqual(await joined, { code: 0, signal: null, error: undefined });
  assert.equal(child.stdout.closed, true);
  assert.equal(child.stderr.closed, true);
  assert.equal(child.connected, false);
});

test("joins a failed spawn without requiring an exit event for a nonexistent process", async () => {
  const root = await fixture();
  const child = spawn(path.join(root, "missing-executable"), [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const joined = joinChildProcess(child);
  child.stdout.resume();
  child.stderr.resume();
  const result = await joined;
  assert.equal(result.error.code, "ENOENT");
});

test("installed session joins its server and listeners after operation and shutdown failures", async () => {
  const root = await fixture();
  const appRoot = path.join(root, "app");
  const profileDir = path.join(root, "profile");
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  const serverEntry = path.join(appRoot, "dist/server.mjs");
  const cliEntry = path.join(appRoot, "dist/cli/client.mjs");
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  await fs.mkdir(path.dirname(cliEntry), { recursive: true });
  const serverId = `srv_${"s".repeat(24)}`;
  const serverBootId = `boot_${"b".repeat(24)}`;
  const pairing = {
    endpointId: "1".repeat(64),
    relays: DEFAULT_IROH_RELAYS,
    v: PAIRING_PROTOCOL_VERSION,
    code: Buffer.alloc(16, 7).toString("base64url"),
  };
  const ready = {
    mode: "hub",
    gatewayUrl: "https://example.test",
    rootInvite: {
      code: pairing.code,
      reach: {
        status: "ready",
        endpointId: pairing.endpointId,
        relays: pairing.relays,
        v: pairing.v,
        deepLink: createConnectDeepLink(pairing),
        pairUrl: createConnectPairUrl(pairing),
      },
      expiresInMs: 60_000,
      expiresAt: 60_000,
      serverId,
      serverBootId,
    },
    serverId,
    serverBootId,
    gatewayPort: 1234,
    pid: process.pid,
    version: "test",
    buildId: "a".repeat(64),
    workspaces: [],
  };
  await fs.writeFile(
    serverEntry,
    `import fs from "node:fs";
     const readyArg = process.argv.indexOf("--ready-file");
     fs.writeFileSync(process.argv[readyArg + 1], ${JSON.stringify(JSON.stringify(ready))});
     process.on("SIGTERM", () => process.exit(7));
     setInterval(() => {}, 1000);`
  );
  await fs.writeFile(cliEntry, "console.log(JSON.stringify({ system: {}, base: {} }));");

  const operationFailure = new Error("release verification callback failed");
  const baselineSigint = process.listenerCount("SIGINT");
  const baselineSigterm = process.listenerCount("SIGTERM");
  await assert.rejects(
    withStandaloneReleaseSession(appRoot, process.execPath, ownership, async () => {
      throw operationFailure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], error.cause);
      assert.equal(error.cause.cause, operationFailure);
      assert.match(error.errors[1].message, /server exited \(7\)/u);
      return true;
    }
  );
  assert.equal(process.listenerCount("SIGINT"), baselineSigint);
  assert.equal(process.listenerCount("SIGTERM"), baselineSigterm);
  await ownership.release();
  assert.deepEqual(await fs.readdir(scratchDirOf(profileDir)), []);
});

test("installed verification keeps fresh state isolated while carrying the build budget", async () => {
  const root = await fixture();
  const appRoot = path.join(root, "app");
  const profileDir = path.join(root, "profile");
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  const serverEntry = path.join(appRoot, "dist/server.mjs");
  const cliEntry = path.join(appRoot, "dist/cli/client.mjs");
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  await fs.mkdir(path.dirname(cliEntry), { recursive: true });
  const pairing = {
    endpointId: "1".repeat(64),
    relays: DEFAULT_IROH_RELAYS,
    v: PAIRING_PROTOCOL_VERSION,
    code: Buffer.alloc(16, 7).toString("base64url"),
  };
  const ready = {
    mode: "hub",
    gatewayUrl: "https://example.test",
    rootInvite: {
      code: pairing.code,
      reach: {
        status: "ready",
        endpointId: pairing.endpointId,
        relays: pairing.relays,
        v: pairing.v,
        deepLink: createConnectDeepLink(pairing),
        pairUrl: createConnectPairUrl(pairing),
      },
      expiresInMs: 60_000,
      expiresAt: 60_000,
      serverId: `srv_${"s".repeat(24)}`,
      serverBootId: `boot_${"b".repeat(24)}`,
    },
    serverId: `srv_${"s".repeat(24)}`,
    serverBootId: `boot_${"b".repeat(24)}`,
    gatewayPort: 1234,
    pid: process.pid,
    version: "test",
    buildId: "a".repeat(64),
    workspaces: [],
  };
  await fs.writeFile(
    serverEntry,
    `import fs from "node:fs";
     const readyArg = process.argv.indexOf("--ready-file");
     fs.writeFileSync(process.argv[readyArg + 1], ${JSON.stringify(JSON.stringify(ready))});
     fs.writeFileSync(process.env.VIBESTUDIO_INSTANCE_ROOT + "/build-concurrency", process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS ?? "missing");
     fs.writeFileSync(process.env.VIBESTUDIO_INSTANCE_ROOT + "/consumer-environment", JSON.stringify({ derived: process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR, profile: process.env.VIBESTUDIO_PROFILE_ROOT ?? null, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME }));
     process.on("SIGTERM", () => process.exit(0));
     setInterval(() => {}, 1000);`
  );
  await fs.writeFile(
    cliEntry,
    `console.log(JSON.stringify({ concurrency: process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS ?? "missing", derived: process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR, profile: process.env.VIBESTUDIO_PROFILE_ROOT ?? null, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME }));`
  );

  const priorConcurrency = process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS;
  const priorDerived = process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
  const priorProfile = process.env.VIBESTUDIO_PROFILE_ROOT;
  process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS = "6";
  process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR = path.join(root, "inherited-cache");
  process.env.VIBESTUDIO_PROFILE_ROOT = path.join(root, "inherited-profile");
  try {
    await withStandaloneReleaseSession(
      appRoot,
      process.execPath,
      ownership,
      async ({ cli, env }) => {
        assert.equal(env.VIBESTUDIO_MAX_CONCURRENT_BUILDS, "6");
        assert.equal(
          env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR,
          path.join(path.dirname(env.VIBESTUDIO_INSTANCE_ROOT), "derived")
        );
        assert.notEqual(
          env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR,
          process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR
        );
        assert.equal(env.HOME, path.join(path.dirname(env.VIBESTUDIO_INSTANCE_ROOT), "home"));
        assert.deepEqual(await fs.readdir(env.VIBESTUDIO_INSTANCE_ROOT), [
          "build-concurrency",
          "consumer-environment",
        ]);
        assert.equal(
          await fs.stat(env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR).then(
            () => true,
            (error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            }
          ),
          false
        );
        assert.equal(
          await fs.readFile(path.join(env.VIBESTUDIO_INSTANCE_ROOT, "build-concurrency"), "utf8"),
          "6"
        );
        const expectedEnvironment = {
          derived: env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR,
          profile: null,
          home: env.HOME,
          config: env.XDG_CONFIG_HOME,
        };
        assert.deepEqual(
          JSON.parse(
            await fs.readFile(
              path.join(env.VIBESTUDIO_INSTANCE_ROOT, "consumer-environment"),
              "utf8"
            )
          ),
          expectedEnvironment
        );
        assert.deepEqual(await cli(["environment"]), { concurrency: "6", ...expectedEnvironment });
      }
    );
  } finally {
    if (priorConcurrency === undefined) delete process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS;
    else process.env.VIBESTUDIO_MAX_CONCURRENT_BUILDS = priorConcurrency;
    if (priorDerived === undefined) delete process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
    else process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR = priorDerived;
    if (priorProfile === undefined) delete process.env.VIBESTUDIO_PROFILE_ROOT;
    else process.env.VIBESTUDIO_PROFILE_ROOT = priorProfile;
  }
  await ownership.release();
  assert.deepEqual(await fs.readdir(scratchDirOf(profileDir)), []);
});

test("release-session cancellation aborts and joins an admitted CLI call before server shutdown", async () => {
  const root = await fixture();
  const appRoot = path.join(root, "app");
  const profileDir = path.join(root, "profile");
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  const serverEntry = path.join(appRoot, "dist/server.mjs");
  const cliEntry = path.join(appRoot, "dist/cli/client.mjs");
  await fs.mkdir(path.dirname(serverEntry), { recursive: true });
  await fs.mkdir(path.dirname(cliEntry), { recursive: true });
  const pairing = {
    endpointId: "1".repeat(64),
    relays: DEFAULT_IROH_RELAYS,
    v: PAIRING_PROTOCOL_VERSION,
    code: Buffer.alloc(16, 7).toString("base64url"),
  };
  const serverId = `srv_${"s".repeat(24)}`;
  const serverBootId = `boot_${"b".repeat(24)}`;
  const ready = {
    mode: "hub",
    gatewayUrl: "https://example.test",
    rootInvite: {
      code: pairing.code,
      reach: {
        status: "ready",
        endpointId: pairing.endpointId,
        relays: pairing.relays,
        v: pairing.v,
        deepLink: createConnectDeepLink(pairing),
        pairUrl: createConnectPairUrl(pairing),
      },
      expiresInMs: 60_000,
      expiresAt: 60_000,
      serverId,
      serverBootId,
    },
    serverId,
    serverBootId,
    gatewayPort: 1234,
    pid: process.pid,
    version: "test",
    buildId: "a".repeat(64),
    workspaces: [],
  };
  await fs.writeFile(
    serverEntry,
    `import fs from "node:fs";
     const readyArg = process.argv.indexOf("--ready-file");
     fs.writeFileSync(process.argv[readyArg + 1], ${JSON.stringify(JSON.stringify(ready))});
     process.on("SIGTERM", () => process.exit(0));
     setInterval(() => {}, 1000);`
  );
  const running = path.join(root, "cli-running");
  const retired = path.join(root, "cli-retired");
  await fs.writeFile(
    cliEntry,
    `import fs from "node:fs";
     if (process.argv.includes("wait")) {
       fs.writeFileSync(${JSON.stringify(running)}, "running");
       process.on("SIGTERM", () => {
         fs.writeFileSync(${JSON.stringify(retired)}, "joined");
         process.exit(0);
       });
       setInterval(() => {}, 1000);
     } else console.log(JSON.stringify({}));`
  );

  const watcher = (await import("node:fs")).watch(root);
  const cliStarted = new Promise((resolve, reject) => {
    watcher.on("change", (_event, file) => {
      if (String(file) === path.basename(running)) resolve();
    });
    watcher.on("error", reject);
  });
  try {
    const session = withStandaloneReleaseSession(
      appRoot,
      process.execPath,
      ownership,
      async ({ cli }) => cli(["wait"])
    );
    const cancelled = assert.rejects(session, (error) => {
      assert.match(error.cause?.message ?? error.message, /cancelled by SIGTERM/u);
      return true;
    });
    await cliStarted;
    process.emit("SIGTERM");
    await cancelled;
    assert.equal(await fs.readFile(retired, "utf8"), "joined");
    await ownership.release();
    assert.deepEqual(await fs.readdir(scratchDirOf(profileDir)), []);
  } finally {
    watcher.close();
  }
});

test("exports only immutable records and verifies every payload before publication", async () => {
  const root = await fixture();
  const source = path.join(root, "source"),
    destination = path.join(root, "release");
  const { key } = await releaseBuildFixture(root);
  await fs.writeFile(path.join(source, "grants.db"), "private mutable authority");
  await fs.writeFile(path.join(source, "metadata.json.tmp.writer"), "incomplete");
  await Promise.all([
    exportReleaseBuild(source, destination, key),
    exportReleaseBuild(source, destination, key),
  ]);
  assert.deepEqual((await fs.readdir(destination)).sort(), [
    "artifacts.json",
    "bundle.js",
    "metadata.json",
  ]);
  const publishedBytes = await fs.readFile(path.join(destination, "bundle.js"), "utf8");
  const repeated = Buffer.from("// another source path\nexport default {};");
  await fs.writeFile(path.join(source, "bundle.js"), repeated);
  await fs.writeFile(
    path.join(source, "artifacts.json"),
    JSON.stringify([
      {
        path: "bundle.js",
        byteLength: repeated.length,
        integrity: `sha256-${createHash("sha256").update(repeated).digest("hex")}`,
      },
    ])
  );
  await exportReleaseBuild(source, destination, key);
  assert.equal(await fs.readFile(path.join(destination, "bundle.js"), "utf8"), publishedBytes);
  await fs.writeFile(path.join(source, "bundle.js"), "corrupt");
  await assert.rejects(
    exportReleaseBuild(source, path.join(root, "corrupt"), key),
    /integrity mismatch/
  );
  await assert.rejects(fs.stat(path.join(root, "corrupt")), { code: "ENOENT" });
  assert.equal(
    (await fs.readdir(root)).some((name) => name.includes(".publishing-")),
    false
  );
  await assert.rejects(
    exportReleaseBuild(source, path.join(root, "other"), "b".repeat(64)),
    /key mismatch/
  );
});

test("accepts a Windows EPERM rename collision only after verifying the incumbent", async () => {
  const root = await fixture();
  const { source, key } = await releaseBuildFixture(root);
  const destination = path.join(root, "release");
  const realRename = fs.rename.bind(fs);
  const renameError = Object.assign(new Error("destination already exists"), { code: "EPERM" });
  mock.method(fs, "rename", async (from, to) => {
    await realRename(from, to);
    throw renameError;
  });

  await exportReleaseBuild(source, destination, key);
  assert.equal(
    await fs.readFile(path.join(destination, "bundle.js"), "utf8"),
    "export default {};"
  );
  assert.equal(
    (await fs.readdir(root)).some((name) => name.includes(".publishing-")),
    false
  );
});

test("preserves a genuine EPERM when no release destination was published", async () => {
  const root = await fixture();
  const { source, key } = await releaseBuildFixture(root);
  const destination = path.join(root, "release");
  const renameError = Object.assign(new Error("rename denied"), { code: "EPERM" });
  mock.method(fs, "rename", async () => {
    throw renameError;
  });

  await assert.rejects(
    exportReleaseBuild(source, destination, key),
    (error) => error === renameError
  );
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  assert.equal(
    (await fs.readdir(root)).some((name) => name.includes(".publishing-")),
    false
  );
});

test("retains rename and incumbent verification failures for an invalid publication race", async () => {
  const root = await fixture();
  const { source, key } = await releaseBuildFixture(root);
  const destination = path.join(root, "release");
  const renameError = Object.assign(new Error("destination collision"), { code: "EPERM" });
  mock.method(fs, "rename", async () => {
    await fs.mkdir(destination);
    await fs.writeFile(
      path.join(destination, "metadata.json"),
      JSON.stringify({ buildKey: "wrong" })
    );
    throw renameError;
  });

  await assert.rejects(exportReleaseBuild(source, destination, key), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, renameError);
    assert.equal(error.errors[0], renameError);
    assert.match(error.errors[1].message, /key mismatch/);
    return true;
  });
  assert.equal(
    (await fs.readdir(root)).some((name) => name.includes(".publishing-")),
    false
  );
});

test("keeps a staging cleanup failure together with the publication error", async () => {
  const root = await fixture();
  const { source, key } = await releaseBuildFixture(root);
  const renameError = Object.assign(new Error("rename denied"), { code: "EPERM" });
  const cleanupError = new Error("staging cleanup failed");
  mock.method(fs, "rename", async () => {
    throw renameError;
  });
  mock.method(fs, "rm", async () => {
    throw cleanupError;
  });

  await assert.rejects(exportReleaseBuild(source, path.join(root, "release"), key), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, renameError);
    assert.equal(error.errors[0], renameError);
    assert.equal(error.errors[1], cleanupError);
    return true;
  });
});

test("rejects artifact paths that would escape the release record", async () => {
  const root = await fixture(),
    key = "c".repeat(64);
  await fs.writeFile(path.join(root, "metadata.json"), JSON.stringify({ buildKey: key }));
  await fs.writeFile(path.join(root, "artifacts.json"), JSON.stringify([{ path: "../outside" }]));
  await assert.rejects(
    exportReleaseBuild(root, path.join(root, "release"), key),
    /Invalid release artifact path/
  );
});

test("template preparation joins cancellation before retiring private scratch", async () => {
  const root = await fixture();
  const entry = path.join(root, "preparer.mjs");
  const ready = path.join(root, "ready");
  const receipt = path.join(root, "retired");
  await fs.writeFile(
    entry,
    `import fs from "node:fs";
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(receipt)}, "joined"); process.exit(0); });
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);`
  );
  const watcher = (await import("node:fs")).watch(root);
  const started = new Promise((resolve, reject) => {
    watcher.on("change", (_event, file) => {
      if (String(file) === "ready") resolve();
    });
    watcher.on("error", reject);
  });
  try {
    const stopRequest = new AbortController();
    const prepared = prepareInstalledTemplateRelease({
      appRoot: root,
      resources: root,
      executable: process.execPath,
      entry,
      scratchParent: root,
      signal: stopRequest.signal,
    });
    const cancelled = assert.rejects(prepared, /preparation cancelled/);
    await started;
    stopRequest.abort(new Error("stop requested"));
    await cancelled;
    assert.equal(await fs.readFile(receipt, "utf8"), "joined");
    assert.equal(
      (await fs.readdir(root)).some((name) => name.startsWith(".template-release-")),
      false
    );
  } finally {
    watcher.close();
  }
});

test("installed producer ignores an inherited borrowed release root", async () => {
  const root = await fixture();
  const entry = path.join(root, "producer.mjs");
  const inheritedRoot = path.join(root, "missing-borrowed-release");
  await fs.writeFile(
    entry,
    `const root = process.argv[process.argv.indexOf("--output") + 1];
    process.send({ kind: "sources-ready", root }, () =>
      process.send({ kind: "completed" }, () => process.exit(0)));`
  );
  const previous = process.env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT;
  process.env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT = inheritedRoot;
  try {
    await prepareInstalledTemplateRelease({
      appRoot: root,
      resources: root,
      executable: process.execPath,
      entry,
      scratchParent: root,
    });
    assert.equal(process.env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT, inheritedRoot);
  } finally {
    if (previous === undefined) delete process.env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT;
    else process.env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT = previous;
  }
});

for (const configured of [true, false])
  test(`installed producer preserves ${configured ? "configured" : "profile-default"} cache selection and retires workspace state`, async () => {
    const root = await fixture();
    const entry = path.join(root, "producer.mjs");
    const receipt = path.join(root, "producer-environment.json");
    const shared = path.join(root, "shared-cache");
    await fs.mkdir(shared);
    await fs.writeFile(path.join(shared, "retained-content"), "cached content");
    await fs.writeFile(
      entry,
      `import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
      derived: process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR,
      profile: process.env.VIBESTUDIO_PROFILE_ROOT,
      instance: process.env.VIBESTUDIO_INSTANCE_ROOT,
      tmp: process.env.TMPDIR
    }));
    const root = process.argv[process.argv.indexOf("--output") + 1];
    process.send({ kind: "sources-ready", root }, () =>
      process.send({ kind: "completed" }, () => process.exit(0)));`
    );
    const prior = process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
    const priorProfile = process.env.VIBESTUDIO_PROFILE_ROOT;
    const profile = path.join(root, "producer-profile");
    process.env.VIBESTUDIO_PROFILE_ROOT = profile;
    if (configured) process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR = shared;
    else delete process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
    try {
      await prepareInstalledTemplateRelease({
        appRoot: root,
        resources: root,
        executable: process.execPath,
        entry,
        scratchParent: root,
      });
      const env = JSON.parse(await fs.readFile(receipt, "utf8"));
      assert.equal(env.derived, configured ? shared : undefined);
      assert.equal(env.profile, profile);
      assert.equal(
        path.basename(path.dirname(env.instance)).startsWith(".template-release-"),
        true
      );
      assert.equal(path.dirname(env.tmp), path.dirname(env.instance));
      await assert.rejects(fs.stat(path.dirname(env.instance)), { code: "ENOENT" });
      assert.equal(
        await fs.readFile(path.join(shared, "retained-content"), "utf8"),
        "cached content"
      );
    } finally {
      if (prior === undefined) delete process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
      else process.env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR = prior;
      if (priorProfile === undefined) delete process.env.VIBESTUDIO_PROFILE_ROOT;
      else process.env.VIBESTUDIO_PROFILE_ROOT = priorProfile;
    }
  });

test("release RPC cancellation reaches and joins the owned verifier process", async () => {
  const root = await fixture();
  const runner = path.join(root, "runner.mjs");
  const ready = path.join(root, "runner-ready");
  const retired = path.join(root, "runner-retired");
  await fs.writeFile(
    runner,
    `import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    process.on("message", (message) => {
      if (message?.type !== "cancel") return;
      fs.writeFileSync(${JSON.stringify(retired)}, "joined");
      process.stdout.write("VIBESTUDIO_RELEASE_RPC_RESULT:" + JSON.stringify({ fatal: message.failure }) + "\\n");
      setImmediate(() => process.exit(0));
    });
    setInterval(() => {}, 1000);`
  );
  const watcher = (await import("node:fs")).watch(root);
  const becameReady = new Promise((resolve) => {
    watcher.on("change", (_event, file) => {
      if (String(file) === "runner-ready") resolve();
    });
  });
  const controller = new AbortController();
  const cancellation = new Error("release server exited while verifier was running");
  let closeOwnership;
  try {
    const ownership = await Ownership.open({
      profileDir: path.join(root, "profile"),
      lifetime: "leased",
    });
    closeOwnership = ownership;
    const batch = runInstalledRpcBatch({
      ownership,
      executable: process.execPath,
      runnerEntry: runner,
      cliEntry: path.join(root, "client.mjs"),
      sources: ["base/a"],
      env: process.env,
      scratch: root,
      signal: controller.signal,
    });
    await becameReady;
    controller.abort(cancellation);
    await assert.rejects(batch, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, cancellation);
      assert.equal(error.errors[0], cancellation);
      return true;
    });
    assert.equal(await fs.readFile(retired, "utf8"), "joined");
  } finally {
    watcher.close();
    await closeOwnership?.release();
  }
});

async function failingTemplatePreparer(root, failure) {
  const entry = path.join(root, "preparer.mjs");
  await fs.writeFile(
    entry,
    `process.send({ kind: "failed", failure: ${JSON.stringify(failure)} }, () => process.exit(1));`
  );
  return {
    appRoot: root,
    resources: root,
    executable: process.execPath,
    entry,
    scratchParent: root,
  };
}

test("a joined template build failure still retires its private scratch", async () => {
  const root = await fixture();
  const input = await failingTemplatePreparer(root, {
    message: "template compilation failed",
    errorKind: "application",
    code: "EBUILD",
  });
  await assert.rejects(prepareInstalledTemplateRelease(input), { code: "EBUILD" });
  assert.equal(
    (await fs.readdir(root)).some((name) => name.startsWith(".template-release-")),
    false
  );
});

test("template build and scratch retirement failures retain both causes", async () => {
  const root = await fixture();
  const input = await failingTemplatePreparer(root, {
    message: "template compilation failed",
    errorKind: "application",
    code: "EBUILD",
  });
  const cleanupFailure = Object.assign(new Error("scratch removal denied"), { code: "EACCES" });
  const remove = fs.rm.bind(fs);
  mock.method(fs, "rm", async (target, options) => {
    if (path.basename(String(target)).startsWith(".template-release-")) throw cleanupFailure;
    return remove(target, options);
  });
  await assert.rejects(prepareInstalledTemplateRelease(input), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, "EBUILD");
    assert.equal(error.errors[1], cleanupFailure);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
});

test("nested template ownership failures retain the state anchor", async () => {
  const root = await fixture();
  const input = await failingTemplatePreparer(root, {
    message: "template compilation and runtime retirement failed",
    errorKind: "application",
    name: "AggregateError",
    errors: [
      { message: "template compilation failed", errorKind: "application", code: "EBUILD" },
      { message: "runtime ownership uncertain", errorKind: "internal", code: "EOWNERSHIP" },
    ],
  });
  await assert.rejects(prepareInstalledTemplateRelease(input), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((child) => child.code),
      ["EBUILD", "EOWNERSHIP"]
    );
    return true;
  });
  const retained = (await fs.readdir(root)).filter((name) => name.startsWith(".template-release-"));
  assert.equal(retained.length, 1);
  assert.equal((await fs.stat(path.join(root, retained[0], "tmp"))).isDirectory(), true);
});
