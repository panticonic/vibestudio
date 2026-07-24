import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { writeFileAtomicSync } from "../atomicFile.js";

const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface DevInstanceRecord {
  schemaVersion: 1;
  id: string;
  root: string;
  repoRoot: string;
  supervisorPid: number;
  kind: "desktop" | "server";
  lifecycle: "ephemeral" | "persistent";
  startedAt: number;
}

function canonicalRepoRoot(repoRoot: string): string {
  return fs.realpathSync(path.resolve(repoRoot));
}

function repoKey(repoRoot: string): string {
  return createHash("sha256").update(canonicalRepoRoot(repoRoot)).digest("hex").slice(0, 16);
}

function assertInstanceId(id: string): void {
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid instance id ${JSON.stringify(id)}; use lowercase letters, numbers, "-" or "_"`
    );
  }
}

function registryDir(repoRoot: string): string {
  return path.join(getProfileDataPath(), "dev-instances", repoKey(repoRoot));
}

function registryPath(repoRoot: string, id: string): string {
  assertInstanceId(id);
  return path.join(registryDir(repoRoot), `${id}.json`);
}

function registryLockPath(repoRoot: string, id: string): string {
  return `${registryPath(repoRoot, id)}.lock`;
}

export function persistentInstanceRoot(repoRoot: string, id: string): string {
  assertInstanceId(id);
  return path.join(getProfileDataPath(), "instance-state", repoKey(repoRoot), id);
}

export function createEphemeralInstanceRoot(id: string): string {
  assertInstanceId(id);
  return fs.mkdtempSync(path.join(os.tmpdir(), `vibestudio-${id}-`));
}

export function generatedInstanceId(kind: DevInstanceRecord["kind"]): string {
  return `${kind}-${randomBytes(4).toString("hex")}`;
}

export function registerDevInstance(
  input: Omit<DevInstanceRecord, "schemaVersion" | "repoRoot"> & { repoRoot: string }
): DevInstanceRecord {
  assertInstanceId(input.id);
  const record: DevInstanceRecord = {
    schemaVersion: 1,
    ...input,
    root: path.resolve(input.root),
    repoRoot: canonicalRepoRoot(input.repoRoot),
  };
  const lockPath = registryLockPath(record.repoRoot, record.id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${record.supervisorPid}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (!Number.isInteger(owner) || owner <= 0) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
        throw ownerError;
      }
      throw new Error(
        `Vibestudio instance ${JSON.stringify(record.id)} is already owned by supervisor PID ${owner}`
      );
    }
  }
  try {
    writeFileAtomicSync(
      registryPath(record.repoRoot, record.id),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 }
    );
  } catch (error) {
    fs.rmSync(lockPath, { force: true });
    throw error;
  }
  return record;
}

export function unregisterDevInstance(repoRoot: string, id: string): void {
  fs.rmSync(registryPath(repoRoot, id), { force: true });
  fs.rmSync(registryLockPath(repoRoot, id), { force: true });
}

export function resolveDevInstance(repoRoot: string, id: string): DevInstanceRecord {
  const file = registryPath(repoRoot, id);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Unknown Vibestudio instance ${JSON.stringify(id)} in this checkout. ` +
          "Use the id printed by pnpm dev or pnpm server:live."
      );
    }
    throw new Error(
      `Cannot read Vibestudio instance ${JSON.stringify(id)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Partial<DevInstanceRecord>).schemaVersion !== 1
  ) {
    throw new Error(`Vibestudio instance record ${file} has an unsupported schema`);
  }
  const record = value as Partial<DevInstanceRecord>;
  if (
    typeof record.id !== "string" ||
    record.id !== id ||
    typeof record.root !== "string" ||
    !path.isAbsolute(record.root) ||
    typeof record.repoRoot !== "string" ||
    record.repoRoot !== canonicalRepoRoot(repoRoot) ||
    typeof record.supervisorPid !== "number" ||
    !Number.isInteger(record.supervisorPid) ||
    record.supervisorPid <= 0 ||
    (record.kind !== "desktop" && record.kind !== "server") ||
    (record.lifecycle !== "ephemeral" && record.lifecycle !== "persistent") ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt)
  ) {
    throw new Error(`Vibestudio instance record ${file} is invalid`);
  }
  try {
    process.kill(record.supervisorPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new Error(
        `Vibestudio instance ${JSON.stringify(id)} is no longer running (stale record: ${file})`
      );
    }
    throw error;
  }
  return record as DevInstanceRecord;
}
