import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as bootstrapLaunchGate from "@vibestudio/shared/bootstrapLaunchGate";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("Android release asset contract", () => {
  it("keeps the installer's default checksum asset aligned with the published release", () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "build-mobile.yml"),
      "utf8"
    );
    const installer = fs.readFileSync(
      path.join(repoRoot, "scripts", "cli", "mobile-install.mjs"),
      "utf8"
    );

    const published = workflow.match(
      /release-candidate\/release-artifacts\/(SHA256SUMS[-A-Za-z0-9]*)/
    )?.[1];
    const downloaded = installer.match(/defaultReleaseBaseUrl}\/(SHA256SUMS[-A-Za-z0-9]*)/)?.[1];

    expect(published).toBe("SHA256SUMS-android");
    expect(downloaded).toBe(published);
  });

  it("keeps the JavaScript native bootstrap on the live launch-gate API", () => {
    const bootstrap = fs.readFileSync(path.join(repoRoot, "apps", "mobile", "index.js"), "utf8");
    const importList = bootstrap.match(
      /import\s*\{([^}]+)\}\s*from\s*["']@vibestudio\/shared\/bootstrapLaunchGate["']/u
    )?.[1];

    expect(importList).toBeTruthy();
    const importedNames = (importList ?? "").split(",").flatMap((name) => {
      const imported = name.trim().split(/\s+as\s+/u)[0];
      return imported ? [imported] : [];
    });
    expect(importedNames.length).toBeGreaterThan(0);
    for (const name of importedNames) {
      expect(bootstrapLaunchGate, `missing bootstrapLaunchGate export: ${name}`).toHaveProperty(
        name
      );
    }
  });
});
