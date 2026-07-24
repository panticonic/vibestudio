import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "../../scripts/host-build-fingerprint.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "vibestudio-host-build-fingerprint-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "src"), { recursive: true });
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(directory, "package.json"), "{}\n");
  return directory;
}

describe("host build fingerprint", () => {
  it("detects source mutations but ignores emitted artifacts", () => {
    const cwd = fixture();
    const before = computeHostBuildFingerprint({ cwd, mode: "development" });

    writeFileSync(join(cwd, "dist", "server.mjs"), "first output\n");
    mkdirSync(join(cwd, "packages", "typecheck"), { recursive: true });
    writeFileSync(
      join(cwd, "packages", "typecheck", "tsconfig.build.tsbuildinfo"),
      "incremental compiler cache\n"
    );
    expect(
      sameHostBuildFingerprint(
        before,
        computeHostBuildFingerprint({ cwd, mode: "development" })
      )
    ).toBe(true);

    writeFileSync(join(cwd, "src", "index.ts"), "export const value = 2;\n");
    expect(
      sameHostBuildFingerprint(
        before,
        computeHostBuildFingerprint({ cwd, mode: "development" })
      )
    ).toBe(false);
  });

  it("keeps development and production freshness distinct", () => {
    const cwd = fixture();
    expect(
      sameHostBuildFingerprint(
        computeHostBuildFingerprint({ cwd, mode: "development" }),
        computeHostBuildFingerprint({ cwd, mode: "production" })
      )
    ).toBe(false);
  });
});
