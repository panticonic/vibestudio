import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { PAIRING_ROOM_PATTERN } from "@vibestudio/shared/connect";
import { DEVICE_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import { writeFileAtomicSync } from "../../atomicFile.js";

const room = z.string().regex(PAIRING_ROOM_PATTERN);

const DeviceRouteSchema = z
  .object({
    kind: z.literal("device"),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
    room,
  })
  .strict();

export const RoutedRoomRecordSchema = DeviceRouteSchema;

export type RoutedRoomRecord = z.infer<typeof RoutedRoomRecordSchema>;

interface RoutedRoomIngress {
  armRoom(room: string, meta: { deviceId: string }): Promise<void>;
  disarmRoom(room: string): Promise<void>;
}

const RoutedRoomStateSchema = z
  .object({
    schemaVersion: z.literal(3),
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
  return `device:${route.deviceId}`;
}

export function routedRoomStatePath(workspaceName: string): string {
  return workspaceReachPaths(workspaceName).routesFile;
}

/** Hub-owned reachability coordinates for one advertised workspace. */
export function workspaceReachPaths(workspaceName: string) {
  const webrtc = path.join(getWorkspaceDir(workspaceName), "reach", "webrtc");
  return {
    root: webrtc,
    identityFile: path.join(webrtc, "identity.pem"),
    routesFile: path.join(webrtc, "routes.json"),
  } as const;
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

  private commit(next: Map<string, RoutedRoomRecord>): void {
    const state = RoutedRoomStateSchema.parse({
      schemaVersion: 3,
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
  route: RoutedRoomRecord,
  ingress: RoutedRoomIngress
): Promise<void> {
  const key = routedRoomKey(route);
  const previous = store.get(key);

  await ingress.armRoom(route.room, { deviceId: route.deviceId });
  try {
    store.upsert(route);
  } catch (error) {
    await ingress.disarmRoom(route.room).catch(() => undefined);
    throw error;
  }

  if (previous && previous.room !== route.room) {
    await ingress.disarmRoom(previous.room);
  }
}
