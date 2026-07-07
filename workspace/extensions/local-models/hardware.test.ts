import { describe, expect, it, vi } from "vitest";
import { createHardwareProfiler, pickBackend, pickTier } from "./hardware.js";
import type { GpuInfo } from "./types.js";
import type { HardwareProfilerDeps } from "./hardware.js";

type CommandOutput = { ok: boolean; stdout: string; stderr: string };

describe("HardwareProfiler", () => {
  it("chooses the RTX 4060 Laptop over a Vulkan AMD iGPU on the reference box", async () => {
    const deps = fakeDeps({
      platform: "linux",
      arch: "x64",
      totalMemBytes: 15 * 1024 * 1024 * 1024,
      cpuCount: 12,
      files: {
        "/proc/cpuinfo": "flags\t: fpu sse avx avx2\n",
      },
      commands: {
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader": {
          ok: true,
          stdout: "NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 550.54.14\n",
          stderr: "",
        },
        "rocm-smi --showmeminfo vram --json": {
          ok: false,
          stdout: "",
          stderr: "rocm-smi not found",
        },
        "vulkaninfo --summary": {
          ok: true,
          stdout: [
            "Devices:",
            // Real `vulkaninfo --summary` order: deviceType BEFORE deviceName
            // (verified live; the reversed order also parses).
            "GPU0:",
            "    deviceType        = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU",
            "    deviceName        = NVIDIA GeForce RTX 4060 Laptop GPU",
            "GPU1:",
            "    deviceType        = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU",
            "    deviceName        = AMD Radeon 760M",
          ].join("\n"),
          stderr: "",
        },
      },
    });

    const profile = await createHardwareProfiler(deps).probe();

    expect(profile.gpus).toHaveLength(2);
    expect(profile.gpus.map((gpu) => gpu.vendor)).toEqual(["nvidia", "amd"]);
    // The iGPU must classify as integrated (regression: type/name pairing).
    expect(profile.gpus.find((gpu) => gpu.vendor === "amd")?.discrete).toBe(false);
    expect(profile.chosenGpu).toMatchObject({
      vendor: "nvidia",
      name: "NVIDIA GeForce RTX 4060 Laptop GPU",
      vramMB: 8188,
      discrete: true,
      deviceSelector: "0",
    });
    expect(profile.chosenBackend).toMatch(/^cuda-/);
    expect(profile.tier).toBe("gpu-mid");
    expect(profile.cpu).toEqual({ cores: 12, features: ["avx", "avx2"] });
    expect(profile.usableRamMB).toBe(15 * 1024 - 4096);
  });

  it("falls back to cpu/cpu-min with notes when GPU tools are unavailable", async () => {
    const deps = fakeDeps({
      platform: "linux",
      arch: "x64",
      totalMemBytes: 8 * 1024 * 1024 * 1024,
      cpuCount: 4,
      files: {},
      commands: {},
    });

    const profile = await createHardwareProfiler(deps).probe();

    expect(profile.gpus).toEqual([]);
    expect(profile.chosenBackend).toBe("cpu");
    expect(profile.chosenGpu).toBeNull();
    expect(profile.tier).toBe("cpu-min");
    expect(profile.ramMB).toBe(8192);
    expect(profile.usableRamMB).toBe(4096);
    expect(profile.notes.join("\n")).toContain("nvidia-smi failed");
    expect(profile.notes.join("\n")).toContain("vulkaninfo failed");
    expect(profile.notes.join("\n")).toContain("/proc/cpuinfo");
  });

  it("uses Metal and unified memory on Apple Silicon", async () => {
    const deps = fakeDeps({
      platform: "darwin",
      arch: "arm64",
      totalMemBytes: 32 * 1024 * 1024 * 1024,
      cpuCount: 10,
      files: {},
      commands: {
        "sysctl -a machdep.cpu": {
          ok: true,
          stdout: "machdep.cpu.brand_string: Apple M3\n",
          stderr: "",
        },
      },
    });

    const profile = await createHardwareProfiler(deps).probe();

    expect(profile.gpus).toEqual([
      {
        vendor: "apple",
        name: "Apple Silicon GPU",
        vramMB: 32768,
        backend: "metal",
        discrete: false,
      },
    ]);
    expect(profile.chosenBackend).toBe("metal");
    expect(profile.chosenGpu).toMatchObject({ vendor: "apple", backend: "metal" });
    expect(profile.tier).toBe("gpu-large");
    expect(profile.cpu.features).toEqual(["arm64"]);
  });

  it("pins CUDA 12.4 below driver 580 and selects CUDA 13.3 at driver 580", async () => {
    await expect(probeNvidiaDriver("579.99.01")).resolves.toBe("cuda-12.4");
    await expect(probeNvidiaDriver("580.00.01")).resolves.toBe("cuda-13.3");
  });

  it("classifies tier boundaries", () => {
    expect(pickTier(gpu({ vramMB: 20_000 }), 4096)).toBe("gpu-large");
    expect(pickTier(gpu({ vramMB: 8_000 }), 4096)).toBe("gpu-mid");
    expect(pickTier(gpu({ vramMB: 7_999 }), 64 * 1024)).toBe("gpu-small");
    expect(pickTier(null, 16 * 1024)).toBe("cpu-strong");
    expect(pickTier(null, 16 * 1024 - 1)).toBe("cpu-min");
  });

  it("prefers the discrete GPU with the most VRAM and ignores integrated GPUs for backend choice", () => {
    expect(
      pickBackend(
        [
          gpu({ vendor: "intel", backend: "vulkan", discrete: false, vramMB: 0 }),
          gpu({ vendor: "amd", backend: "vulkan", discrete: true, vramMB: 16_000 }),
          gpu({ vendor: "nvidia", backend: "cuda-13.3", discrete: true, vramMB: 12_000 }),
        ],
        "linux",
        "x64"
      )
    ).toBe("vulkan");
    expect(pickBackend([gpu({ vendor: "intel", backend: "vulkan", discrete: false })], "linux", "x64")).toBe(
      "cpu"
    );
  });
});

