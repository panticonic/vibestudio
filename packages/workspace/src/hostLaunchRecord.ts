import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const WORKSPACE_HOST_LAUNCH_RECORD = "host-launch.json";

export const WorkspaceHostLaunchRecordSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    systemEpoch: z.number().int().nonnegative(),
    stateHash: z.string().regex(/^state:[0-9a-f]{64}$/u),
    publicationId: z.string().min(1),
  })
  .strict();

export type WorkspaceHostLaunchRecord = z.infer<typeof WorkspaceHostLaunchRecordSchema>;

export function assertWorkspaceHostLaunchBinding(
  record: WorkspaceHostLaunchRecord,
  active: {
    workspaceId: string;
    stateHash: string;
    publicationId: string | null;
    manifestEpoch: number;
    hostEpoch: number;
  }
): void {
  if (
    record.workspaceId !== active.workspaceId ||
    record.stateHash !== active.stateHash ||
    record.publicationId !== active.publicationId
  ) {
    throw new Error("Workspace host launch record does not bind the current protected main");
  }
  if (record.systemEpoch !== active.manifestEpoch || active.manifestEpoch !== active.hostEpoch) {
    throw new Error(
      `Workspace launch epoch ${record.systemEpoch}, manifest epoch ${active.manifestEpoch}, and host epoch ${active.hostEpoch} must match`
    );
  }
}

export function workspaceHostLaunchRecordPath(statePath: string): string {
  return path.join(statePath, WORKSPACE_HOST_LAUNCH_RECORD);
}

export function readWorkspaceHostLaunchRecord(statePath: string): WorkspaceHostLaunchRecord | null {
  const filePath = workspaceHostLaunchRecordPath(statePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    return WorkspaceHostLaunchRecordSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Invalid workspace host launch record at ${filePath}`, { cause: error });
  }
}

export function writeWorkspaceHostLaunchRecord(
  statePath: string,
  input: WorkspaceHostLaunchRecord
): void {
  const record = WorkspaceHostLaunchRecordSchema.parse(input);
  fs.mkdirSync(statePath, { recursive: true, mode: 0o700 });
  const destination = workspaceHostLaunchRecordPath(statePath);
  const temporary = path.join(
    statePath,
    `.${WORKSPACE_HOST_LAUNCH_RECORD}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, destination);
  } finally {
    try {
      fs.rmSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
