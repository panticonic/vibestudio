import type { EngineBackend, GpuInfo, HardwareProfile, HardwareTier } from "./types.js";

export interface HardwareProfilerDeps {
  exec(
    cmd: string,
    args: string[],
    timeoutMs?: number
  ): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string>;
  platform: NodeJS.Platform;
  arch: string;
  totalMemBytes: number;
  cpuCount: number;
  log(msg: string, data?: unknown): void;
}

type SupportedOs = HardwareProfile["os"];
type SupportedArch = HardwareProfile["arch"];
type CommandResult = Awaited<ReturnType<HardwareProfilerDeps["exec"]>>;

const MIB = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const GPU_MID_MB = 8_000;
const GPU_LARGE_MB = 20_000;
const CPU_STRONG_RAM_MB = 16 * 1024;

export function createHardwareProfiler(deps: HardwareProfilerDeps): {
  probe(): Promise<HardwareProfile>;
} {
  return {
    async probe(): Promise<HardwareProfile> {
      const notes: string[] = [];
      const os = normalizeOs(deps.platform, notes);
      const arch = normalizeArch(deps.arch, notes);
      const ramMB = bytesToMB(deps.totalMemBytes);
      const usableRamMB = Math.max(0, ramMB - 4096);

      try {
        const [gpus, cpuFeatures] = await Promise.all([
          probeGpus(deps, os, arch, ramMB, notes),
          probeCpuFeatures(deps, os, arch, notes),
        ]);
        const chosenGpu = pickChosenGpu(gpus, os, arch);
        const chosenBackend = pickBackend(gpus, os, arch);

        return {
          os,
          arch,
          gpus,
          cpu: {
            cores: normalizeCpuCount(deps.cpuCount, notes),
            features: cpuFeatures,
          },
          ramMB,
          usableRamMB,
          chosenBackend,
          chosenGpu,
          tier: pickTier(chosenGpu, ramMB),
          probedAt: Date.now(),
          notes,
        };
      } catch (error) {
        notes.push(`Unexpected hardware probe failure: ${errorMessage(error)}`);
        safeLog(deps, "local-models hardware probe failed unexpectedly", {
          error: errorMessage(error),
        });

        return {
          os,
          arch,
          gpus: [],
          cpu: {
            cores: normalizeCpuCount(deps.cpuCount, notes),
            features: [],
          },
          ramMB,
          usableRamMB,
          chosenBackend: "cpu",
          chosenGpu: null,
          tier: pickTier(null, ramMB),
          probedAt: Date.now(),
          notes,
        };
      }
    },
  };
}

export function pickBackend(
  gpus: GpuInfo[],
  os: HardwareProfile["os"],
  arch: HardwareProfile["arch"]
): EngineBackend {
  const chosenGpu = pickChosenGpu(gpus, os, arch);
  if (chosenGpu) return chosenGpu.backend;
  if (os === "darwin" && arch === "arm64") return "metal";
  return "cpu";
}

export function pickTier(chosenGpu: GpuInfo | null, ramMB: number): HardwareTier {
  if (chosenGpu) {
    if (chosenGpu.vramMB >= GPU_LARGE_MB) return "gpu-large";
    if (chosenGpu.vramMB >= GPU_MID_MB) return "gpu-mid";
    return "gpu-small";
  }
  return ramMB >= CPU_STRONG_RAM_MB ? "cpu-strong" : "cpu-min";
}

async function probeGpus(
  deps: HardwareProfilerDeps,
  os: SupportedOs,
  arch: SupportedArch,
  ramMB: number,
  notes: string[]
): Promise<GpuInfo[]> {
  if (os === "darwin" && arch === "arm64") {
    return [
      {
        vendor: "apple",
        name: "Apple Silicon GPU",
        vramMB: ramMB,
        backend: "metal",
        discrete: false,
      },
    ];
  }

  const gpus: GpuInfo[] = [];

  const nvidia = await runCommand(
    deps,
    "nvidia-smi",
    ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
    "NVIDIA GPU probing",
    notes
  );
  if (nvidia) {
    const parsed = parseNvidiaSmi(nvidia.stdout, os, notes);
    if (parsed.length === 0) notes.push("nvidia-smi produced no parseable GPU rows.");
    gpus.push(...parsed);
  }

  const rocm = await runCommand(
    deps,
    "rocm-smi",
    ["--showmeminfo", "vram", "--json"],
    "AMD ROCm GPU probing",
    notes
  );
  if (rocm) {
    const parsed = parseRocmSmi(rocm.stdout, notes);
    if (parsed.length === 0) notes.push("rocm-smi produced no parseable AMD GPU rows.");
    gpus.push(...parsed);
  }

  const vulkan = await runCommand(
    deps,
    "vulkaninfo",
    ["--summary"],
    "Vulkan GPU probing",
    notes
  );
  if (vulkan) {
    const parsed = parseVulkanInfo(vulkan.stdout, notes);
    if (parsed.length === 0) {
      notes.push("vulkaninfo --summary produced no parseable GPU devices.");
    } else {
      notes.push("vulkaninfo --summary does not report VRAM; Vulkan GPU vramMB set to 0.");
      for (const gpu of parsed) {
        if (!hasEquivalentGpu(gpus, gpu)) gpus.push(gpu);
      }
    }
  }

  return gpus;
}

