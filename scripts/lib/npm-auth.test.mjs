import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNpmAuth, npmTokenFilePath, readNpmAuthToken } from "./npm-auth.mjs";

test("saved token owns an isolated npm config, overrides stale login config, and retires it", () => {
  const directory = mkdtempSync(join(tmpdir(), "npm-auth-test-"));
  let auth;
  try {
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "NPM_TOKEN='saved_test_secret'\n", { mode: 0o644 });
    const env = {
      VIBESTUDIO_NPM_TOKEN_FILE: tokenFile,
      NPM_CONFIG_USERCONFIG: "stale-login-config",
      npm_config_userconfig: "other-stale-config",
      NPM_CONFIG_REGISTRY: "https://other-registry.invalid/",
    };
    auth = createNpmAuth({ env, required: true });
    const configured = auth.environment();
    assert.equal(auth.token.source, tokenFile);
    assert.equal(configured.NODE_AUTH_TOKEN, "saved_test_secret");
    assert.equal(configured.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
    assert.equal(configured.npm_config_registry, configured.NPM_CONFIG_REGISTRY);
    assert.equal(configured.NPM_CONFIG_USERCONFIG, configured.npm_config_userconfig);
    assert.notEqual(configured.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_USERCONFIG);
    assert.equal(auth.environment().NPM_CONFIG_USERCONFIG, configured.NPM_CONFIG_USERCONFIG);
    const contents = readFileSync(configured.NPM_CONFIG_USERCONFIG, "utf8");
    assert.match(contents, /_authToken=\$\{NODE_AUTH_TOKEN\}/);
    assert.doesNotMatch(contents, /saved_test_secret/);
    if (process.platform !== "win32") {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      assert.equal(statSync(configured.NPM_CONFIG_USERCONFIG).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(configured.NPM_CONFIG_USERCONFIG)).mode & 0o777, 0o700);
    }
    assert.equal(
      auth.redact("saved_test_secret twice saved_test_secret"),
      "[redacted] twice [redacted]"
    );
    auth.close();
    assert.equal(existsSync(dirname(configured.NPM_CONFIG_USERCONFIG)), false);
    assert.throws(() => auth.environment(), /closed/);
    auth.close();
  } finally {
    auth?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI overrides remain explicit while saved-only checks always read the configured file", () => {
  const directory = mkdtempSync(join(tmpdir(), "npm-auth-test-"));
  try {
    const file = join(directory, "token");
    writeFileSync(file, "saved_secret\n");
    const env = {
      VIBESTUDIO_NPM_TOKEN_FILE: file,
      NODE_AUTH_TOKEN: "ci_secret",
      NPM_TOKEN: "secondary_secret",
    };
    assert.equal(readNpmAuthToken({ env }).value, "ci_secret");
    assert.equal(readNpmAuthToken({ env, savedOnly: true }).value, "saved_secret");
    assert.equal(
      npmTokenFilePath({ XDG_CONFIG_HOME: directory }),
      join(directory, "vibestudio", "npm-publish-token")
    );
    writeFileSync(file, "bad secret\n");
    assert.throws(() => readNpmAuthToken({ env, savedOnly: true }), /invalid characters/);
    rmSync(file);
    assert.throws(
      () => createNpmAuth({ env: { VIBESTUDIO_NPM_TOKEN_FILE: file }, required: true }),
      /setup:npm-token/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical npm runner uses saved credentials, redacts failures, and joins config cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "npm-auth-runner-test-"));
  try {
    const file = join(directory, "token");
    const record = join(directory, "record");
    writeFileSync(file, "saved_runner_secret\n");
    const preload = join(directory, "npm.mjs");
    writeFileSync(
      preload,
      `import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
childProcess.spawnSync = (command, args, options) => {
  writeFileSync(process.env.AUTH_RECORD, JSON.stringify({ command, args, config: options.env.NPM_CONFIG_USERCONFIG, contents: readFileSync(options.env.NPM_CONFIG_USERCONFIG, 'utf8'), correctToken: options.env.NODE_AUTH_TOKEN === 'saved_runner_secret' }));
  return { status: 1, stdout: 'saved_runner_secret', stderr: 'saved_runner_secret' };
};
syncBuiltinESMExports();\n`
    );
    const env = { ...process.env, VIBESTUDIO_NPM_TOKEN_FILE: file, AUTH_RECORD: record };
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    const runner = fileURLToPath(new URL("../npm.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", preload, runner, "whoami"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /saved_runner_secret/);
    assert.match(result.stdout, /redacted/);
    const observed = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(observed.correctToken, true);
    assert.equal(observed.command, "npm");
    assert.deepEqual(observed.args, ["whoami"]);
    assert.doesNotMatch(observed.contents, /saved_runner_secret/);
    assert.equal(existsSync(dirname(observed.config)), false);

    // The production server publisher must resolve the same saved credential,
    // even when an old npm login exists, and retire it after whoami rejects it.
    const publisher = fileURLToPath(new URL("../publish-npm.mjs", import.meta.url));
    const rejected = spawnSync(process.execPath, ["--import", preload, publisher], {
      env: { ...env, NPM_CONFIG_USERCONFIG: join(directory, "stale-npmrc") },
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /saved_runner_secret/);
    assert.match(rejected.stderr, /did not authenticate/);
    const publisherObserved = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(publisherObserved.correctToken, true);
    assert.deepEqual(publisherObserved.args, ["whoami"]);
    assert.equal(existsSync(dirname(publisherObserved.config)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
