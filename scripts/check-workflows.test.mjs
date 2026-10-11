import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkflows } from "./check-workflows.mjs";
import {
  actionlintTarget,
  actionlintVersion,
  resolveActionlint,
  withOwnedTemporaryDirectory,
} from "./lib/actionlint.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-lint-"));
  const workflows = path.join(root, ".github", "workflows");
  await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(path.join(workflows, "ci.yml"), "name: CI\n");
  await fs.writeFile(
    path.join(workflows, "release.yaml"),
    "name: Release\non: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n"
  );
  await fs.writeFile(path.join(workflows, "notes.txt"), "ignored\n");
  return { root, workflows };
}

test("the workflow check invokes pinned actionlint on every workflow YAML file", async () => {
  const { root } = await fixture();
  try {
    let observed;
    const result = await checkWorkflows({
      root,
      resolve: async () => "/verified/actionlint",
      run: async (executable, args) => {
        observed = { executable, args };
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(result.workflowCount, 2);
    assert.equal(observed.executable, "/verified/actionlint");
    assert.deepEqual(observed.args, [
      "-color",
      "-shellcheck=",
      "-pyflakes=",
      path.join(root, ".github", "workflows", "ci.yml"),
      path.join(root, ".github", "workflows", "release.yaml"),
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow diagnostics and nonzero status remain failures", async () => {
  const { root } = await fixture();
  try {
    await assert.rejects(
      checkWorkflows({
        root,
        resolve: async () => "/verified/actionlint",
        run: async () => {
          const error = new Error("exit 1");
          error.code = 1;
          error.stdout = "ci.yml: env must be a mapping";
          error.stderr = "";
          throw error;
        },
      }),
      (error) =>
        error.message.includes("exit 1") && error.cause.stdout.includes("env must be a mapping")
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an install failure and temporary cleanup failure remain together", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "actionlint-owned-install-"));
  let ownedTemporary;
  const installFailure = new Error("archive extraction failed");
  const cleanupFailure = new Error("temporary cleanup failed");
  try {
    await assert.rejects(
      withOwnedTemporaryDirectory(
        parent,
        async (temporary) => {
          ownedTemporary = temporary;
          throw installFailure;
        },
        async () => {
          throw cleanupFailure;
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        error.cause === installFailure &&
        error.errors[0] === installFailure &&
        error.errors[1] === cleanupFailure
    );
  } finally {
    if (ownedTemporary) await fs.rm(ownedTemporary, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("the actionlint pin names official release assets for supported CI platforms", () => {
  assert.equal(actionlintVersion, "1.7.12");
  for (const [platform, arch, expected] of [
    ["linux", "x64", "actionlint_1.7.12_linux_amd64.tar.gz"],
    ["linux", "arm64", "actionlint_1.7.12_linux_arm64.tar.gz"],
    ["darwin", "x64", "actionlint_1.7.12_darwin_amd64.tar.gz"],
    ["darwin", "arm64", "actionlint_1.7.12_darwin_arm64.tar.gz"],
    ["win32", "x64", "actionlint_1.7.12_windows_amd64.zip"],
    ["win32", "arm64", "actionlint_1.7.12_windows_arm64.zip"],
  ]) {
    assert.equal(actionlintTarget(platform, arch).archive, expected);
    assert.match(actionlintTarget(platform, arch).sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => actionlintTarget("freebsd", "x64"), /unavailable/);
});

test("a modified cached executable is never accepted", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "actionlint-cache-tamper-"));
  try {
    const target = actionlintTarget("linux", "x64");
    const installRoot = path.join(cacheRoot, actionlintVersion, target.key);
    await fs.mkdir(installRoot, { recursive: true });
    const executable = path.join(installRoot, target.executable);
    const trustedBytes = Buffer.from("verified executable");
    await fs.writeFile(executable, "modified executable");
    await fs.writeFile(
      path.join(installRoot, "artifact.json"),
      JSON.stringify({
        version: actionlintVersion,
        target: target.key,
        archiveSha256: target.sha256,
        executableSha256: createHash("sha256").update(trustedBytes).digest("hex"),
      })
    );

    let downloadRequested = false;
    await assert.rejects(
      resolveActionlint({
        platform: "linux",
        arch: "x64",
        cacheRoot,
        fetchImpl: async () => {
          downloadRequested = true;
          throw new Error("offline fixture");
        },
      }),
      (error) =>
        error.message.includes("failed verification") &&
        error.cause.message.includes("does not match its verified receipt")
    );
    assert.equal(downloadRequested, false);
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test("an unverified release download cannot be published into the tool cache", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "actionlint-cache-download-"));
  try {
    await assert.rejects(
      resolveActionlint({
        platform: "linux",
        arch: "x64",
        cacheRoot,
        fetchImpl: async () => ({
          ok: true,
          arrayBuffer: async () => Buffer.from("wrong archive"),
        }),
      }),
      /checksum mismatch/
    );
    assert.deepEqual(await fs.readdir(cacheRoot), []);
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test("actionlint rejects runner context in a job-level environment", async () => {
  const { root, workflows } = await fixture();
  try {
    await fs.writeFile(
      path.join(workflows, "ci.yml"),
      [
        "name: Invalid context regression",
        "on: push",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      TEMP_DIR: ${{ runner.temp }}",
        "    steps:",
        "      - run: echo ok",
        "",
      ].join("\n")
    );
    await assert.rejects(checkWorkflows({ root, resolve: resolveActionlint }), (error) =>
      `${error.cause.stdout}\n${error.cause.stderr}`.includes(
        'context "runner" is not allowed here'
      )
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
