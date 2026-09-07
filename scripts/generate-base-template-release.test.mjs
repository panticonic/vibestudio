import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptWorkspaceReleaseReceipts } from "./generate-base-template-release.mjs";
const receipt = (role, digit) => ({
  operationId: role,
  destination: { provider: "github", owner: "panticonic", name: "vibestudio-workspace-base" },
  created: false,
  remoteUrl: "https://github.com/panticonic/vibestudio-workspace-base.git",
  webUrl: "https://github.com/panticonic/vibestudio-workspace-base",
  templateUrl: "git+https://github.com/panticonic/vibestudio-workspace-base.git",
  ref: `refs/tags/${role}-1.0.0`,
  commit: digit.repeat(40),
  snapshot: `v1-sha256:${digit.repeat(64)}`,
  parts: ["meta"],
});
const source = receipt("source", "a");
const distributions = {
  base: receipt("base", "b"),
  personal: receipt("personal", "c"),
  system: receipt("system", "d"),
};
test("adopts all three distinct exact distributions independently of the full authoring checkout", () => {
  const result = adoptWorkspaceReleaseReceipts({ source, distributions });
  assert.equal(result.baseTemplate.commit, source.commit);
  for (const role of Object.keys(distributions))
    assert.equal(result.workspaceTemplates[role].snapshot, distributions[role].snapshot);
});
test("does not treat an old full Base source receipt as three runnable distributions", () => {
  assert.throws(
    () => adoptWorkspaceReleaseReceipts({ source }),
    /Missing exact Base, Personal and System/
  );
  assert.throws(
    () => adoptWorkspaceReleaseReceipts({ source, distributions: { base: distributions.base } }),
    /together/
  );
});
test("validates every publication receipt before adopting the set", () => {
  assert.throws(() =>
    adoptWorkspaceReleaseReceipts({
      source,
      distributions: {
        ...distributions,
        system: { ...distributions.system, commit: "moving-main" },
      },
    })
  );
});
