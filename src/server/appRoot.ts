import * as fs from "node:fs";
import * as path from "node:path";
import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";

export const TYPESCRIPT_SERVER_PATH_ENV = "VIBESTUDIO_TYPESCRIPT_SERVER_PATH";

export interface HostBuildFingerprint {
  readonly version: 1;
  readonly mode: "development" | "production";
  readonly fingerprint: string;
  readonly inputCount: number;
}

export function resolveRequiredAppRoot(
  input: {
    readonly argument?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): string {
  const configured = input.argument ?? (input.env ?? process.env)["VIBESTUDIO_APP_ROOT"];
  if (!configured) {
    throw new Error(
      "Vibestudio startup requires --app-root or VIBESTUDIO_APP_ROOT; the process working directory is not an execution input"
    );
  }
  return path.resolve(configured);
}

export function resolveRequiredHostArtifactRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["VIBESTUDIO_HOST_ARTIFACT_ROOT"];
  if (!configured) {
    throw new Error(
      "Vibestudio startup requires VIBESTUDIO_HOST_ARTIFACT_ROOT; compiled artifacts must come from one explicit host generation"
    );
  }
  return path.resolve(configured);
}

/** Read the completion receipt from the exact immutable generation this process executes. */
export function readHostBuildFingerprint(hostArtifactRoot: string): HostBuildFingerprint {
  const fingerprintPath = path.join(path.resolve(hostArtifactRoot), "host-build-fingerprint.json");
  let record: unknown;
  try {
    record = JSON.parse(fs.readFileSync(fingerprintPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Installed host build identity is unavailable at ${fingerprintPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    typeof record !== "object" ||
    record === null ||
    (record as Record<string, unknown>)["version"] !== 1 ||
    !["development", "production"].includes(
      String((record as Record<string, unknown>)["mode"] ?? "")
    ) ||
    !/^[0-9a-f]{64}$/u.test(String((record as Record<string, unknown>)["fingerprint"] ?? "")) ||
    !Number.isSafeInteger((record as Record<string, unknown>)["inputCount"]) ||
    Number((record as Record<string, unknown>)["inputCount"]) < 1
  ) {
    throw new Error(`Installed host build identity is malformed at ${fingerprintPath}`);
  }
  return record as HostBuildFingerprint;
}

export function resolveNativeTypeScriptServerPath(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return getPhysicalAppPath(
    appRoot,
    path.join(
      "node_modules",
      "@typescript",
      `typescript-${platform}-${arch}`,
      "lib",
      platform === "win32" ? "tsc.exe" : "tsc"
    )
  );
}
