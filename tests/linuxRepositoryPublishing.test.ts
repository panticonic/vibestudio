import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe.runIf(process.platform === "linux")("Debian repository publication", () => {
  function packageFixture(root: string, arch: string) {
    const source = join(root, `source-${arch}`);
    mkdirSync(join(source, "DEBIAN"), { recursive: true });
    // Debian requires this public fixture directory mode, regardless of umask.
    chmodSync(join(source, "DEBIAN"), 0o755);
    writeFileSync(
      join(source, "DEBIAN/control"),
      `Package: vibestudio\nVersion: 0.1.55\nArchitecture: ${arch}\nMaintainer: Release Test <test@example.com>\nDescription: Repository fixture\n`
    );
    const pool = join(root, "apt/pool/main/v/vibestudio");
    mkdirSync(pool, { recursive: true });
    execFileSync(
      "dpkg-deb",
      ["--build", "--root-owner-group", source, join(pool, `vibestudio-0.1.55-${arch}.deb`)],
      { stdio: "pipe" }
    );
  }
  it("indexes both architectures from metadata despite release filename conventions", () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-apt-index-"));
    try {
      packageFixture(root, "amd64");
      packageFixture(root, "arm64");
      execFileSync("bash", [
        resolve("scripts/publish/build-apt-indices.sh"),
        join(root, "apt"),
        "stable",
      ]);
      for (const arch of ["amd64", "arm64"]) {
        const index = readFileSync(
          join(root, `apt/dists/stable/main/binary-${arch}/Packages`),
          "utf8"
        );
        expect(index).toContain(`Architecture: ${arch}\n`);
        expect(index).toContain(`Filename: pool/main/v/vibestudio/vibestudio-0.1.55-${arch}.deb\n`);
        expect(index.match(/^Package:/gm)).toHaveLength(1);
        expect(index).toContain("Version: 0.1.55\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects a repository that omits a required architecture", () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-apt-missing-"));
    try {
      packageFixture(root, "amd64");
      const result = spawnSync(
        "bash",
        [resolve("scripts/publish/build-apt-indices.sh"), join(root, "apt"), "stable"],
        { encoding: "utf8" }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no packages for required architecture arm64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
