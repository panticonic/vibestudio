import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupTerminalSmoke, installedSmokeTarget, observe } from "./terminal-app-smoke.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-terminal-smoke-test-"));
  roots.push(root);
  const resources = path.join(root, "resources");
  const pins = Object.fromEntries(
    ["base", "personal", "system"].map((role) => [
      role,
      {
        url: `git+https://github.com/panticonic/vibestudio-${role}.git`,
        ref: "refs/tags/v0.1.0",
        commit: "a".repeat(40),
      },
    ])
  );
  const release = { format: "vibestudio-template-release/1", workspaceTemplates: pins };
  const manifest = {
    format: "vibestudio-workspace-runtime-release/3",
    version: 3,
    platform: process.platform,
    arch: process.arch,
    appDependencyFingerprint: "b".repeat(64),
    hostBuild: { version: 1, mode: "production", fingerprint: "c".repeat(64), inputCount: 1 },
    compilerProtocol: { cacheVersion: "test", panelEntryProtocolFingerprint: "d".repeat(64) },
    templates: pins,
    layers: Object.fromEntries(Object.entries(pins).map(([role, pin]) => [role, [pin]])),
    preparedTemplates: Object.keys(pins).map((workspace) => ({
      workspace,
      recordDigest: "e".repeat(64),
    })),
    builds: [],
  };
  const write = (relative, value) => {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === "string" ? value : JSON.stringify(value));
  };
  write("expected.json", release);
  write("resources/workspace-template-release.json", release);
  write("resources/userland-builds/release.json", manifest);
  for (const file of [
    "vibestudio",
    "resources/app.asar",
    "resources/app.asar.unpacked/dist/prepare-workspace-templates.cjs",
    "resources/app.asar.unpacked/dist/cli/client.mjs",
  ])
    write(file, "fixture");
  return {
    root,
    resources,
    pins,
    manifest,
    write,
    resolve: () => installedSmokeTarget(root, path.join(root, "expected.json")),
  };
}

test("selects the installed artifact, never the checkout's host generation", () => {
  const f = fixture();
  assert.equal(f.resolve().hostArtifactRoot, path.join(f.resources, "app.asar.unpacked/dist"));
});

test("rejects an old installation without a complete release before startup", () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.resources, "userland-builds/release.json"));
  assert.throws(f.resolve, /no complete prepared workspace release/);
});

test("rejects stale published pins and a mismatching sealed manifest", () => {
  const f = fixture();
  const changed = structuredClone(f.pins);
  changed.system.commit = "f".repeat(40);
  f.write("resources/workspace-template-release.json", {
    format: "vibestudio-template-release/1",
    workspaceTemplates: changed,
  });
  assert.throws(f.resolve, /system template commit does not match/);
  f.write("resources/workspace-template-release.json", {
    format: "vibestudio-template-release/1",
    workspaceTemplates: f.pins,
  });
  f.write("resources/userland-builds/release.json", { ...f.manifest, templates: changed });
  assert.throws(f.resolve, /system template commit does not match/);
});

test("rejects a prepared release for another platform", () => {
  const f = fixture();
  f.write("resources/userland-builds/release.json", { ...f.manifest, platform: "other" });
  assert.throws(f.resolve, /not /);
});

function terminal() {
  let data, exit;
  return {
    onData: (listener) => {
      data = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
    emit: (text) => data(text),
    finish: (code) => exit({ exitCode: code, signal: 0 }),
  };
}

test("observes readiness but rejects current and future waits on authoritative exit", async () => {
  const term = terminal();
  const screen = observe(term);
  const ready = screen.waitFor("ready");
  term.emit("ready");
  await ready;
  const pending = screen.waitFor("next");
  term.finish(2);
  await assert.rejects(pending, /code 2/);
  await assert.rejects(screen.waitFor("ready"), /code 2/);
  assert.deepEqual(await screen.exited, { exitCode: 2, signal: 0 });
});

test("retains bounded terminal failure evidence", () => {
  const term = terminal();
  const screen = observe(term);
  term.emit("x".repeat(300000));
  assert.equal(screen.raw.length, 262144);
});

test("removes scratch only after joining the terminal/server and release producer", async () => {
  const calls = [];
  const step = (name) => async () => {
    calls.push(name);
  };
  await cleanupTerminalSmoke({
    scratch: "/private/run",
    discoverServer: step("discover"),
    stopTerminal: step("terminal"),
    retainFailureEvidence: step("evidence"),
    verifyServerStopped: step("server"),
    stopPreparation: step("producer"),
    removeScratch: step("remove"),
  });
  assert.deepEqual(calls, ["discover", "terminal", "evidence", "server", "producer", "remove"]);
});

for (const failedStep of ["stopTerminal", "verifyServerStopped", "stopPreparation"]) {
  test(`retains scratch when ${failedStep} cannot settle ownership, preserving the original failure`, async () => {
    const calls = [];
    const original = Object.assign(new Error(`${failedStep} failed`), { code: "EOWNERSHIP" });
    const options = { scratch: "/private/run" };
    for (const step of [
      "discoverServer",
      "stopTerminal",
      "retainFailureEvidence",
      "verifyServerStopped",
      "stopPreparation",
      "removeScratch",
    ]) {
      options[step] = async () => {
        calls.push(step);
        if (step === failedStep) throw original;
      };
    }
    await assert.rejects(cleanupTerminalSmoke(options), (error) => {
      assert.ok(error.errors.includes(original));
      assert.ok(
        error.errors.some(
          (child) => child.code === "EOWNERSHIP" && child.message.includes("scratch retained")
        )
      );
      return true;
    });
    assert.ok(calls.includes("stopPreparation"));
    assert.ok(calls.includes("retainFailureEvidence"));
    assert.ok(!calls.includes("removeScratch"));
  });
}