async function probeCpuFeatures(
  deps: HardwareProfilerDeps,
  os: SupportedOs,
  arch: SupportedArch,
  notes: string[]
): Promise<string[]> {
  if (os === "linux") {
    try {
      return parseCpuFeatures(await deps.readFile("/proc/cpuinfo"), arch);
    } catch (error) {
      notes.push(`Unable to read /proc/cpuinfo for CPU feature probing: ${errorMessage(error)}`);
      safeLog(deps, "local-models CPU probe failed", { path: "/proc/cpuinfo", error: errorMessage(error) });
      return arch === "arm64" ? ["arm64"] : [];
    }
  }

  if (os === "darwin") {
    const sysctl = await runCommand(
      deps,
      "sysctl",
      ["-a", "machdep.cpu"],
      "macOS CPU feature probing",
      notes
    );
    if (!sysctl) return arch === "arm64" ? ["arm64"] : [];
    return parseCpuFeatures(sysctl.stdout, arch);
  }

  notes.push("CPU feature probing is not implemented on Windows; leaving features empty.");
  return [];
}

function parseNvidiaSmi(stdout: string, os: SupportedOs, notes: string[]): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const [lineIndex, line] of lines.entries()) {
    const fields = parseCsvLine(line);
    if (fields.length < 3) {
      notes.push(`Could not parse nvidia-smi row: ${line}`);
      continue;
    }

    const driverVersion = fields.at(-1)?.trim() ?? "";
    const memory = fields.at(-2)?.trim() ?? "";
    const name = fields.slice(0, -2).join(",").trim() || `NVIDIA GPU ${lineIndex}`;
    const vramMB = parseMemoryToMB(memory);
    if (vramMB === null) notes.push(`Could not parse NVIDIA VRAM value "${memory}" for ${name}.`);

    const backend = pickCudaBackend(driverVersion, os);
    if (backend === "cuda-12.4" && driverMajor(driverVersion) === null) {
      notes.push(`Could not parse NVIDIA driver version "${driverVersion}"; using cuda-12.4.`);
    }

    gpus.push({
      vendor: "nvidia",
      name,
      vramMB: vramMB ?? 0,
      backend,
      discrete: true,
      deviceSelector: String(lineIndex),
    });
  }

  return gpus;
}

function parseRocmSmi(stdout: string, notes: string[]): GpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    notes.push(`Could not parse rocm-smi JSON output: ${errorMessage(error)}`);
    return [];
  }

  const records = topLevelRecords(parsed);
  const gpus: GpuInfo[] = [];

  for (const [fallbackIndex, [key, value]] of records.entries()) {
    const vramBytes = findByKey(value, (field) => /vram.*total.*memory.*\((b|bytes)\)/i.test(field));
    const vramMBField = findByKey(value, (field) =>
      /vram.*total.*memory.*\((mib|mb)\)/i.test(field)
    );
    if (vramBytes === undefined && vramMBField === undefined) continue;

    const vramMB =
      parseBytesToMB(vramBytes) ?? parseMemoryToMB(valueToString(vramMBField) ?? "");
    const name =
      findStringByKey(value, (field) => /(card series|gpu.*name|product.*name|device.*name)/i.test(field)) ??
      `AMD GPU ${key}`;
    const selector = firstNumber(key) ?? String(fallbackIndex);

    if (vramMB === null) {
      notes.push(`Could not parse ROCm VRAM for ${name}; using 0 MB.`);
    }

    gpus.push({
      vendor: "amd",
      name,
      vramMB: vramMB ?? 0,
      backend: "rocm",
      discrete: true,
      deviceSelector: selector,
    });
  }

  return gpus;
}

