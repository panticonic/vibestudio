import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import type {
  ClaudeCredentialState,
  MaterializedClaudeLaunch,
} from "@vibestudio/shared/claudeLaunchProfile";
import { parseOwnedProcessIdentity } from "@vibestudio/shared/ownedProcessIdentity";
import { z } from "zod";

export const MAX_HEADLESS_LOG_BYTES = 1_048_576;

const credentialStateSchema = z
  .object({
    hostPath: z.string().min(1),
    isolatedPath: z.string().min(1),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const materializationSchema = z
  .object({
    profileDir: z.string().min(1),
    logPath: z.string().min(1),
    credentialState: credentialStateSchema.nullable(),
  })
  .strict();

const processIdentitySchema = z
  .object({
    version: z.literal(1),
    platform: z.enum(["linux", "darwin"]),
    pid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    startCoordinate: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pid !== value.processGroupId) {
      context.addIssue({ code: "custom", message: "PID must equal process-group ID" });
    }
  });

export const claudeLaunchRecordSchema = z
  .object({
    version: z.literal(4),
    launchId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    ownerKind: z.enum(["external-cli", "extension-headless"]),
    phase: z.enum(["preparing", "active", "retiring", "released"]),
    agentId: z.string().min(1).nullable(),
    preparedAt: z.string().datetime(),
    releasedAt: z.string().datetime().optional(),
    materialization: materializationSchema.nullable(),
    process: processIdentitySchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.ownerKind === "external-cli" && (record.materialization || record.process)) {
      context.addIssue({
        code: "custom",
        message:
          "External CLI generations cannot claim extension-owned process or profile receipts",
      });
    }
    if (record.process && !record.materialization) {
      context.addIssue({ code: "custom", message: "A process receipt requires a materialization" });
    }
    if (record.process) {
      try {
        parseOwnedProcessIdentity(record.process);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

export type ClaudeLaunchRecord = z.infer<typeof claudeLaunchRecordSchema>;
export type ClaudeLaunchOwnerKind = ClaudeLaunchRecord["ownerKind"];

const version3LaunchRecordSchema = z
  .object({
    version: z.literal(3),
    launchId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    ownerKind: z.enum(["external-cli", "extension-headless"]),
    phase: z.enum(["preparing", "active", "retiring", "released"]),
    agentId: z.string().min(1).nullable(),
    preparedAt: z.string().datetime(),
    releasedAt: z.string().datetime().optional(),
    materialization: z
      .object({
        profileDir: z.string().min(1),
        logPath: z.string().min(1),
        broker: z.object({ socketPath: z.string().min(1), generation: z.string().min(1) }).strict(),
        credentialState: credentialStateSchema.nullable(),
      })
      .strict()
      .nullable(),
    process: processIdentitySchema.nullable(),
  })
  .strict();

const version2LaunchRecordSchema = z
  .object({
    version: z.literal(2),
    launchId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    vesselRef: z.string().min(1),
    ownerKind: z.enum(["external-cli", "extension-headless"]),
    phase: z.enum(["preparing", "active", "retiring", "released"]),
    agentId: z.string().min(1).nullable(),
    preparedAt: z.string().datetime(),
    releasedAt: z.string().datetime().optional(),
    materialization: z
      .object({
        profileDir: z.string().min(1),
        logPath: z.string().min(1),
        credentialState: credentialStateSchema.nullable(),
      })
      .strict()
      .nullable(),
    process: processIdentitySchema.nullable(),
  })
  .strict();

const legacyLaunchRecordSchema = z
  .object({
    launchId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    vesselRef: z.string().min(1),
    agentId: z.string().min(1).nullable(),
    preparedAt: z.string().datetime(),
  })
  .strict();

export function parseClaudeLaunchRecord(value: unknown, key: string): ClaudeLaunchRecord {
  const parsed = claudeLaunchRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const version3 = version3LaunchRecordSchema.safeParse(value);
  if (version3.success) {
    const materialization = version3.data.materialization;
    return claudeLaunchRecordSchema.parse({
      ...version3.data,
      version: 4,
      materialization: materialization
        ? {
            profileDir: materialization.profileDir,
            logPath: materialization.logPath,
            credentialState: materialization.credentialState,
          }
        : null,
    });
  }
  const version2 = version2LaunchRecordSchema.safeParse(value);
  if (version2.success) {
    const { vesselRef: _discardedVesselRef, materialization, ...record } = version2.data;
    return claudeLaunchRecordSchema.parse({
      ...record,
      version: 4,
      materialization,
    });
  }
  const legacy = legacyLaunchRecordSchema.safeParse(value);
  if (legacy.success) {
    const { vesselRef: _discardedVesselRef, ...record } = legacy.data;
    return {
      version: 4,
      ...record,
      ownerKind: "external-cli",
      phase: "active",
      materialization: null,
      process: null,
    };
  }
  throw Object.assign(new Error(`Corrupt Claude launch record ${key}: ${parsed.error.message}`), {
    code: "ECORRUPT",
  });
}

export function materializationReceipt(
  launch: MaterializedClaudeLaunch
): NonNullable<ClaudeLaunchRecord["materialization"]> {
  return {
    profileDir: launch.profileDir,
    logPath: path.join(launch.profileDir, "headless.log"),
    credentialState: launch.credentialState,
  };
}

export function recoverMaterializedLaunch(
  record: ClaudeLaunchRecord,
  profilesRoot: string
): Pick<MaterializedClaudeLaunch, "profileDir" | "credentialState"> | null {
  const receipt = record.materialization;
  if (!receipt) return null;
  if (record.ownerKind !== "extension-headless") {
    throw ownershipError("External CLI generation claimed a local materialization");
  }
  const root = path.resolve(profilesRoot);
  const profileDir = path.resolve(receipt.profileDir);
  const expectedPrefix = `${Buffer.from(record.launchId, "utf8").toString("base64url")}.`;
  if (
    path.dirname(profileDir) !== root ||
    !path.basename(profileDir).startsWith(expectedPrefix) ||
    path.resolve(receipt.logPath) !== path.join(profileDir, "headless.log")
  ) {
    throw ownershipError("Claude materialization receipt is outside its exact launch root");
  }
  const credentialState = receipt.credentialState;
  if (
    credentialState &&
    path.resolve(credentialState.isolatedPath) !==
      path.join(profileDir, "claude-config", ".credentials.json")
  ) {
    throw ownershipError("Claude isolated credential receipt is outside its exact profile");
  }
  return { profileDir, credentialState: credentialState as ClaudeCredentialState | null };
}

export interface BoundedLaunchLog {
  readonly path: string;
  close(): void;
}

/** Own both child output streams and retain only their most recent bounded tail. */
export function ownBoundedLaunchLog(
  child: ChildProcess,
  logPath: string,
  maxBytes = MAX_HEADLESS_LOG_BYTES
): BoundedLaunchLog {
  if (!child.stdout || !child.stderr) {
    throw ownershipError("Owned Claude process must expose stdout and stderr pipes");
  }
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const fd = openSync(logPath, "w", 0o600);
  let closed = false;
  const write = (chunk: Buffer | string) => {
    if (closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const current = fstatSync(fd).size;
    if (current + incoming.byteLength <= maxBytes) {
      writeSync(fd, incoming, 0, incoming.byteLength, current);
      return;
    }
    const retained = Buffer.alloc(Math.min(maxBytes, current + incoming.byteLength));
    const existingBytes = Math.min(current, Math.max(0, maxBytes - incoming.byteLength));
    if (existingBytes > 0) {
      readSync(fd, retained, 0, existingBytes, current - existingBytes);
    }
    const incomingTail = incoming.subarray(Math.max(0, incoming.byteLength - maxBytes));
    incomingTail.copy(retained, retained.byteLength - incomingTail.byteLength);
    ftruncateSync(fd, 0);
    writeSync(fd, retained, 0, retained.byteLength, 0);
  };
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  return {
    path: logPath,
    close() {
      if (closed) return;
      closed = true;
      child.stdout?.off("data", write);
      child.stderr?.off("data", write);
      closeSync(fd);
    },
  };
}

function ownershipError(message: string): Error {
  return Object.assign(new Error(message), { code: "EOWNERSHIP" });
}
