import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  publishArgs,
  runWithOwnedCleanup,
  spawnResultFailure,
  validateNpmPackageManifest,
  validateStagedPackage,
} from "./publish-npm.mjs";

void test("real publication retains errors without buffering the package file manifest", () => {
  assert.deepEqual(publishArgs({ packagePath: "/candidate.tgz", dryRun: false, tag: "latest" }), [
    "publish",
    "/candidate.tgz",
    "--access",
    "public",
    "--tag",
    "latest",
    "--loglevel",
    "error",
  ]);
});

void test("rejects a stale staged candidate before publication", () => {
  const rootPackage = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "publish-npm-staged-candidate-"));
  try {
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "@panticonic/vibestudio-server",
        version: rootPackage.version,
        publishConfig: { access: "public" },
      })
    );
    const candidate = validateStagedPackage({
      name: "@panticonic/vibestudio-server",
      dir: directory,
    });
    assert.equal(candidate.pkg.dir, directory);
    assert.equal(candidate.version, rootPackage.version);
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ ...candidate.manifest, version: "0.0.0-stale" })
    );
    assert.throws(
      () => validateStagedPackage(candidate.pkg),
      /version is 0\.0\.0-stale; expected 0\.\d+\.\d+/u
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test("validates the manifest extracted by a candidate install", () => {
  const manifest = {
    name: "@panticonic/vibestudio-server",
    version: "1.2.3",
    publishConfig: { access: "public" },
  };
  validateNpmPackageManifest(
    manifest,
    { name: manifest.name, version: manifest.version },
    "installed package"
  );
  assert.throws(
    () => validateNpmPackageManifest({ ...manifest, private: true }, manifest, "installed package"),
    /must not be private/u
  );
  assert.throws(
    () =>
      validateNpmPackageManifest(
        { ...manifest, name: "@panticonic/other" },
        manifest,
        "installed package"
      ),
    /name is @panticonic\/other; expected @panticonic\/vibestudio-server/u
  );
  assert.throws(
    () =>
      validateNpmPackageManifest(
        { ...manifest, publishConfig: { access: "restricted" } },
        manifest,
        "installed package"
      ),
    /publishConfig\.access = public/u
  );
});

void test("owned cleanup preserves the operation error as primary", async () => {
  const operationFailure = Object.assign(new Error("install failed"), { code: "EINSTALL" });
  const cleanupFailure = Object.assign(new Error("process retirement failed"), {
    code: "EOWNERSHIP",
  });
  await assert.rejects(
    runWithOwnedCleanup(
      async () => {
        throw operationFailure;
      },
      async () => {
        throw cleanupFailure;
      },
      "install and cleanup failed"
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, operationFailure);
      assert.deepEqual(error.errors, [operationFailure, cleanupFailure]);
      return true;
    }
  );
});

void test("owned cleanup leaves a lone operation error unchanged", async () => {
  const operationFailure = new Error("publish operation failed");
  await assert.rejects(
    runWithOwnedCleanup(
      async () => {
        throw operationFailure;
      },
      async () => {},
      "operation and cleanup failed"
    ),
    (error) => error === operationFailure
  );
});

void test("owned cleanup failure is observable after successful operation", async () => {
  const cleanupFailure = new Error("temporary directory could not be removed");
  await assert.rejects(
    runWithOwnedCleanup(
      async () => "complete",
      async () => {
        throw cleanupFailure;
      },
      "operation and cleanup failed"
    ),
    (error) => error === cleanupFailure
  );
});

void test("spawn failure keeps signal termination detail alongside a spawn error", () => {
  const spawnError = Object.assign(new Error("spawn unavailable"), { code: "ENOENT" });
  const failure = spawnResultFailure(
    { error: spawnError, status: null, signal: "SIGTERM" },
    "npm publish"
  );
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.cause, spawnError);
  assert.match(failure.errors[1].message, /SIGTERM/);
});

void test("spawn failure retains both signal and exit status when both are reported", () => {
  const failure = spawnResultFailure(
    { error: undefined, status: 1, signal: "SIGTERM" },
    "npm publish"
  );
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.errors[0].message, /SIGTERM/);
  assert.match(failure.errors[1].message, /status 1/);
});
