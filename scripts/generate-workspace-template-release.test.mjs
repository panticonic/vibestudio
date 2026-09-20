import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptWorkspaceReleaseReceipts } from "./generate-workspace-template-release.mjs";
const receipt = (role, digit) => ({
  operationId: role,
  destination: { provider: "github", owner: "panticonic", name: `vibestudio-${role}` },
  created: false,
  remoteUrl: `https://github.com/panticonic/vibestudio-${role}.git`,
  webUrl: `https://github.com/panticonic/vibestudio-${role}`,
  templateUrl: `git+https://github.com/panticonic/vibestudio-${role}.git`,
  ref: `refs/tags/${role}-1.0.0`,
  commit: digit.repeat(40),
  parts: ["meta"],
});
const templates = {
  base: receipt("base", "b"),
  personal: receipt("personal", "c"),
  system: receipt("system", "d"),
};
test("adopts all three canonical templates", () => {
  const result = adoptWorkspaceReleaseReceipts({ templates });
  for (const role of Object.keys(templates))
    assert.equal(result.workspaceTemplates[role].commit, templates[role].commit);
});
test("retains existing pins for templates without new receipts", () => {
  const current = adoptWorkspaceReleaseReceipts({ templates });
  const result = adoptWorkspaceReleaseReceipts({
    current,
    templates: { base: receipt("base", "e") },
  });
  assert.equal(result.workspaceTemplates.base.commit, "e".repeat(40));
  assert.deepEqual(result.workspaceTemplates.personal, current.workspaceTemplates.personal);
  assert.deepEqual(result.workspaceTemplates.system, current.workspaceTemplates.system);
});
test("requires an exact pin for every template when creating the artifact", () => {
  assert.throws(
    () => adoptWorkspaceReleaseReceipts({ templates: { base: templates.base } }),
    /invalid_type/
  );
});
test("validates every publication receipt before adopting the set", () => {
  assert.throws(() =>
    adoptWorkspaceReleaseReceipts({
      templates: {
        ...templates,
        system: { ...templates.system, commit: "moving-main" },
      },
    })
  );
});
