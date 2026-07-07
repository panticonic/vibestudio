import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backendDegradationLadder,
  createEngineInstaller,
  resolveAssetNames,
  type EngineInstallerDeps,
} from "./engine.js";
import type { EngineBackend, EnginePin, GpuInfo, HardwareProfile } from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("resolveAssetNames", () => {
  it("resolves Windows CUDA 12.4 assets", () => {
    expect(resolveAssetNames(profile({ os: "win32", chosenBackend: "cuda-12.4" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-win-cpu-x64.zip",
      gpu: "llama-b9999-bin-win-cuda-12.4-x64.zip",
      extra: ["cudart-llama-bin-win-cuda-12.4-x64.zip"],
    });
  });

  it("resolves Windows CUDA 13.3 assets including cudart", () => {
    expect(resolveAssetNames(profile({ os: "win32", chosenBackend: "cuda-13.3" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-win-cpu-x64.zip",
      gpu: "llama-b9999-bin-win-cuda-13.3-x64.zip",
      extra: ["cudart-llama-bin-win-cuda-13.3-x64.zip"],
    });
  });

  it("resolves Linux Vulkan assets", () => {
    expect(resolveAssetNames(profile({ os: "linux", chosenBackend: "vulkan" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-ubuntu-x64.tar.gz",
      gpu: "llama-b9999-bin-ubuntu-vulkan-x64.tar.gz",
      extra: [],
    });
  });

  it("resolves Linux CPU arm64 assets", () => {
    expect(resolveAssetNames(profile({ os: "linux", arch: "arm64", chosenBackend: "cpu" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-ubuntu-arm64.tar.gz",
      gpu: null,
      extra: [],
    });
  });

  it("resolves macOS arm64 assets", () => {
    expect(resolveAssetNames(profile({ os: "darwin", arch: "arm64", chosenBackend: "metal" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-macos-arm64.tar.gz",
      gpu: "llama-b9999-bin-macos-arm64.tar.gz",
      extra: [],
    });
  });

  it("uses the Linux Vulkan asset for NVIDIA CUDA profiles", () => {
    expect(resolveAssetNames(profile({ os: "linux", chosenBackend: "cuda-12.4" }), "b9999")).toEqual({
      cpu: "llama-b9999-bin-ubuntu-x64.tar.gz",
      gpu: "llama-b9999-bin-ubuntu-vulkan-x64.tar.gz",
      extra: [],
    });
  });
});

describe("backendDegradationLadder", () => {
  it("returns backend fallback order", () => {
    expect(backendDegradationLadder("cuda-12.4")).toEqual(["cuda-12.4", "vulkan", "cpu"]);
    expect(backendDegradationLadder("cuda-13.3")).toEqual(["cuda-13.3", "vulkan", "cpu"]);
    expect(backendDegradationLadder("rocm")).toEqual(["rocm", "vulkan", "cpu"]);
    expect(backendDegradationLadder("metal")).toEqual(["metal", "cpu"]);
    expect(backendDegradationLadder("vulkan")).toEqual(["vulkan", "cpu"]);
    expect(backendDegradationLadder("cpu")).toEqual(["cpu"]);
  });
});

describe("createEngineInstaller", () => {
  it("downloads, verifies, extracts, and smoke-tests CPU and GPU engines", async () => {
    const rootDir = await tempRoot();
    const hardware = profile({ os: "linux", chosenBackend: "vulkan" });
    const pin = pinFor("b1234", {
      "llama-b1234-bin-ubuntu-x64.tar.gz": textBytes("cpu archive"),
      "llama-b1234-bin-ubuntu-vulkan-x64.tar.gz": textBytes("vulkan archive"),
    });
    const seenUrls: string[] = [];
    const { exec } = fakeExec();
    const installer = createEngineInstaller({
      rootDir,
      fetch: fakeFetch(pin.assets, seenUrls),
      exec,
      log: () => undefined,
    });

    const state = await installer.ensureInstalled(hardware, pin.pin);

    expect(state.cpu?.backend).toBe("cpu");
    expect(state.gpu?.backend).toBe("vulkan");
    expect(state.degradedReason).toBeNull();
    expect(seenUrls.map(assetFromUrl)).toEqual([
      "llama-b1234-bin-ubuntu-x64.tar.gz",
      "llama-b1234-bin-ubuntu-vulkan-x64.tar.gz",
    ]);
    await expect(stat(state.cpu?.serverBinPath ?? "")).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(state.gpu?.serverBinPath ?? "")).resolves.toMatchObject({ mode: expect.any(Number) });

    const downloadCount = seenUrls.length;
    const secondState = await installer.ensureInstalled(hardware, pin.pin);
    expect(secondState.cpu?.serverBinPath).toBe(state.cpu?.serverBinPath);
    expect(secondState.gpu?.serverBinPath).toBe(state.gpu?.serverBinPath);
    expect(seenUrls).toHaveLength(downloadCount);
  });

  it("throws on checksum mismatch", async () => {
    const rootDir = await tempRoot();
    const asset = "llama-b1234-bin-ubuntu-x64.tar.gz";
    const body = textBytes("cpu archive");
    const { exec } = fakeExec();
    const installer = createEngineInstaller({
      rootDir,
      fetch: fakeFetch(new Map([[asset, body]]), []),
      exec,
      log: () => undefined,
    });
    const pin: EnginePin = { buildTag: "b1234", checksums: { [asset]: "0".repeat(64) } };

    await expect(installer.ensureInstalled(profile({ chosenBackend: "cpu" }), pin)).rejects.toThrow(/Checksum mismatch/);
  });

  it("throws when a release asset has no pinned checksum", async () => {
    const rootDir = await tempRoot();
    const asset = "llama-b1234-bin-ubuntu-x64.tar.gz";
    const { exec } = fakeExec();
    const installer = createEngineInstaller({
      rootDir,
      fetch: fakeFetch(new Map([[asset, textBytes("cpu archive")]]), []),
      exec,
      log: () => undefined,
    });

    await expect(
      installer.ensureInstalled(profile({ chosenBackend: "cpu" }), { buildTag: "b1234", checksums: {} })
    ).rejects.toThrow(/Missing pinned checksum/);
  });

  it("degrades GPU install to Vulkan after CUDA smoke-test failure", async () => {
    const rootDir = await tempRoot();
    const hardware = profile({ os: "win32", chosenBackend: "cuda-12.4" });
    const pin = pinFor("b1234", {
      "llama-b1234-bin-win-cpu-x64.zip": textBytes("cpu archive"),
      "llama-b1234-bin-win-cuda-12.4-x64.zip": textBytes("cuda archive"),
      "cudart-llama-bin-win-cuda-12.4-x64.zip": textBytes("cudart archive"),
      "llama-b1234-bin-win-vulkan-x64.zip": textBytes("vulkan archive"),
    });
    const seenUrls: string[] = [];
    const { exec } = fakeExec({ failSmokeBackends: new Set(["cuda-12.4"]) });
    const installer = createEngineInstaller({
      rootDir,
      fetch: fakeFetch(pin.assets, seenUrls),
      exec,
      log: () => undefined,
    });

    const state = await installer.ensureInstalled(hardware, pin.pin);

    expect(state.cpu?.backend).toBe("cpu");
    expect(state.gpu?.backend).toBe("vulkan");
    expect(state.degradedReason).toContain("cuda-12.4");
    expect(seenUrls.map(assetFromUrl)).toEqual([
      "llama-b1234-bin-win-cpu-x64.zip",
      "llama-b1234-bin-win-cuda-12.4-x64.zip",
      "cudart-llama-bin-win-cuda-12.4-x64.zip",
      "llama-b1234-bin-win-vulkan-x64.zip",
    ]);
    await expect(stat(join(rootDir, "engines", "b1234", "cuda-12.4"))).rejects.toThrow();
    await expect(stat(state.gpu?.serverBinPath ?? "")).resolves.toMatchObject({ mode: expect.any(Number) });
  });
});

function profile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  const chosenBackend = overrides.chosenBackend ?? "cpu";
  const vendor: GpuInfo["vendor"] = chosenBackend === "rocm" ? "amd" : chosenBackend === "metal" ? "apple" : "nvidia";
  const chosenGpu =
    chosenBackend === "cpu"
      ? null
      : {
          vendor,
          name: "Test GPU",
          vramMB: 12_288,
          backend: chosenBackend,
          discrete: chosenBackend !== "metal",
        } satisfies GpuInfo;

  return {
    os: "linux",
    arch: "x64",
    gpus: chosenGpu ? [chosenGpu] : [],
    cpu: { cores: 8, features: [] },
    ramMB: 32_768,
    usableRamMB: 28_672,
    chosenBackend,
    chosenGpu,
    tier: chosenBackend === "cpu" ? "cpu-strong" : "gpu-mid",
    probedAt: 1,
    notes: [],
    ...overrides,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-model-engine-"));
  tempRoots.push(root);
  return root;
}

function pinFor(buildTag: string, assets: Record<string, Uint8Array>): { pin: EnginePin; assets: Map<string, Uint8Array> } {
  const checksums: Record<string, string> = {};
  const assetMap = new Map<string, Uint8Array>();
  for (const [asset, body] of Object.entries(assets)) {
    checksums[asset] = sha256(body);
    assetMap.set(asset, body);
  }
  return { pin: { buildTag, checksums }, assets: assetMap };
}

function fakeFetch(assets: Map<string, Uint8Array>, seenUrls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    const asset = assetFromUrl(url);
    const body = assets.get(asset);
    if (!body) {
      return new Response(`missing ${asset}`, { status: 404 });
    }
    return new Response(new TextDecoder().decode(body));
  }) as typeof fetch;
}

function fakeExec(options: { failSmokeBackends?: Set<EngineBackend> } = {}): { exec: EngineInstallerDeps["exec"] } {
  const failSmokeBackends = options.failSmokeBackends ?? new Set<EngineBackend>();
  const exec: EngineInstallerDeps["exec"] = async (bin, args) => {
    if (bin === "unzip" || bin === "tar") {
      const destinationDir = destinationFromArgs(args);
      await mkdir(join(destinationDir, "bin"), { recursive: true });
      await writeFile(join(destinationDir, "bin", "llama-server"), "#!/bin/sh\n");
      return { ok: true, stdout: "", stderr: "", code: 0 };
    }

    if (args[0] === "--version") {
      const failedBackend = [...failSmokeBackends].find((backend) => bin.includes(`/${backend}.tmp/`) || bin.includes(`/${backend}/`));
      if (failedBackend) {
        return { ok: false, stdout: "", stderr: `${failedBackend} failed`, code: 1 };
      }
      return { ok: true, stdout: "llama-server version test", stderr: "", code: 0 };
    }

    return { ok: false, stdout: "", stderr: `unexpected exec ${bin} ${args.join(" ")}`, code: 1 };
  };
  return { exec };
}

function destinationFromArgs(args: string[]): string {
  const flagIndex = args.findIndex((arg) => arg === "-d" || arg === "-C");
  const destination = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  if (!destination) {
    throw new Error(`missing extraction destination in ${args.join(" ")}`);
  }
  return destination;
}

function assetFromUrl(url: string): string {
  const marker = "/";
  const index = url.lastIndexOf(marker);
  if (index < 0) {
    return url;
  }
  return decodeURIComponent(url.slice(index + marker.length));
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
