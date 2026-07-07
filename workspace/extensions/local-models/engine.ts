import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ROOT_LAYOUT, type EngineBackend, type EnginePin, type EngineState, type HardwareProfile, type InstalledEngine } from "./types.js";

export interface EngineInstallerDeps {
  rootDir: string;
  fetch: typeof fetch;
  exec(
    bin: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> }
  ): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>;
  log(msg: string, data?: unknown): void;
}

const RELEASE_BASE_URL = "https://github.com/ggml-org/llama.cpp/releases/download";
const SMOKE_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 120_000;

export function resolveAssetNames(
  profile: HardwareProfile,
  buildTag: string
): { cpu: string; gpu: string | null; extra: string[] } {
  switch (profile.os) {
    case "win32": {
      const cpu = `llama-${buildTag}-bin-win-cpu-${profile.arch}.zip`;
      const gpu = profile.chosenBackend === "cpu" ? null : `llama-${buildTag}-bin-win-${windowsBackendSegment(profile.chosenBackend)}.zip`;
      const extra = isCuda(profile.chosenBackend) ? [`cudart-llama-bin-win-cuda-${cudaVersion(profile.chosenBackend)}-x64.zip`] : [];
      return { cpu, gpu, extra };
    }
    case "darwin": {
      const asset = `llama-${buildTag}-bin-macos-${profile.arch}.tar.gz`;
      return { cpu: asset, gpu: profile.chosenBackend === "cpu" ? null : asset, extra: [] };
    }
    case "linux": {
      // Verified against the live b9895 release: the CPU build is the PLAIN
      // arch asset (no "-cpu" segment), and GPU variants put the backend
      // BEFORE the arch (e.g. llama-b9895-bin-ubuntu-vulkan-x64.tar.gz).
      const cpu = `llama-${buildTag}-bin-ubuntu-${profile.arch}.tar.gz`;
      const gpu =
        profile.chosenBackend === "cpu"
          ? null
          : `llama-${buildTag}-bin-ubuntu-${linuxBackendSegment(profile.chosenBackend)}-${profile.arch}.tar.gz`;
      return { cpu, gpu, extra: [] };
    }
  }
}

export function backendDegradationLadder(backend: EngineBackend): EngineBackend[] {
  switch (backend) {
    case "cuda-12.4":
    case "cuda-13.3":
      return [backend, "vulkan", "cpu"];
    case "rocm":
      return ["rocm", "vulkan", "cpu"];
    case "metal":
      return ["metal", "cpu"];
    case "vulkan":
      return ["vulkan", "cpu"];
    case "cpu":
      return ["cpu"];
  }
}

export function createEngineInstaller(deps: EngineInstallerDeps): {
  ensureInstalled(profile: HardwareProfile, pin: EnginePin): Promise<EngineState>;
} {
  async function ensureInstalled(profile: HardwareProfile, pin: EnginePin): Promise<EngineState> {
    await mkdir(join(deps.rootDir, ROOT_LAYOUT.enginesDir), { recursive: true });

    const cpu = await installBackend(deps, profile, pin, "cpu");
    let gpu: InstalledEngine | null = null;
    let degradedReason: string | null = null;

    if (profile.chosenBackend !== "cpu") {
      const attempts = backendDegradationLadder(profile.chosenBackend);
      const firstEffectiveBackend = effectiveBackendForInstall(profile, profile.chosenBackend);
      if (firstEffectiveBackend !== profile.chosenBackend) {
        degradedReason = `${profile.chosenBackend} is not published for ${profile.os}; using ${firstEffectiveBackend}`;
      }

      for (const requestedBackend of attempts) {
        const backend = effectiveBackendForInstall(profile, requestedBackend);
        try {
          gpu = backend === "cpu" ? cpu : await installBackend(deps, profile, pin, backend);
          if (requestedBackend !== profile.chosenBackend && degradedReason === null) {
            degradedReason = `degraded from ${profile.chosenBackend} to ${backend}`;
          }
          break;
        } catch (error) {
          if (backend === "cpu") {
            throw error;
          }
          degradedReason = `degraded from ${profile.chosenBackend}: ${errorMessage(error)}`;
          deps.log("local-models engine GPU smoke test failed; trying fallback backend", {
            requestedBackend,
            backend,
            error: errorMessage(error),
          });
        }
      }
    }

    await pruneOldBuilds(deps.rootDir, pin.buildTag);
    return { pin, cpu, gpu, degradedReason };
  }

  return { ensureInstalled };
}

