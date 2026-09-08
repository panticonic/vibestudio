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
    const exact = ["meta/vibestudio.yml", "package.json", "panels/test/index.tsx"];
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

  it("projects a workspace snapshot manifest directly into its runtime", () => {
    const root = parseTemplateManifestContent(
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
routes: []
providers:
  evalRuntime:
    source: "@workspace/runtime"
trust:
  chromeApps: [apps/shell]
git:
  remotes:
    projects:
      default:
        origin:
          url: https://EXAMPLE.test/source
  upstreams:
    projects:
      default:
        remote: origin
        branch: main
`,
      WORKSPACE_SYSTEM_EPOCH
    );

    expect(canonicalTemplateYaml(rootRuntimeFromTemplateManifest(root))).toBe(
      `git:\n  remotes:\n    projects:\n      default:\n        origin:\n          url: https://example.test/source\n  upstreams:\n    projects:\n      default:\n        branch: main\n        remote: origin\nproviders:\n  evalRuntime:\n    source: "@workspace/runtime"\nroutes: []\nsystemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntrust:\n  chromeApps:\n    - apps/shell\n`
    );
  });

  it("rejects composition-only fields at manifest parsing", () => {
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
disable: [routes/example]
`,
        WORKSPACE_SYSTEM_EPOCH
      )
    ).toThrow(/unrecognized key.*disable/iu);
  });
});
