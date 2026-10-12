import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFullSourceCommit,
  assertReleaseVersion,
  assertSourceCommit,
} from "./check-release-version.mjs";

test("release identity binds a semantic version tag to its exact source commit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(assertReleaseVersion("v1.2.3", "1.2.3"), "1.2.3");
  assert.throws(() => assertReleaseVersion("v1.2.3-rc.1", "1.2.3-rc.1"), /stable/u);
  assert.throws(() => assertReleaseVersion("v1.2.3+build.1", "1.2.3+build.1"), /stable/u);
  assert.throws(() => assertReleaseVersion("v01.2.3", "01.2.3"), /stable/u);
  assert.equal(assertFullSourceCommit(sha), sha);
  assert.equal(assertSourceCommit(sha, sha), sha);
  assert.throws(() => assertSourceCommit(sha, `${sha.slice(0, -1)}8`), /does not match/u);
  assert.throws(() => assertSourceCommit(sha.slice(0, -1), sha), /full Git object ID/u);
});