async function probeNvidiaDriver(driverVersion: string): Promise<string> {
  const deps = fakeDeps({
    platform: "linux",
    arch: "x64",
    totalMemBytes: 16 * 1024 * 1024 * 1024,
    cpuCount: 8,
    files: {
      "/proc/cpuinfo": "flags\t: avx avx2\n",
    },
    commands: {
      "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader": {
        ok: true,
        stdout: `NVIDIA RTX Test GPU, 12288 MiB, ${driverVersion}\n`,
        stderr: "",
      },
    },
  });
  return (await createHardwareProfiler(deps).probe()).chosenBackend;
}

function fakeDeps(options: {
  platform: NodeJS.Platform;
  arch: string;
  totalMemBytes: number;
  cpuCount: number;
  files: Record<string, string>;
  commands: Record<string, CommandOutput>;
}): HardwareProfilerDeps {
  return {
    exec: vi.fn(async (cmd: string, args: string[]): Promise<CommandOutput> => {
      return (
        options.commands[`${cmd} ${args.join(" ")}`] ?? {
          ok: false,
          stdout: "",
          stderr: `${cmd} not found`,
        }
      );
    }),
    readFile: vi.fn(async (path: string): Promise<string> => {
      const value = options.files[path];
      if (value === undefined) throw new Error(`${path} not found`);
      return value;
    }),
    platform: options.platform,
    arch: options.arch,
    totalMemBytes: options.totalMemBytes,
    cpuCount: options.cpuCount,
    log: vi.fn(),
  };
}

function gpu(overrides: Partial<GpuInfo> = {}): GpuInfo {
  return {
    vendor: "nvidia",
    name: "test gpu",
    vramMB: 8_000,
    backend: "cuda-12.4",
    discrete: true,
    ...overrides,
  };
}
