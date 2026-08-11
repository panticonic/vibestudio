import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stageBaseTemplateRelease } from "../scripts/build-npm-packages.mjs";

describe("base-template release packaging", () => {
  it("stages the host artifact into a headless npm package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-release-package-"));
    try {
      stageBaseTemplateRelease(root);
      const staged = path.join(root, "build-resources", "base-template-release.json");
      expect(JSON.parse(fs.readFileSync(staged, "utf8"))).toMatchObject({
        version: 1,
        baseTemplate: { commit: expect.stringMatching(/^[0-9a-f]{40}$/u) },
        systemNotes: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
