import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../atomicFile.js";
import { cliConfigRoot } from "./configPaths.js";

export interface StoredSystemTestRun {
  schemaVersion: 2;
  /** Stable system-test artifact/provenance id. */
  runId: string;
  /** Opaque handle returned by eval.start. */
  evalRunId: string;
  createdAt: number;
  serverUrl: string;
  sessionName: string;
  ownerId: string;
  contextId: string;
  subKey: string;
  /** Absolute run-specific artifact directory. */
  artifactDir: string;
  config: {
    names: string[];
    category?: string;
    all: boolean;
    model?: string;
    concurrency: number;
    testTimeoutMs?: number;
    approvalPolicy?: "fail-fast" | "wait" | "reachable";
  };
}

/**
 * A doctor-verified direct route to a locally running workspace gateway.
 *
 * Pairing remains the source of identity and the fallback transport. This
 * record only avoids renegotiating the single-peer WebRTC room for every
 * system-test status poll when the server has explicitly reported a loopback
 * gateway that this same CLI host can reach.
 */
export interface StoredSystemTestTarget {
  schemaVersion: 1;
  pairedUrl: string;
  workspaceName: string;
  serverUrl: string;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
  verifiedAt: number;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function systemTestRunRoot(): string {
  return path.join(cliConfigRoot(), "system-test-runs");
}

export function systemTestTargetPath(): string {
  return path.join(cliConfigRoot(), "system-test-target.json");
}

export function saveSystemTestTarget(target: StoredSystemTestTarget): void {
  writeFileAtomicSync(systemTestTargetPath(), JSON.stringify(target, null, 2), { mode: 0o600 });
}

export function loadSystemTestTarget(): StoredSystemTestTarget | null {
  const file = systemTestTargetPath();
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSystemTestTarget>;
    const allowed = new Set([
      "schemaVersion",
      "pairedUrl",
      "workspaceName",
      "serverUrl",
      "serverId",
      "serverBootId",
      "workspaceId",
      "verifiedAt",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.schemaVersion !== 1 ||
      typeof value.pairedUrl !== "string" ||
      typeof value.workspaceName !== "string" ||
      typeof value.serverUrl !== "string" ||
      typeof value.serverId !== "string" ||
      typeof value.serverBootId !== "string" ||
      typeof value.workspaceId !== "string" ||
      !Number.isSafeInteger(value.verifiedAt) ||
      (value.verifiedAt ?? 0) <= 0
    ) {
      throw new Error("invalid schema");
    }
    return value as StoredSystemTestTarget;
  } catch (error) {
    throw new Error(
      `Could not read system-test target ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function clearSystemTestTarget(): void {
  const file = systemTestTargetPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function systemTestRunDir(runId: string): string {
  assertRunId(runId);
  return path.join(systemTestRunRoot(), runId);
}

export function systemTestArtifactDir(runId: string, outDir?: string): string {
  assertRunId(runId);
  return outDir ? path.join(path.resolve(outDir), runId) : systemTestRunDir(runId);
}

export function saveSystemTestRun(run: StoredSystemTestRun): void {
  const dir = systemTestRunDir(run.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2), { mode: 0o600 });
}

export function loadSystemTestRun(runId: string): StoredSystemTestRun | null {
  const file = path.join(systemTestRunDir(runId), "run.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSystemTestRun>;
    if (
      value.schemaVersion !== 2 ||
      value.runId !== runId ||
      typeof value.evalRunId !== "string" ||
      typeof value.serverUrl !== "string" ||
      typeof value.sessionName !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.contextId !== "string" ||
      typeof value.subKey !== "string" ||
      typeof value.artifactDir !== "string" ||
      !path.isAbsolute(value.artifactDir) ||
      !value.config ||
      !Array.isArray(value.config.names)
    ) {
      throw new Error("invalid schema");
    }
    return value as StoredSystemTestRun;
  } catch (error) {
    throw new Error(
      `Could not read system-test run ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function listSystemTestRuns(): StoredSystemTestRun[] {
  const root = systemTestRunRoot();
  if (!fs.existsSync(root)) return [];
  const runs: StoredSystemTestRun[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!RUN_ID_PATTERN.test(entry)) continue;
    const run = loadSystemTestRun(entry);
    if (run) runs.push(run);
  }
  return runs.sort((left, right) => right.createdAt - left.createdAt);
}

export function writeSystemTestArtifact(
  runId: string,
  name: string,
  value: unknown,
  artifactDir?: string
): string {
  assertRunId(runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid system-test artifact name: ${name}`);
  }
  const dir = artifactDir ? path.resolve(artifactDir) : systemTestRunDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name.endsWith(".json") ? name : `${name}.json`);
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Read a CLI-owned JSON artifact without weakening the run directory's
 * restrictive permissions. Returns null when that artifact was never written
 * (for example, a still-running detached run). */
export function loadSystemTestArtifact(
  runId: string,
  name: string,
  artifactDir?: string
): unknown | null {
  assertRunId(runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid system-test artifact name: ${name}`);
  }
  const file = path.join(
    artifactDir ? path.resolve(artifactDir) : systemTestRunDir(runId),
    name.endsWith(".json") ? name : `${name}.json`
  );
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read system-test artifact ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid system-test run id: ${runId}`);
}
