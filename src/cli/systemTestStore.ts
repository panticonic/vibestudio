import { gzipSync, gunzipSync, createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { writeFileAtomicSync } from "../atomicFile.js";

export interface StoredSystemTestRun {
  schemaVersion: 2;
  runId: string;
  createdAt: number;
  serverUrl: string;
  sessionName: string;
  ownerId: string;
  contextId: string;
  /** Durable test-record owner. Inspection calls this target directly and
   * never re-enters the completed test execution. */
  runnerEntityId: string;
  runnerTargetId: string;
  /** Absolute run-specific artifact directory. */
  artifactDir: string;
  config: {
    names: string[];
    category?: string;
    all: boolean;
    model?: string;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    concurrency: number;
    /** Explicit per-test deadline. Omitted runs have no per-test timeout. */
    testTimeoutMs?: number;
  };
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function systemTestRunRoot(): string {
  // Evidence outlives disposable dev instances and run ids are globally
  // unique, so concurrent instances safely share the profile artifact root.
  return path.join(getProfileDataPath(), "system-test-runs");
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
      typeof value.serverUrl !== "string" ||
      typeof value.sessionName !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.contextId !== "string" ||
      typeof value.runnerEntityId !== "string" ||
      typeof value.runnerTargetId !== "string" ||
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
  const rawFile = path.join(dir, name.endsWith(".json") ? name : `${name}.json`);
  const compressed = /^trajectory-.+-full(?:\.json)?$/u.test(name);
  const file = compressed ? `${rawFile}.gz` : rawFile;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileAtomicSync(file, compressed ? gzipSync(bytes) : bytes, { mode: 0o600 });
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
  const compressed = /^trajectory-.+-full(?:\.json)?$/u.test(name) && fs.existsSync(`${file}.gz`);
  if (!compressed && !fs.existsSync(file)) return null;
  try {
    const bytes = compressed
      ? gunzipSync(fs.readFileSync(`${file}.gz`)).toString("utf8")
      : fs.readFileSync(file, "utf8");
    return JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read system-test artifact ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid system-test run id: ${runId}`);
}

async function artifactDigest(file: string, compressed = false): Promise<string> {
  const hash = createHash("sha256");
  const sink = new Writable({
    write(chunk, _encoding, done) {
      hash.update(chunk);
      done();
    },
  });
  if (compressed) await pipeline(fs.createReadStream(file), createGunzip(), sink);
  else await pipeline(fs.createReadStream(file), sink);
  return hash.digest("hex");
}

/** Losslessly archive only completed CLI-owned default-root exports. Live and caller-supplied roots remain owned by their operations. */
export async function compactCompletedSystemTestTrajectories(
  options: { dryRun?: boolean } = {}
): Promise<{ files: number; originalBytes: number; compressedBytes: number }> {
  const result = { files: 0, originalBytes: 0, compressedBytes: 0 };
  for (const run of listSystemTestRuns()) {
    const dir = systemTestRunDir(run.runId);
    if (
      path.resolve(run.artifactDir) !== path.resolve(dir) ||
      !fs.existsSync(path.join(dir, "summary.json"))
    )
      continue;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^trajectory-.+-full\.json$/u.test(entry.name)) continue;
      const source = path.join(dir, entry.name);
      const before = await fs.promises.stat(source);
      result.files++;
      result.originalBytes += before.size;
      if (options.dryRun) continue;
      const target = `${source}.gz`;
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await pipeline(
          fs.createReadStream(source),
          createGzip(),
          fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 })
        );
        const handle = await fs.promises.open(temporary, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.promises.link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        // Never retire evidence until the published compressed representation is verified.
        if ((await artifactDigest(source)) !== (await artifactDigest(target, true))) {
          throw new Error(`Compressed system-test evidence differs from its source: ${source}`);
        }
        const after = await fs.promises.stat(source);
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        ) {
          throw new Error(`System-test evidence changed during archival: ${source}`);
        }
        result.compressedBytes += (await fs.promises.stat(target)).size;
        await fs.promises.unlink(source);
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
    }
  }
  return result;
}
