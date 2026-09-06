import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_ISOLATION_TARGETS,
  assertNativeIsolationArtifacts,
  nativeIsolationTarget,
} from "../scripts/native-isolation-artifacts.mjs";
import stageElectronNativeIsolation, {
  assertPackagedNativeIsolation,
} from "../scripts/stage-electron-native-isolation.mjs";
import { nativeIsolationExecutable } from "../src/server/nativeIsolationExecutable.js";

import {
  nativeIsolationBinary as binary,
  prepareNativeIsolationSource,
  writeNativeIsolationArtifacts as writeArtifacts,
} from "./helpers/nativeIsolationArtifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vibestudio-native-artifacts-"));
  roots.push(root);
  const source = prepareNativeIsolationSource(root);
  return { root, artifactRoot: path.join(source, "artifacts") };
}

describe("native isolation artifact matrix", () => {
  it("selects only exact supported tuples and has no Windows arm64 fallback", () => {
    for (const target of NATIVE_ISOLATION_TARGETS) {
      expect(nativeIsolationTarget(target.platform, target.arch)).toEqual(target);
    }
    expect(() => nativeIsolationTarget("win32", "arm64")).toThrow(
      /Unsupported native isolation target/
    );
  });

  it("requires the complete matrix", () => {
    const { root, artifactRoot } = fixture();
    writeArtifacts(root, artifactRoot, NATIVE_ISOLATION_TARGETS.slice(0, -1));
    expect(() => assertNativeIsolationArtifacts(root, artifactRoot)).toThrow(
      /complete CI native artifact matrix/
    );
  });

  it("accepts the complete supported-target matrix and returns binary plus manifest descriptors", () => {
    const { root, artifactRoot } = fixture();
    writeArtifacts(root, artifactRoot);
    const descriptors = assertNativeIsolationArtifacts(root, artifactRoot);
    expect(descriptors).toHaveLength(
      NATIVE_ISOLATION_TARGETS.reduce((total, target) => total + target.mxcFiles.length + 3, 0)
    );
    expect(descriptors.filter(({ artifact }) => artifact.endsWith("manifest.json"))).toHaveLength(
      NATIVE_ISOLATION_TARGETS.length * 2
    );
  });

  it("stages a requested ARM64 helper without using the host target", () => {
    const { root, artifactRoot } = fixture();
    const target = nativeIsolationTarget("linux", "arm64");
    writeArtifacts(root, artifactRoot, [target]);
    try {
      stageElectronNativeIsolation({
        electronPlatformName: "linux",
        arch: 3,
        packager: { projectDir: root },
      } as never);
      const destination = path.join(root, target.artifact);
      expect(readFileSync(destination)).toEqual(binary(target));
      if (process.platform !== "win32") expect(statSync(destination).mode & 0o111).toBeTruthy();
      expect(() =>
        stageElectronNativeIsolation({
          electronPlatformName: "linux",
          arch: 99,
          packager: { projectDir: root },
        } as never)
      ).toThrow(/Unknown Electron packaging architecture/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      roots.splice(roots.indexOf(root), 1);
    }
  });

  it("resolves packaged executables into the physical asar-unpacked tree", () => {
    expect(nativeIsolationExecutable("/opt/app.asar", "win32", "x64")).toBe(
      path.join("/opt/app.asar.unpacked", "dist/native/win32-x64/vibestudio-isolation.exe")
    );
    expect(() => nativeIsolationExecutable("/opt/app.asar", "win32", "arm64")).toThrow(
      /Unsupported native isolation target/
    );
  });

  it("verifies the unpacked helper before signing", () => {
    const { root, artifactRoot } = fixture();
    const target = nativeIsolationTarget("linux", "arm64");
    writeArtifacts(root, artifactRoot, [target]);
    const source = path.join(
      artifactRoot,
      "native-isolation-linux-arm64",
      path.basename(target.artifact)
    );
    const resources = path.join(root, "resources");
    const installed = path.join(resources, "app.asar.unpacked", target.artifact);
    const context = { electronPlatformName: "linux", arch: 3, packager: { projectDir: root } };
    try {
      expect(() => assertPackagedNativeIsolation(resources, context as never)).toThrow(
        /differs|ENOENT/
      );
      mkdirSync(path.dirname(installed), { recursive: true });
      writeFileSync(installed, readFileSync(source));
      chmodSync(installed, 0o755);
      const sourceManifest = path.join(artifactRoot, "native-isolation-linux-arm64/manifest.json");
      const installedManifest = path.join(
        resources,
        "app.asar.unpacked",
        target.artifact.replace(/[^/]+$/, "manifest.json")
      );
      writeFileSync(installedManifest, readFileSync(sourceManifest));
      const cleanupSource = path.join(
        artifactRoot,
        "native-isolation-linux-arm64",
        path.basename(target.cleanupArtifact)
      );
      const cleanupInstalled = path.join(resources, "app.asar.unpacked", target.cleanupArtifact);
      mkdirSync(path.dirname(cleanupInstalled), { recursive: true });
      writeFileSync(cleanupInstalled, readFileSync(cleanupSource));
      chmodSync(cleanupInstalled, 0o755);
      writeFileSync(
        path.join(
          resources,
          "app.asar.unpacked",
          target.cleanupArtifact.replace(/[^/]+$/, "manifest.json")
        ),
        readFileSync(path.join(artifactRoot, "native-isolation-linux-arm64/cleanup-manifest.json"))
      );
      expect(() => assertPackagedNativeIsolation(resources, context as never)).not.toThrow();
      writeFileSync(installed, Buffer.from("changed"));
      expect(() => assertPackagedNativeIsolation(resources, context as never)).toThrow(/differs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      roots.splice(roots.indexOf(root), 1);
    }
  });

  it.each(["source", "target", "checksum", "machine"] as const)(
    "rejects a wrong %s artifact",
    (kind) => {
      const { root, artifactRoot } = fixture();
      writeArtifacts(root, artifactRoot);
      const target = NATIVE_ISOLATION_TARGETS[0]!;
      const inputRoot = path.join(
        artifactRoot,
        `native-isolation-${target.platform}-${target.arch}`
      );
      const artifactPath = path.join(inputRoot, path.basename(target.artifact));
      const manifestPath = path.join(inputRoot, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (kind === "source") manifest.sdkVersion = "0.7.0";
      if (kind === "target") manifest.binary = "wrong-binary";
      if (kind === "checksum") writeFileSync(artifactPath, Buffer.from("tampered"));
      if (kind === "machine") {
        const wrong = binary(NATIVE_ISOLATION_TARGETS[1]!);
        writeFileSync(artifactPath, wrong);
        manifest.binaryDigest = createHash("sha256").update(wrong).digest("hex");
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => assertNativeIsolationArtifacts(root, artifactRoot)).toThrow(
        /different target|checksum mismatch|does not match/
      );
    }
  );
});
