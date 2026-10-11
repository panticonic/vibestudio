import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./setup-npm-token.mjs", import.meta.url));

test("stores the publisher's preferred credential without printing it, checks the saved file, and removes it", () => {
  const directory = mkdtempSync(join(tmpdir(), "vibestudio-npm-token-test-"));
  const tokenFile = join(directory, "config", "token");
  const env = {
    ...process.env,
    VIBESTUDIO_NPM_TOKEN_FILE: tokenFile,
    NODE_AUTH_TOKEN: "preferred_secret",
    NPM_TOKEN: "other_secret",
  };
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", ...options });
  const noSecrets = (result) => {
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /preferred_secret|other_secret|stdin_secret|argument_secret/
    );
    return result;
  };
  try {
    assert.equal(noSecrets(run([])).status, 0);
    assert.equal(readFileSync(tokenFile, "utf8"), "preferred_secret\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, "config")).mode & 0o777, 0o700);
    }
    const unknownArgument = noSecrets(run(["argument_secret"]));
    assert.equal(unknownArgument.status, 1);
    assert.match(unknownArgument.stderr, /Unknown argument/);
    assert.doesNotMatch(unknownArgument.stderr, /argument_secret/);
    assert.equal(noSecrets(run(["--stdin"], { input: "NPM_TOKEN='stdin_secret'\n" })).status, 0);
    assert.equal(readFileSync(tokenFile, "utf8"), "stdin_secret\n");

    const preload = join(directory, "registry.mjs");
    writeFileSync(
      preload,
      `import assert from 'node:assert/strict';
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://registry.npmjs.org/-/whoami');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer stdin_secret');
  return { ok: true, json: async () => ({ username: 'test-publisher' }) };
};\n`
    );
    const check = noSecrets(
      spawnSync(process.execPath, ["--import", preload, script, "--check"], {
        env,
        encoding: "utf8",
      })
    );
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /authenticates as test-publisher/);
    const pnpmCheck = noSecrets(
      spawnSync("pnpm", ["setup:npm-token", "--check"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...env, NODE_OPTIONS: `--import=${preload}` },
        encoding: "utf8",
      })
    );
    assert.equal(pnpmCheck.status, 0, pnpmCheck.stderr);
    assert.match(pnpmCheck.stdout, /authenticates as test-publisher/);
    assert.equal(readFileSync(tokenFile, "utf8"), "stdin_secret\n");
    writeFileSync(preload, "globalThis.fetch = async () => ({ ok: false, status: 401 });\n");
    const rejected = noSecrets(
      spawnSync(process.execPath, ["--import", preload, script, "--check"], {
        env,
        encoding: "utf8",
      })
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /HTTP 401/);
    writeFileSync(
      preload,
      "globalThis.fetch = async () => { throw new Error('stdin_secret'); };\n"
    );
    const offline = noSecrets(
      spawnSync(process.execPath, ["--import", preload, script, "--check"], {
        env,
        encoding: "utf8",
      })
    );
    assert.equal(offline.status, 1);
    assert.match(offline.stderr, /Could not contact/);
    assert.equal(noSecrets(run(["--stdin", "--check"], { input: "stdin_secret" })).status, 1);
    assert.equal(noSecrets(run(["--remove"])).status, 0);
    assert.equal(noSecrets(run(["--check"])).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
