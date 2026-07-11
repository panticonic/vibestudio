import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { PAIRING_ROOM_PATTERN } from "@vibestudio/shared/connect";
import { DEVICE_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import { writeFileAtomicSync } from "../../atomicFile.js";

const USER_ID_PATTERN = /^usr_[A-Za-z0-9_-]{24}$/;
export const PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;

const room = z.string().regex(PAIRING_ROOM_PATTERN);

const DeviceRouteSchema = z
  .object({
    kind: z.literal("device"),
    purpose: z.enum(["control", "workspace"]),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
    room,
  })
  .strict();

const UserRouteSchema = z
  .object({
    kind: z.literal("user"),
    userId: z.string().regex(USER_ID_PATTERN),
    room,
  })
  .strict();

const InviteRouteSchema = z
  .object({
    kind: z.literal("invite"),
    codeHash: z.string().regex(PAIRING_CODE_HASH_PATTERN),
    room,
    expiresAt: z.number().int().positive(),
  })
  .strict();

export const RoutedRoomRecordSchema = z.discriminatedUnion("kind", [
  DeviceRouteSchema,
  UserRouteSchema,
  InviteRouteSchema,
]);

export type RoutedRoomRecord = z.infer<typeof RoutedRoomRecordSchema>;

interface RoutedRoomIngress {
  armRoom(room: string, meta: { deviceId?: string }): Promise<void>;
  disarmRoom(room: string): Promise<void>;
}

const RoutedRoomStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z.array(RoutedRoomRecordSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const keys = new Set<string>();
    const rooms = new Set<string>();
    for (const [index, route] of state.routes.entries()) {
      const key = routedRoomKey(route);
      if (keys.has(key)) {
        ctx.addIssue({ code: "custom", path: ["routes", index], message: `Duplicate ${key}` });
      }
      if (rooms.has(route.room)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", index, "room"],
          message: `Room ${route.room} is assigned more than once`,
        });
      }
      keys.add(key);
      rooms.add(route.room);
    }
  });

export function routedRoomKey(route: RoutedRoomRecord): string {
  switch (route.kind) {
    case "device":
      return `${route.purpose}:${route.deviceId}`;
    case "user":
      return `user:${route.userId}`;
    case "invite":
      return `invite:${route.codeHash}`;
  }
}

export function routedRoomStatePath(workspaceName: string): string {
  return path.join(getWorkspaceDir(workspaceName), "state", "webrtc", "routes.json");
}

/**
 * Exact, durable ownership record for a child runtime's signaling rooms.
 *
 * Mutations synchronously replace and fsync the complete state file. A process
 * crash therefore leaves either the previous complete route set or the next
 * complete route set, never a partial promotion that cannot be reconstructed
 * on restart. Room rotation may stage a new live ingress before committing it
 * so a failed arm can leave the previous durable route untouched.
 */
export class RoutedRoomStore {
  private readonly records = new Map<string, RoutedRoomRecord>();

  constructor(private readonly filePath: string) {
    if (!fs.existsSync(filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `Routed-room state at ${filePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const parsed = RoutedRoomStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Routed-room state at ${filePath} is not the canonical schema: ${parsed.error.message}`
      );
    }
    for (const route of parsed.data.routes) this.records.set(routedRoomKey(route), route);
  }

  list(): RoutedRoomRecord[] {
    return [...this.records.values()].sort((a, b) =>
      routedRoomKey(a).localeCompare(routedRoomKey(b))
    );
  }

  get(key: string): RoutedRoomRecord | null {
    return this.records.get(key) ?? null;
  }

  upsert(route: RoutedRoomRecord): void {
    const canonical = RoutedRoomRecordSchema.parse(route);
    const next = new Map(this.records);
    const key = routedRoomKey(canonical);
    for (const [otherKey, other] of next) {
      if (otherKey !== key && other.room === canonical.room) {
        throw new Error(`Room ${canonical.room} is already owned by ${otherKey}`);
      }
    }
    next.set(key, canonical);
    this.commit(next);
  }

  remove(key: string): RoutedRoomRecord | null {
    const existing = this.records.get(key);
    if (!existing) return null;
    const next = new Map(this.records);
    next.delete(key);
    this.commit(next);
    return existing;
  }

  /** Atomically replace an invite owner with the newly-issued device owner. */
  promoteInvite(
    codeHash: string,
    deviceId: string
  ): {
    route: Extract<RoutedRoomRecord, { kind: "device" }>;
    replacedDeviceRoute: Extract<RoutedRoomRecord, { kind: "device" }> | null;
  } {
    const inviteKey = `invite:${codeHash}`;
    const invite = this.records.get(inviteKey);
    if (!invite || invite.kind !== "invite") {
      throw new Error("The pairing invite route is no longer armed");
    }
    const deviceKey = `control:${deviceId}`;
    const prior = this.records.get(deviceKey);
    const next = new Map(this.records);
    next.delete(inviteKey);
    next.delete(deviceKey);
    const route = DeviceRouteSchema.parse({
      kind: "device",
      purpose: "control",
      deviceId,
      room: invite.room,
    });
    next.set(deviceKey, route);
    this.commit(next);
    return {
      route,
      replacedDeviceRoute: prior?.kind === "device" ? prior : null,
    };
  }

  private commit(next: Map<string, RoutedRoomRecord>): void {
    const state = RoutedRoomStateSchema.parse({
      schemaVersion: 1,
      routes: [...next.values()].sort((a, b) => routedRoomKey(a).localeCompare(routedRoomKey(b))),
    });
    writeFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    this.records.clear();
    for (const route of state.routes) this.records.set(routedRoomKey(route), route);
  }
}

/**
 * Replace a routed room without destroying the previous working route when
 * the replacement cannot be armed. The new room becomes durable and visible
 * only after its ingress is ready; the superseded room is disarmed last.
 */
export async function replaceRoutedRoom(
  store: RoutedRoomStore,
  liveRooms: Map<string, string>,
  route: RoutedRoomRecord,
  ingress: RoutedRoomIngress,
  meta: { deviceId?: string }
): Promise<void> {
  const key = routedRoomKey(route);
  const previous = store.get(key);

  await ingress.armRoom(route.room, meta);
  try {
    store.upsert(route);
    liveRooms.set(key, route.room);
  } catch (error) {
    await ingress.disarmRoom(route.room).catch(() => undefined);
    throw error;
  }

  if (previous && previous.room !== route.room) {
    await ingress.disarmRoom(previous.room);
  }
}
