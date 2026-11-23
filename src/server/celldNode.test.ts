import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { celldTarget, resolveCelldBinary } from "./celldNode.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function appRoot(contents: string, sha256: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "celld-resolve-"));
  roots.push(root);
  const dir = path.join(root, "native", "celld", celldTarget());
  fs.mkdirSync(dir, { recursive: true });
  const executable = process.platform === "win32" ? "celld.exe" : "celld";
  fs.writeFileSync(path.join(dir, executable), contents);
  fs.writeFileSync(
    path.join(root, "native", "celld", "targets.json"),
    JSON.stringify({
      version: 1,
      targets: [{ platform: process.platform, arch: process.arch, binary: executable, sha256 }],
    })
  );
  return { root, binary: path.join(dir, executable) };
}

describe("resolveCelldBinary", () => {
  it("resolves the staged payload only when it is the build the manifest names", () => {
    const body = "celld bytes";
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const good = appRoot(body, digest);
    expect(resolveCelldBinary(good.root, {})).toBe(good.binary);
    const wrong = appRoot(body, "0".repeat(64));
    expect(() => resolveCelldBinary(wrong.root, {})).toThrow("not the build this application names");
    const unpublished = appRoot(body, null);
    expect(() => resolveCelldBinary(unpublished.root, {})).toThrow("No celld build is published");
  });

  it("takes an explicit local build, which must be absolute and exist, and has no PATH fallback", () => {
    const { binary } = appRoot("local build", null);
    expect(resolveCelldBinary(undefined, { VIBESTUDIO_CELLD_BIN: binary })).toBe(binary);
    expect(() => resolveCelldBinary(undefined, { VIBESTUDIO_CELLD_BIN: "celld" })).toThrow("absolute");
    expect(() => resolveCelldBinary(undefined, { VIBESTUDIO_CELLD_BIN: "/no/such/celld" })).toThrow(
      "does not exist"
    );
    expect(() => resolveCelldBinary(os.tmpdir(), {})).toThrow("No celld runtime is staged");
  });
});
