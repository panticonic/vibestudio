import { describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "./templateManifest.js";

describe("current template manifest", () => {
  it("requires an explicit, non-overlapping release inventory", () => {
    const parsed = parseTemplateManifestContent(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  name: Test
  repositories: [panels/test]
  files: [package.json]
initPanels:
  - source: panels/test
`,
      WORKSPACE_SYSTEM_EPOCH
    );
    expect(parsed.inventory).toEqual({
      repositories: ["panels/test"],
      files: ["package.json"],
    });
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template: { name: Test }
`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow();
  });

  it("rejects missing and undeclared release bytes", () => {
    const inventory = { repositories: ["panels/test"], files: ["package.json"] };
    const exact = [
      "meta/template.yml",
      "meta/vibestudio.yml",
      "package.json",
      "panels/test/index.tsx",
    ];
    expect(() => validateTemplateSnapshotInventory(inventory, exact)).not.toThrow();
    expect(() =>
      validateTemplateSnapshotInventory(inventory, [...exact, "panels/other/index.tsx"])
    ).toThrow(/undeclared paths/);
    expect(() =>
      validateTemplateSnapshotInventory(
        inventory,
        exact.filter((path) => path !== "package.json")
      )
    ).toThrow(/missing path/);
  });

  it("lets only a dependency-free root initialize the workspace template registry", () => {
    const registry = {
      url: "git+https://github.com/panticonic/vibestudio-template-registry.git",
      ref: "refs/heads/main",
    };
    const root = parseTemplateManifestContent(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
templates:
  use: []
  registry:
    url: ${registry.url}
    ref: ${registry.ref}
`,
      WORKSPACE_SYSTEM_EPOCH
    );
    expect(root.top.templates?.registry).toEqual(registry);
    expect(root.fragment).not.toHaveProperty("templates");

    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
templates:
  use:
    - url: git+https://example.test/base.git
  registry:
    url: ${registry.url}
    ref: ${registry.ref}
`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow(/cannot replace the workspace template registry/u);
  });

  it("generates the flattened root through ordinary composition semantics", () => {
    const root = parseTemplateManifestContent(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
routes: []
providers:
  evalRuntime:
    source: "@workspace/runtime"
`,
      WORKSPACE_SYSTEM_EPOCH
    );

    expect(canonicalTemplateYaml(rootRuntimeFromTemplateManifest(root))).toBe(
      `providers:\n  evalRuntime:\n    source: \"@workspace/runtime\"\nsystemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`
    );
  });
});
