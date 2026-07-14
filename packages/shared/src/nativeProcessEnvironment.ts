import * as path from "node:path";
import { canonicalJson } from "./contentTree/canonicalJson.js";
import { domainHash, type Sha256 } from "./execution/identity.js";

const SAFE_AMBIENT_KEYS = [
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
] as const;

const FORBIDDEN_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /ADMIN/i,
  /^NODE_OPTIONS$/i,
  /^LD_PRELOAD$/i,
  /^DYLD_/i,
  /^VIBESTUDIO_EXTENSION_(?:RPC_TOKEN|GATEWAY_URL|STORAGE_DIR)$/i,
  /^VIBESTUDIO_TERMINAL_ENDPOINT$/i,
] as const;

export interface NativeChildEnvironmentOptions {
  ambient?: NodeJS.ProcessEnv;
  toolchainDir?: string;
  hostBuildId?: string;
  purpose: "build" | "child-hub" | "electron" | "terminal" | "claude" | "helper";
  declared?: Readonly<Record<string, string>>;
  purposeCredential?: Readonly<{ name: string; value: string }>;
}

export interface NativeChildEnvironment {
  env: NodeJS.ProcessEnv;
  declaredNames: string[];
  declaredEnvironmentHash: Sha256;
}

/**
 * Construct a native child environment from an allowlist. Provider credentials
 * never flow by ambient inheritance; a purpose-bound credential must be named
 * explicitly and is excluded from the reproducibility hash.
 */
export function createNativeChildEnvironment(
  options: NativeChildEnvironmentOptions
): NativeChildEnvironment {
  const ambient = options.ambient ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_AMBIENT_KEYS) {
    const value = ambient[key];
    if (value) env[key] = value;
  }
  const toolchainDir = options.toolchainDir ?? ambient["VIBESTUDIO_TOOLCHAIN_DIR"];
  const basePath = ambient["PATH"] ?? ambient["Path"] ?? "";
  if (toolchainDir) {
    const bin = path.join(toolchainDir, "bin");
    env["PATH"] = prependPathOnce(basePath, bin);
    env["VIBESTUDIO_TOOLCHAIN_DIR"] = path.resolve(toolchainDir);
    env["VIBESTUDIO_PNPM_PATH"] = path.join(path.resolve(toolchainDir), "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  } else if (basePath) {
    env["PATH"] = basePath;
  }
  const hostBuildId = options.hostBuildId ?? ambient["VIBESTUDIO_HOST_BUILD_ID"];
  if (hostBuildId) env["VIBESTUDIO_HOST_BUILD_ID"] = hostBuildId;
  if (ambient["VIBESTUDIO_TOOLCHAIN_RUNTIME_NODE_MODE"] === "1") {
    env["VIBESTUDIO_TOOLCHAIN_RUNTIME_NODE_MODE"] = "1";
  }
  env["VIBESTUDIO_CHILD_PURPOSE"] = options.purpose;

  for (const [name, value] of Object.entries(options.declared ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    assertSafeDeclaredName(name);
    env[name] = value;
  }
  if (options.purposeCredential) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(options.purposeCredential.name)) {
      throw new Error(`Invalid purpose credential name: ${options.purposeCredential.name}`);
    }
    if (options.declared?.[options.purposeCredential.name] !== undefined) {
      throw new Error(
        `Purpose credential collides with declared environment: ${options.purposeCredential.name}`
      );
    }
    env[options.purposeCredential.name] = options.purposeCredential.value;
  }

  const declared = Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => name !== options.purposeCredential?.name)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return {
    env,
    declaredNames: Object.keys(declared),
    declaredEnvironmentHash: domainHash(
      "vibestudio/native-child-environment/v1",
      canonicalJson(declared)
    ),
  };
}

export function prependPathOnce(current: string, entry: string): string {
  const target = path.resolve(entry);
  const parts = current
    .split(path.delimiter)
    .filter(Boolean)
    .filter((candidate) => path.resolve(candidate) !== target);
  return [target, ...parts].join(path.delimiter);
}

export function isForbiddenNativeChildVariable(name: string): boolean {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name));
}

function assertSafeDeclaredName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid declared environment name: ${name}`);
  if (isForbiddenNativeChildVariable(name)) {
    throw new Error(`Declared environment name is reserved: ${name}`);
  }
}
