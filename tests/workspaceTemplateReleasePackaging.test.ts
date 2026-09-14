import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stageTemplateRelease } from "../scripts/build-server-npm-package.mjs";

describe("workspace-template release packaging", () => {
  it("stages the host artifact into a headless npm package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-release-package-"));
    try {
      stageTemplateRelease(root);
      const staged = path.join(root, "build-resources", "workspace-template-release.json");
      expect(JSON.parse(fs.readFileSync(staged, "utf8"))).toMatchObject({
        format: "vibestudio-template-release/1",
        workspaceTemplates: {
          base: { commit: expect.stringMatching(/^[0-9a-f]{40}$/u) },
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
