import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL("../native/owned-process-group/darwin.c", import.meta.url)
);
const executableName = "owned-process-group-observer";

export function darwinProcessObserverPath(cwd, arch) {
  return path.join(cwd, "dist", "native-process-observer", "darwin-" + arch, executableName);
}

export function prepareDarwinProcessObserver({
  cwd = process.cwd(),
  arch = process.arch,
  run = spawnSync,
  source = sourcePath,
} = {}) {
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error("Unsupported Darwin process observer architecture: " + arch);
  }
  const output = darwinProcessObserverPath(cwd, arch);
  const manifest = output + ".source.json";
  const targetArch = arch === "x64" ? "x86_64" : "arm64";
  if (!existsSync(source)) {
    assertDarwinProcessObserverArtifacts(cwd, { architectures: [arch] });
    chmodSync(output, 0o755);
    assertDarwinProcessObserver(output, { run, expectedArch: targetArch });
    return output;
  }

  const sourceBytes = readFileSync(source);
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  if (existsSync(output) && existsSync(manifest)) {
    let current;
    try {
      current = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (cause) {
      throw new Error("Darwin process observer source receipt is malformed", { cause });
    }
    if (
      current.version === 2 &&
      current.sourceDigest === sourceDigest &&
      current.binaryDigest === darwinProcessObserverDigest(output) &&
      current.targetArch === targetArch &&
      isDarwinProcessObserverArchitecture(output, targetArch)
    ) {
      // CI artifact transfer does not preserve executable mode. The source and
      // binary digests above authenticate this exact input before restoring it.
      chmodSync(output, 0o755);
      assertDarwinProcessObserver(output, { run, expectedArch: targetArch });
      return output;
    }
  }

  mkdirSync(path.dirname(output), { recursive: true });
  const temporarySource = output + "." + randomUUID() + ".c";
  const temporaryOutput = output + "." + randomUUID() + ".tmp";
  const compiler = run("xcrun", ["--sdk", "macosx", "--find", "clang"], {
    cwd,
    encoding: "utf8",
  });
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0 || !compiler.stdout.trim()) {
    throw new Error(
      "Could not locate the macOS SDK compiler: " +
        String(compiler.stderr || compiler.stdout || compiler.status)
    );
  }
  try {
    writeFileSync(temporarySource, sourceBytes, { mode: 0o600, flag: "wx" });
    const compiled = run(
      compiler.stdout.trim(),
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-mmacosx-version-min=14.0",
        "-arch",
        targetArch,
        temporarySource,
        "-o",
        temporaryOutput,
      ],
      { cwd, encoding: "utf8" }
    );
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0) {
      throw new Error(
        "Could not compile the Darwin process observer: " +
          String(compiled.stderr || compiled.stdout || compiled.status)
      );
    }
    chmodSync(temporaryOutput, 0o755);
    assertDarwinProcessObserver(temporaryOutput, { run, expectedArch: targetArch });
    const binaryDigest = darwinProcessObserverDigest(temporaryOutput);
    renameSync(temporaryOutput, output);
    const temporaryManifest = manifest + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(
        temporaryManifest,
        JSON.stringify({ version: 2, sourceDigest, binaryDigest, targetArch }) + "\n",
        { mode: 0o644, flag: "wx" }
      );
      renameSync(temporaryManifest, manifest);
    } finally {
      rmSync(temporaryManifest, { force: true });
    }
  } finally {
    rmSync(temporarySource, { force: true });
    rmSync(temporaryOutput, { force: true });
  }
  return output;
}

/** Validate published architecture receipts without invoking host SDK tools. */
export function assertDarwinProcessObserverArtifacts(
  root,
  { source = sourcePath, architectures = ["arm64", "x64"] } = {}
) {
  const expectedSourceDigest = existsSync(source)
    ? createHash("sha256").update(readFileSync(source)).digest("hex")
    : undefined;
  for (const arch of architectures) {
    if (arch !== "arm64" && arch !== "x64") {
      throw new Error("Unsupported Darwin process observer architecture: " + arch);
    }
    const executable = darwinProcessObserverPath(root, arch);
    const receipt = JSON.parse(readFileSync(executable + ".source.json", "utf8"));
    const expectedArch = arch === "x64" ? "x86_64" : "arm64";
    const receiptKeys = Object.keys(receipt).sort();
    if (
      receiptKeys.join(",") !== "binaryDigest,sourceDigest,targetArch,version" ||
      receipt.version !== 2 ||
      (expectedSourceDigest !== undefined && receipt.sourceDigest !== expectedSourceDigest) ||
      !/^[a-f0-9]{64}$/u.test(receipt.sourceDigest) ||
      receipt.binaryDigest !== darwinProcessObserverDigest(executable) ||
      receipt.targetArch !== expectedArch
    ) {
      throw new Error("Darwin process observer does not match its source receipt: " + executable);
    }
    const metadata = statSync(executable);
    if (!metadata.isFile())
      throw new Error("Darwin process observer is not a regular file: " + executable);
    if (!isDarwinProcessObserverArchitecture(executable, expectedArch)) {
      throw new Error("Darwin process observer architecture mismatch: expected " + expectedArch);
    }
  }
}

export function assertDarwinProcessObserver(executable, { run = spawnSync, expectedArch } = {}) {
  const metadata = statSync(executable);
  if (!metadata.isFile() || (metadata.mode & 0o111) !== 0o111) {
    throw new Error("Darwin process observer is missing executable mode: " + executable);
  }
  if (
    expectedArch !== undefined &&
    !isDarwinProcessObserverArchitecture(executable, expectedArch)
  ) {
    throw new Error("Darwin process observer architecture mismatch: expected " + expectedArch);
  }
  const currentArch = process.arch === "x64" ? "x86_64" : process.arch;
  if (expectedArch === undefined || expectedArch === currentArch) {
    const result = run(executable, ["--version"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stdout.trim() !== "1") {
      throw new Error(
        "Darwin process observer failed its version probe: " +
          String(result.stderr || result.stdout || result.status)
      );
    }
  }
}

/** Read the thin Mach-O header's standard CPU type field. */
export function isDarwinProcessObserverArchitecture(executable, expectedArch) {
  if (expectedArch !== "arm64" && expectedArch !== "x86_64") return false;
  const binary = readFileSync(executable);
  if (binary.length < 8) return false;
  let magic;
  let cpuType;
  if (binary.readUInt32LE(0) === 0xfeedfacf) {
    magic = 0xfeedfacf;
    cpuType = binary.readUInt32LE(4);
  } else if (binary.readUInt32BE(0) === 0xfeedfacf) {
    magic = 0xfeedfacf;
    cpuType = binary.readUInt32BE(4);
  } else {
    return false;
  }
  const expectedCpu = expectedArch === "arm64" ? 0x0100000c : 0x01000007;
  return magic === 0xfeedfacf && cpuType === expectedCpu;
}

export function darwinProcessObserverDigest(executable) {
  return createHash("sha256").update(readFileSync(executable)).digest("hex");
}
