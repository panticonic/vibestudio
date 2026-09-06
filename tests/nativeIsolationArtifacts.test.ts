import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
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
import { parse as parseYaml } from "yaml";
import { copyFiles, getFileMatchers } from "app-builder-lib/out/fileMatcher.js";
import {
  NATIVE_ISOLATION_TARGETS,
  assertNativeIsolationArtifacts,
  nativeIsolationTarget,
} from "../scripts/native-isolation-artifacts.mjs";
import { writeNodeRuntimeFixture } from "./helpers/nodeRuntimeArtifacts.js";
import stageElectronNativeIsolation, {
  assertPackagedNativeIsolation,
} from "../scripts/stage-electron-native-isolation.mjs";

import {
  nativeIsolationBinary as binary,
  writeNativeIsolationArtifacts as writeArtifacts,
} from "./helpers/nativeIsolationArtifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vibestudio-native-artifacts-"));
  roots.push(root);
  return { root, artifactRoot: path.join(root, "native/isolation/artifacts") };
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
    expect(() => assertNativeIsolationArtifacts(root, artifactRoot)).toThrow(/complete CI matrix/);
  });

  it("accepts the complete supported-target matrix and returns binary plus manifest descriptors", () => {
    const { root, artifactRoot } = fixture();
    writeArtifacts(root, artifactRoot);
    const descriptors = assertNativeIsolationArtifacts(root, artifactRoot);
    expect(descriptors).toHaveLength(
      NATIVE_ISOLATION_TARGETS.reduce((total, target) => total + target.mxcFiles.length + 1, 0)
    );
    expect(descriptors.filter(({ artifact }) => artifact.endsWith("manifest.json"))).toHaveLength(
      NATIVE_ISOLATION_TARGETS.length
    );
  });

  it("stages a requested ARM64 helper without using the host target", async () => {
    const { root, artifactRoot } = fixture();
    const target = nativeIsolationTarget("linux", "arm64");
    writeNodeRuntimeFixture(root, "linux", "arm64");
    writeArtifacts(root, artifactRoot, [target]);
    try {
      await stageElectronNativeIsolation({
        electronPlatformName: "linux",
        arch: 3,
        packager: { projectDir: root },
      } as never);
      const destination = path.join(root, target.artifact);
      expect(readFileSync(destination)).toEqual(binary(target));
      if (process.platform !== "win32") expect(statSync(destination).mode & 0o111).toBeTruthy();
      await expect(
        stageElectronNativeIsolation({
          electronPlatformName: "linux",
          arch: 99,
          packager: { projectDir: root },
        } as never)
      ).rejects.toThrow(/Unknown Electron packaging architecture/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      roots.splice(roots.indexOf(root), 1);
    }
  });

  it("verifies the unpacked helper before signing", async () => {
    const { root, artifactRoot } = fixture();
    const target = nativeIsolationTarget("linux", "arm64");
    writeNodeRuntimeFixture(root, "linux", "arm64");
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
      await expect(assertPackagedNativeIsolation(resources, context as never)).rejects.toThrow(
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
      cpSync(
        path.join(root, "dist/node/linux-arm64"),
        path.join(resources, "app.asar.unpacked/dist/node/linux-arm64"),
        { recursive: true }
      );
      writeFileSync(installedManifest, readFileSync(sourceManifest));
      await expect(
        assertPackagedNativeIsolation(resources, context as never)
      ).resolves.not.toThrow();
      writeFileSync(installed, Buffer.from("changed"));
      await expect(assertPackagedNativeIsolation(resources, context as never)).rejects.toThrow(
        /differs/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      roots.splice(roots.indexOf(root), 1);
    }
  });

  it("stages Windows Node without requiring or shipping an MXC executor", async () => {
    const { root } = fixture();
    writeNodeRuntimeFixture(root, "win32", "x64");
    const workerdPackage = path.join(
      root,
      "node_modules/@cloudflare/workerd-windows-64"
    );
    mkdirSync(path.join(workerdPackage, "bin"), { recursive: true });
    writeFileSync(
      path.join(workerdPackage, "package.json"),
      JSON.stringify({ name: "@cloudflare/workerd-windows-64", version: "test" })
    );
    writeFileSync(path.join(workerdPackage, "bin/workerd.exe"), "vendor workerd");
    const context = { electronPlatformName: "win32", arch: 1, packager: { projectDir: root } };
    await stageElectronNativeIsolation(context as never);
    const resources = path.join(root, "resources");
    cpSync(path.join(root, "dist/node"), path.join(resources, "app.asar.unpacked/dist/node"), {
      recursive: true,
    });
    cpSync(
      workerdPackage,
      path.join(resources, "app.asar.unpacked/node_modules/@cloudflare/workerd-windows-64"),
      { recursive: true }
    );
    await expect(
      assertPackagedNativeIsolation(resources, context as never)
    ).resolves.toBeUndefined();
    expect(() => statSync(path.join(root, "dist/mxc"))).toThrow();
    expect(() => statSync(path.join(resources, "app.asar.unpacked/dist/mxc"))).toThrow();
    expect(readFileSync(path.join(workerdPackage, "bin/workerd.exe.manifest"))).toEqual(
      readFileSync("scripts/workerd.exe.manifest")
    );
  });

  it("uses Electron Builder's real resource filter without dropping vendored node_modules", async () => {
    const { root } = fixture();
    const runtime = path.join(root, "dist/node");
    mkdirSync(path.join(runtime, "win32-x64/node_modules/corepack/dist"), { recursive: true });
    mkdirSync(path.join(runtime, "linux-x64/node_modules/other"), { recursive: true });
    writeFileSync(path.join(runtime, "win32-x64/node.exe"), "windows node");
    writeFileSync(
      path.join(runtime, "win32-x64/node_modules/corepack/dist/corepack.js"),
      "corepack"
    );
    writeFileSync(path.join(runtime, "linux-x64/node_modules/other/index.js"), "other");

    const builderConfig = parseYaml(readFileSync("electron-builder.yml", "utf8")) as {
      win?: { extraResources?: unknown };
    };
    const resources = path.join(root, "release/resources");
    const matchers = getFileMatchers({}, "extraResources", resources, {
      defaultSrc: root,
      globalOutDir: path.join(root, "release"),
      customBuildOptions: builderConfig.win,
      macroExpander: (value: string) => value.replaceAll("${arch}", "x64"),
    });
    await copyFiles(matchers);

    const installed = path.join(resources, "app.asar.unpacked/dist/node");
    expect(existsSync(path.join(installed, "win32-x64/node.exe"))).toBe(true);
    expect(
      existsSync(path.join(installed, "win32-x64/node_modules/corepack/dist/corepack.js"))
    ).toBe(true);
    expect(existsSync(path.join(installed, "linux-x64/node_modules/other/index.js"))).toBe(false);
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
