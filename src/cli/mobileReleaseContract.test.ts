import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