function parseVulkanInfo(stdout: string, notes: string[]): GpuInfo[] {
  const devices: GpuInfo[] = [];
  let pendingName: string | null = null;
  let pendingType: string | null = null;

  const flush = (): void => {
    if (!pendingName || !pendingType) return;
    const type = pendingType.toUpperCase();
    const isGpu =
      type.includes("PHYSICAL_DEVICE_TYPE_DISCRETE_GPU") ||
      type.includes("PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU");
    if (!isGpu) {
      pendingName = null;
      pendingType = null;
      return;
    }

    const vendor = classifyGpuVendor(pendingName);
    if (!vendor) {
      notes.push(`Could not classify Vulkan GPU vendor for "${pendingName}"; skipping device.`);
      pendingName = null;
      pendingType = null;
      return;
    }

    devices.push({
      vendor,
      name: pendingName,
      vramMB: 0,
      backend: vendor === "apple" ? "metal" : "vulkan",
      discrete: type.includes("PHYSICAL_DEVICE_TYPE_DISCRETE_GPU"),
      deviceSelector: String(devices.length),
    });
    pendingName = null;
    pendingType = null;
  };

  // Real `vulkaninfo --summary` prints deviceType BEFORE deviceName per GPU
  // block (verified live on the RTX 4060 + Radeon 760M reference box) — but
  // handle either order, and reset on each "GPUn:" header so an incomplete
  // pair can never leak into the next device.
  for (const line of stdout.split(/\r?\n/)) {
    if (/^\s*GPU\d+\s*:/.test(line)) {
      pendingName = null;
      pendingType = null;
      continue;
    }

    const nameMatch = line.match(/\bdeviceName\s*=\s*(.+)\s*$/);
    if (nameMatch) {
      const name = nameMatch[1];
      if (name === undefined) {
        continue;
      }
      pendingName = name.trim();
      if (pendingType) flush();
      continue;
    }

    const typeMatch = line.match(/\bdeviceType\s*=\s*(\S+)\s*$/);
    if (typeMatch) {
      const type = typeMatch[1];
      if (type === undefined) {
        continue;
      }
      pendingType = type.trim();
      if (pendingName) flush();
    }
  }

  return devices;
}

function parseCpuFeatures(text: string, arch: SupportedArch): string[] {
  const lower = text.toLowerCase();
  const features: string[] = [];
  if (/\bavx(?:1\.0)?\b/.test(lower)) features.push("avx");
  if (/\bavx2\b/.test(lower)) features.push("avx2");
  if (/\bavx512f\b/.test(lower)) features.push("avx512f");
  if (arch === "arm64") features.push("arm64");
  return unique(features);
}

function pickChosenGpu(
  gpus: GpuInfo[],
  os: HardwareProfile["os"],
  arch: HardwareProfile["arch"]
): GpuInfo | null {
  const discrete = gpus.filter((gpu) => gpu.discrete);
  if (discrete.length > 0) {
    return discrete.slice().sort(compareGpuPreference)[0] ?? null;
  }

  if (os === "darwin" && arch === "arm64") {
    return gpus.find((gpu) => gpu.vendor === "apple" && gpu.backend === "metal") ?? null;
  }

  return null;
}

function compareGpuPreference(left: GpuInfo, right: GpuInfo): number {
  const vramDelta = right.vramMB - left.vramMB;
  if (vramDelta !== 0) return vramDelta;
  return backendRank(right.backend) - backendRank(left.backend);
}

function backendRank(backend: EngineBackend): number {
  switch (backend) {
    case "cuda-13.3":
      return 60;
    case "cuda-12.4":
      return 55;
    case "rocm":
      return 50;
    case "vulkan":
      return 40;
    case "metal":
      return 30;
    case "cpu":
      return 0;
  }
}

async function runCommand(
  deps: HardwareProfilerDeps,
  cmd: string,
  args: string[],
  context: string,
  notes: string[]
): Promise<CommandResult | null> {
  try {
    const result = await deps.exec(cmd, args, COMMAND_TIMEOUT_MS);
    if (!result.ok) {
      notes.push(`${cmd} failed during ${context}${formatCommandError(result.stderr)}`);
      return null;
    }
    return result;
  } catch (error) {
    notes.push(`${cmd} failed during ${context}: ${errorMessage(error)}`);
    safeLog(deps, "local-models hardware command failed", {
      cmd,
      args,
      error: errorMessage(error),
    });
    return null;
  }
}

