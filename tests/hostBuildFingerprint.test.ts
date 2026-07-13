import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeHostBuildFingerprint,
  readHostBuildFingerprint,
  writeHostBuildFingerprint,
} from "../scripts/host-build-fingerprint.mjs";

const temporaryDirectories: string[] = [];

function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-build-"));
  temporaryDirectories.push(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "entry.ts"), "export const value = 1;\n");
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  return cwd;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("host build fingerprint", () => {
  it("changes for source content and build mode, but not build outputs", () => {
    const cwd = fixture();
    const initial = computeHostBuildFingerprint({ cwd, mode: "development" });

    fs.writeFileSync(path.join(cwd, "dist", "server.mjs"), "generated");
    expect(computeHostBuildFingerprint({ cwd, mode: "development" })).toEqual(initial);

    fs.writeFileSync(path.join(cwd, "src", "entry.ts"), "export const value = 2;\n");
    expect(computeHostBuildFingerprint({ cwd, mode: "development" }).fingerprint).not.toBe(
      initial.fingerprint
    );
    expect(computeHostBuildFingerprint({ cwd, mode: "production" }).fingerprint).not.toBe(
      initial.fingerprint
    );
  });

  it("changes when the workerd build helper changes", () => {
    const cwd = fixture();
    const helper = path.join(cwd, "scripts", "build-workerd-programs.mjs");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "export const target = 'es2022';\n");
    const initial = computeHostBuildFingerprint({ cwd, mode: "development" });

    fs.writeFileSync(helper, "export const target = 'es2023';\n");

    expect(computeHostBuildFingerprint({ cwd, mode: "development" }).fingerprint).not.toBe(
      initial.fingerprint
    );
  });

  it("persists the completed-build contract", () => {
    const cwd = fixture();
    const fingerprint = computeHostBuildFingerprint({ cwd, mode: "development" });
    writeHostBuildFingerprint(fingerprint, cwd);
    expect(readHostBuildFingerprint(cwd)).toEqual(fingerprint);
  });
});
