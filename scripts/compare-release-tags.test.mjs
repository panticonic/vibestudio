import assert from "node:assert/strict";
import test from "node:test";
import { compareReleaseTags } from "./compare-release-tags.mjs";

test("release publication promotes only a strictly newer stable version", () => {
  assert.equal(compareReleaseTags("v1.2.3", "v1.2.4"), 1);
  assert.equal(compareReleaseTags("v1.2.3", "v2.0.0"), 1);
  assert.equal(compareReleaseTags("v1.2.3", "v1.2.3"), 0);
  assert.equal(compareReleaseTags("v1.2.4", "v1.2.3"), -1);
  assert.throws(() => compareReleaseTags("v1.2.3-rc.1", "v1.2.4"), /stable/u);
});
