import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_CONDUIT_UNITS } from "./productConduitPolicy.js";

describe("product conduit policy", () => {
  it("references only worker units shipped in the first-run workspace snapshot", () => {
    for (const repoPath of PRODUCT_CONDUIT_UNITS) {
      const packagePath = path.join(process.cwd(), "workspace", repoPath, "package.json");
      expect(
        fs.existsSync(packagePath),
        `${repoPath} must be present in the shipped snapshot`
      ).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        vibestudio?: { durable?: { classes?: unknown[] } };
      };
      expect(
        manifest.vibestudio?.durable?.classes?.length,
        `${repoPath} must remain a worker unit`
      ).toBeGreaterThan(0);
    }
  });
});