function pickCudaBackend(driverVersion: string, os: SupportedOs): EngineBackend {
  const major = driverMajor(driverVersion);
  if ((os === "linux" || os === "win32") && major !== null && major >= 580) {
    return "cuda-13.3";
  }
  return "cuda-12.4";
}

function driverMajor(driverVersion: string): number | null {
  const match = driverVersion.match(/^\s*(\d+)/);
  if (!match) return null;
  const major = match[1];
  return major === undefined ? null : Number.parseInt(major, 10);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  fields.push(current.trim());
  return fields;
}

function parseMemoryToMB(value: string): number | null {
  const match = value.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?/i);
  if (!match) return null;

  const numericText = match[1];
  if (numericText === undefined) return null;
  const numeric = Number.parseFloat(numericText);
  if (!Number.isFinite(numeric)) return null;

  const unit = (match[2] ?? "mib").toLowerCase();
  if (unit === "b") return Math.round(numeric / MIB);
  if (unit === "kib" || unit === "kb") return Math.round(numeric / 1024);
  if (unit === "gib" || unit === "gb") return Math.round(numeric * 1024);
  if (unit === "tib" || unit === "tb") return Math.round(numeric * 1024 * 1024);
  return Math.round(numeric);
}

function parseBytesToMB(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value / MIB);
  const stringValue = valueToString(value);
  if (!stringValue) return null;
  const numeric = Number.parseFloat(stringValue.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric / MIB);
}

function topLevelRecords(value: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      isRecord(entry) ? [[String(index), entry] as [string, Record<string, unknown>]] : []
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    isRecord(entry) ? [[key, entry] as [string, Record<string, unknown>]] : []
  );
}

function findByKey(value: unknown, predicate: (key: string) => boolean): unknown {
  if (!isRecord(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (predicate(key)) return nested;
    const found = findByKey(nested, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findStringByKey(value: unknown, predicate: (key: string) => boolean): string | null {
  const found = findByKey(value, predicate);
  return valueToString(found);
}

function valueToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyGpuVendor(name: string): GpuInfo["vendor"] | null {
  const lower = name.toLowerCase();
  if (/\b(nvidia|geforce|rtx|gtx|quadro)\b/.test(lower)) return "nvidia";
  if (/\b(amd|radeon)\b/.test(lower) || lower.includes("advanced micro devices")) return "amd";
  if (/\b(intel|iris|uhd|arc)\b/.test(lower)) return "intel";
  if (/\bapple\b/.test(lower)) return "apple";
  return null;
}

function hasEquivalentGpu(existing: GpuInfo[], candidate: GpuInfo): boolean {
  if (candidate.vendor === "nvidia" && existing.some((gpu) => gpu.vendor === "nvidia")) return true;
  if (
    candidate.vendor === "amd" &&
    candidate.discrete &&
    existing.some((gpu) => gpu.vendor === "amd" && gpu.backend === "rocm" && gpu.discrete)
  ) {
    return true;
  }

  const normalizedCandidate = normalizeGpuName(candidate.name);
  return existing.some((gpu) => {
    if (gpu.vendor !== candidate.vendor || gpu.discrete !== candidate.discrete) return false;
    const normalizedExisting = normalizeGpuName(gpu.name);
    return (
      normalizedExisting === normalizedCandidate ||
      normalizedExisting.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedExisting)
    );
  });
}

function normalizeGpuName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstNumber(value: string): string | null {
  return value.match(/\d+/)?.[0] ?? null;
}

function normalizeOs(platform: NodeJS.Platform, notes: string[]): SupportedOs {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  notes.push(`Unsupported platform "${platform}" for local-models hardware profiling; using linux fallback.`);
  return "linux";
}

function normalizeArch(arch: string, notes: string[]): SupportedArch {
  if (arch === "x64" || arch === "arm64") return arch;
  notes.push(`Unsupported architecture "${arch}" for local-models hardware profiling; using x64 fallback.`);
  return "x64";
}

function normalizeCpuCount(cpuCount: number, notes: string[]): number {
  if (Number.isFinite(cpuCount) && cpuCount >= 1) return Math.floor(cpuCount);
  notes.push(`Invalid CPU count "${cpuCount}"; using 1 core.`);
  return 1;
}

function bytesToMB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / MIB);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function formatCommandError(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `: ${trimmed}` : ".";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeLog(deps: HardwareProfilerDeps, msg: string, data?: unknown): void {
  try {
    deps.log(msg, data);
  } catch {
    // Probe logging must not make hardware detection fail.
  }
}