function windowsBackendSegment(backend: EngineBackend): string {
  switch (backend) {
    case "cuda-12.4":
    case "cuda-13.3":
      return `${backend}-x64`;
    case "vulkan":
      return "vulkan-x64";
    case "rocm":
      return "hip-radeon-x64";
    case "cpu":
      return "cpu-x64";
    case "metal":
      throw new Error("Metal llama.cpp assets are not published for Windows");
  }
}

function linuxBackendSegment(backend: EngineBackend): string {
  switch (backend) {
    case "cuda-12.4":
    case "cuda-13.3":
      // ggml-org/llama.cpp does not publish Linux CUDA release archives in the documented scheme;
      // use the Linux Vulkan build for NVIDIA GPUs until a CUDA asset name is pinned.
      return "vulkan";
    case "vulkan":
      return "vulkan";
    case "rocm":
      return "rocm-7.2";
    case "cpu":
      return "cpu";
    case "metal":
      throw new Error("Metal llama.cpp assets are not published for Linux");
  }
}

function effectiveBackendForInstall(profile: HardwareProfile, backend: EngineBackend): EngineBackend {
  return profile.os === "linux" && isCuda(backend) ? "vulkan" : backend;
}

async function installBackend(
  deps: EngineInstallerDeps,
  profile: HardwareProfile,
  pin: EnginePin,
  backend: EngineBackend
): Promise<InstalledEngine> {
  const targetDir = engineDir(deps.rootDir, pin.buildTag, backend);
  const existing = await smokeExistingInstall(deps, targetDir, pin.buildTag, backend);
  if (existing) {
    return existing;
  }

  const assets = assetsForBackend(profile, pin.buildTag, backend);
  const tmpDir = `${targetDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    for (const asset of assets) {
      const archivePath = await downloadAsset(deps, pin, asset);
      try {
        await extractArchive(deps, archivePath, tmpDir);
      } finally {
        await rm(archivePath, { force: true });
      }
    }

    const serverBinPath = await findLlamaServer(tmpDir);
    await chmod(serverBinPath, 0o755);
    await smokeTest(deps, serverBinPath);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(tmpDir, targetDir);

    const installedServerBinPath = join(targetDir, relativePath(tmpDir, serverBinPath));
    return {
      buildTag: pin.buildTag,
      backend,
      dir: targetDir,
      serverBinPath: installedServerBinPath,
      smokeTestedAt: Date.now(),
    };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function assetsForBackend(profile: HardwareProfile, buildTag: string, backend: EngineBackend): string[] {
  const assetProfile: HardwareProfile = { ...profile, chosenBackend: backend };
  const resolved = resolveAssetNames(assetProfile, buildTag);
  const primary = backend === "cpu" ? resolved.cpu : resolved.gpu;
  if (!primary) {
    throw new Error(`No llama.cpp asset resolved for backend ${backend}`);
  }
  return [primary, ...resolved.extra];
}

async function smokeExistingInstall(
  deps: EngineInstallerDeps,
  dir: string,
  buildTag: string,
  backend: EngineBackend
): Promise<InstalledEngine | null> {
  try {
    const serverBinPath = await findLlamaServer(dir);
    await chmod(serverBinPath, 0o755);
    await smokeTest(deps, serverBinPath);
    return {
      buildTag,
      backend,
      dir,
      serverBinPath,
      smokeTestedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function downloadAsset(deps: EngineInstallerDeps, pin: EnginePin, asset: string): Promise<string> {
  const expectedChecksum = pin.checksums[asset];
  if (!expectedChecksum) {
    throw new Error(`Missing pinned checksum for llama.cpp asset ${asset} (${pin.buildTag})`);
  }

  const url = `${RELEASE_BASE_URL}/${pin.buildTag}/${asset}`;
  const response = await deps.fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${asset}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualChecksum = sha256(bytes);
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  const archivePath = join(deps.rootDir, `.engine-${process.pid}-${Date.now()}-${safeFileName(asset)}`);
  await writeFile(archivePath, bytes);
  return archivePath;
}

async function extractArchive(deps: EngineInstallerDeps, archivePath: string, destinationDir: string): Promise<void> {
  const fileName = basename(archivePath);
  const result = fileName.endsWith(".zip")
    ? await deps.exec("unzip", ["-q", archivePath, "-d", destinationDir], { timeoutMs: EXTRACT_TIMEOUT_MS })
    : await deps.exec("tar", ["xzf", archivePath, "-C", destinationDir], { timeoutMs: EXTRACT_TIMEOUT_MS });

  if (!result.ok) {
    throw new Error(`Failed to extract ${fileName}: ${execFailureSummary(result)}`);
  }
}

async function smokeTest(deps: EngineInstallerDeps, serverBinPath: string): Promise<void> {
  const result = await deps.exec(serverBinPath, ["--version"], { timeoutMs: SMOKE_TIMEOUT_MS });
  if (!result.ok) {
    throw new Error(`llama-server smoke test failed: ${execFailureSummary(result)}`);
  }
}

async function findLlamaServer(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findLlamaServer(fullPath);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    } else if (entry.isFile() && (entry.name === "llama-server" || entry.name === "llama-server.exe")) {
      return fullPath;
    }
  }
  throw notFoundError(`Could not locate llama-server under ${root}`);
}

async function pruneOldBuilds(rootDir: string, currentBuildTag: string): Promise<void> {
  const enginesDir = join(rootDir, ROOT_LAYOUT.enginesDir);
  const entries = await readdir(enginesDir, { withFileTypes: true });
  const buildDirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".tmp"))
      .map(async (entry) => ({
        name: entry.name,
        path: join(enginesDir, entry.name),
        mtimeMs: (await stat(join(enginesDir, entry.name))).mtimeMs,
      }))
  );
  const previous = buildDirs
    .filter((entry) => entry.name !== currentBuildTag)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))[0];
  const keep = new Set([currentBuildTag, previous?.name].filter((value): value is string => Boolean(value)));

  await Promise.all(
    buildDirs
      .filter((entry) => !keep.has(entry.name))
      .map((entry) => rm(entry.path, { recursive: true, force: true }))
  );
}

function engineDir(rootDir: string, buildTag: string, backend: EngineBackend): string {
  return join(rootDir, ROOT_LAYOUT.enginesDir, buildTag, backend);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cudaVersion(backend: EngineBackend): string {
  if (!isCuda(backend)) {
    throw new Error(`${backend} is not a CUDA backend`);
  }
  return backend.slice("cuda-".length);
}

function isCuda(backend: EngineBackend): backend is "cuda-12.4" | "cuda-13.3" {
  return backend === "cuda-12.4" || backend === "cuda-13.3";
}

function relativePath(parent: string, child: string): string {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  if (!child.startsWith(prefix)) {
    throw new Error(`${child} is not under ${parent}`);
  }
  return child.slice(prefix.length);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFailureSummary(result: { stdout: string; stderr: string; code: number | null }): string {
  return result.stderr || result.stdout || String(result.code ?? "unknown error");
}

function notFoundError(message: string): Error {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}
