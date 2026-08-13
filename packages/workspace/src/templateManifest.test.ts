import { describe, expect, it } from "vitest";
import {
  parseTemplateManifestContent,
  validateTemplateSnapshotInventory,
} from "./templateManifest.js";

describe("current template manifest", () => {
  it("requires an explicit, non-overlapping release inventory", () => {
    const parsed = parseTemplateManifestContent(
      `systemEpoch: 58
template:
  name: Test
  repositories: [panels/test]
  files: [package.json]
initPanels:
  - source: panels/test
`,
      58
    );
    expect(parsed.inventory).toEqual({
      repositories: ["panels/test"],
      files: ["package.json"],
    });
    expect(() =>
      parseTemplateManifestContent(
        `systemEpoch: 58
template: { name: Test }
`,
        58
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
      validateTemplateSnapshotInventory(inventory, exact.filter((path) => path !== "package.json"))
    ).toThrow(/missing path/);
  });
});
