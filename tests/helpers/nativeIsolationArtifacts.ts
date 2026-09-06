import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NATIVE_ISOLATION_TARGETS,
  MXC_SDK_VERSION,
  nativeIsolationSourceDigest,
} from "../../scripts/native-isolation-artifacts.mjs";

export function prepareNativeIsolationSource(root: string) {
  const source = path.join(root, "native/isolation");
  mkdirSync(path.join(source, "src"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(source, "Cargo.toml"), "[package]\nname='fixture'\n");
  writeFileSync(path.join(source, "Cargo.lock"), "# fixture\n");
  writeFileSync(path.join(source, "targets.json"), JSON.stringify(NATIVE_ISOLATION_TARGETS));
  writeFileSync(path.join(source, "src/main.rs"), "fn main() {}\n");
  writeFileSync(path.join(root, "scripts/build-native-isolation.mjs"), "fixture\n");
  writeFileSync(path.join(root, "scripts/native-isolation-artifacts.mjs"), "fixture\n");
  return source;
}

export function nativeIsolationBinary(target: (typeof NATIVE_ISOLATION_TARGETS)[number]) {
  if (target.platform === "linux") {
    const bytes = Buffer.alloc(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    bytes.writeUInt16LE(target.arch === "x64" ? 62 : 183, 18);
    return bytes;
  }
  if (target.platform === "darwin") {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.arch === "x64" ? 0x01000007 : 0x0100000c, 4);
    return bytes;
  }
  const bytes = Buffer.alloc(96);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "ascii");
  bytes.writeUInt16LE(0x8664, 0x44);
  bytes.writeUInt16LE(0x20b, 0x40 + 24);
  return bytes;
}

export function writeNativeIsolationArtifacts(
  root: string,
  artifactRoot: string,
  targets = NATIVE_ISOLATION_TARGETS
) {
  const sourceDigest = nativeIsolationSourceDigest(root);
  for (const target of targets) {
    const inputRoot = path.join(artifactRoot, `native-isolation-${target.platform}-${target.arch}`);
    mkdirSync(inputRoot, { recursive: true });
    const bytes = nativeIsolationBinary(target);
    for (const file of target.mxcFiles) writeFileSync(path.join(inputRoot, file), bytes);
    writeFileSync(path.join(inputRoot, path.basename(target.cleanupArtifact)), bytes);
    writeFileSync(
      path.join(inputRoot, "manifest.json"),
      JSON.stringify({
        version: 1,
        sdk: "@microsoft/mxc-sdk",
        sdkVersion: MXC_SDK_VERSION,
        binary: target.mxcBinary,
        files: Object.fromEntries(
          target.mxcFiles.map((file: string) => [
            file,
            createHash("sha256").update(bytes).digest("hex"),
          ])
        ),
        binaryDigest: createHash("sha256").update(bytes).digest("hex"),
      })
    );
    writeFileSync(
      path.join(inputRoot, "cleanup-manifest.json"),
      JSON.stringify({
        version: 1,
        rustVersion: "1.95.0",
        rustTarget: target.rustTarget,
        sourceDigest,
        binaryDigest: createHash("sha256").update(bytes).digest("hex"),
      })
    );
  }
}
