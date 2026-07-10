import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebRtcAnswererPipe } from "@vibestudio/rpc/transports/webrtcAnswerer";
import type { RtcCandidateType } from "@vibestudio/rpc/transports/webrtcPeer";
import { DeviceAuthStore } from "./services/deviceAuthStore.js";
import { startWebRtcIngress, type WebRtcIngress } from "./webrtcIngress.js";

interface FakePipe {
  pipe: WebRtcAnswererPipe;
  room: string;
  closed: boolean;
  setStatus(status: "connected" | "connecting" | "disconnected"): void;
  /** Simulate a pipe-up (hello complete) with the given selected path, or a
   * down (`null`) — the feed the pool's relay alarm rides. */
  emitCandidateType(type: RtcCandidateType | null): void;
}

function makeFakePipe(room: string): FakePipe {
  let status: "connected" | "connecting" | "disconnected" = "disconnected";
  let candidateType: RtcCandidateType | null = null;
  let rejectConnect: ((error: unknown) => void) | null = null;
  const candidateTypeHandlers = new Set<(type: RtcCandidateType | null) => void>();
  const fake: FakePipe = {
    room,
    closed: false,
    setStatus(next) {
      status = next;
    },
    emitCandidateType(type) {
      candidateType = type;
      status = type === null ? "disconnected" : "connected";
      for (const handler of candidateTypeHandlers) handler(type);
    },
    pipe: {
      // connect() resolves when a client completes hello and rejects only on
      // close() — the fake mirrors that: pending until close.
      connect: () =>
        new Promise<void>((_resolve, reject) => {
          rejectConnect = reject;
        }),
      status: () => status,
      close: async () => {
        fake.closed = true;
        rejectConnect?.(new Error("pipe closed"));
      },
      writeControl: async () => {},
      writeBulkFrame: async () => {},
      dropBulkStream: () => {},
      bulkPendingBytes: () => 0,
      controlBufferedAmount: () => 0,
      onControl: () => {},
      onBulkFrame: () => {},
      onDown: () => () => {},
      candidateType: () => candidateType,
      onCandidateType: (handler) => {
        candidateTypeHandlers.add(handler);
        return () => candidateTypeHandlers.delete(handler);
      },
    } as WebRtcAnswererPipe,
  };
  return fake;
}

function makeHarness(overrides?: { createPipe?: (room: string) => Promise<WebRtcAnswererPipe> }): {
  ingress: WebRtcIngress;
  attached: WebRtcAnswererPipe[];
  pipes: Map<string, FakePipe>;
  logs: string[];
  warns: string[];
} {
  const attached: WebRtcAnswererPipe[] = [];
  const pipes = new Map<string, FakePipe>();
  const logs: string[] = [];
  const warns: string[] = [];
  const ingress = startWebRtcIngress({
    rpcServer: { attachWebRtcPipe: (pipe) => attached.push(pipe) },
    signalUrl: "ws://127.0.0.1:8787",
    certificatePemFile: "/nonexistent/server.pem",
    keyPemFile: "/nonexistent/server.key",
    fingerprint: "AA".repeat(32),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    createPipe:
      overrides?.createPipe ??
      (async (room) => {
        const fake = makeFakePipe(room);
        pipes.set(room, fake);
        return fake.pipe;
      }),
  });
  return { ingress, attached, pipes, logs, warns };
}

const flush = async (): Promise<void> => {
  // Pipe creation is a resolved-promise chain; two microtask turns settle it.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("startWebRtcIngress (the pool, plan §2.1)", () => {
  it("arms one pipe per room and attaches each to the rpc server", async () => {
    const { ingress, attached, pipes } = makeHarness();
    ingress.armRoom("room-a", { inviteCode: "code-a" });
    ingress.armRoom("room-b", { deviceId: "dev_b" });
    ingress.armRoom("room-c", { inviteCode: "code-c" });
    await flush();

    expect(pipes.size).toBe(3);
    expect(attached).toHaveLength(3);
    expect(
      ingress
        .status()
        .map((s) => s.room)
        .sort()
    ).toEqual(["room-a", "room-b", "room-c"]);
    // Independent per-room status.
    pipes.get("room-b")!.setStatus("connected");
    const byRoom = new Map(ingress.status().map((s) => [s.room, s]));
    expect(byRoom.get("room-b")).toMatchObject({ status: "connected", deviceId: "dev_b" });
    expect(byRoom.get("room-a")).toMatchObject({ status: "disconnected" });
    expect(byRoom.get("room-a")!.deviceId).toBeUndefined();
  });

  it("armRoom is idempotent: re-arming only merges meta (invite → device re-tag)", async () => {
    const { ingress, attached, pipes } = makeHarness();
    ingress.armRoom("room-a", { inviteCode: "code-a" });
    await flush();
    // Redemption re-tags the SAME room with the device id — no new pipe.
    ingress.armRoom("room-a", { deviceId: "dev_1" });
    ingress.armRoom("room-a", { deviceId: "dev_1" });
    await flush();

    expect(pipes.size).toBe(1);
    expect(attached).toHaveLength(1);
    expect(ingress.status()).toEqual([
      { room: "room-a", status: "disconnected", deviceId: "dev_1", candidateType: null },
    ]);
  });

  it("refuses to arm rooms past the armed-room cap (DoS backstop), keeping existing rooms", async () => {
    const { ingress, warns } = makeHarness();
    const CAP = 4096; // matches MAX_ARMED_ROOMS
    for (let i = 0; i < CAP; i++) ingress.armRoom(`room-${i}`, { inviteCode: `c-${i}` });
    expect(ingress.status()).toHaveLength(CAP);

    ingress.armRoom("one-too-many", { inviteCode: "c-x" });
    expect(ingress.status()).toHaveLength(CAP);
    expect(ingress.status().some((s) => s.room === "one-too-many")).toBe(false);
    expect(warns.some((w) => w.includes("armed-room cap"))).toBe(true);

    // Re-arming an ALREADY-armed room at the cap is still allowed (meta merge).
    ingress.armRoom("room-0", { deviceId: "dev_0" });
    expect(ingress.status().find((s) => s.room === "room-0")?.deviceId).toBe("dev_0");

    await ingress.close();
  });

  it("disarmRoom closes the pipe and removes the room", async () => {
    const { ingress, attached, pipes } = makeHarness();
    ingress.armRoom("room-a", { inviteCode: "code-a" });
    ingress.armRoom("room-b", { deviceId: "dev_b" });
    await flush();

    await ingress.disarmRoom("room-a");
    expect(pipes.get("room-a")!.closed).toBe(true);
    expect(pipes.get("room-b")!.closed).toBe(false);
    expect(ingress.status().map((s) => s.room)).toEqual(["room-b"]);
    // Disarming an unknown room is a no-op.
    await ingress.disarmRoom("room-a");
    await ingress.disarmRoom("never-armed");
    expect(attached).toHaveLength(2);
  });

  it("disarming a room whose pipe is still being built closes it without attaching", async () => {
    let releasePipe: ((pipe: WebRtcAnswererPipe) => void) | null = null;
    const fake = makeFakePipe("room-slow");
    const { ingress, attached } = makeHarness({
      createPipe: () =>
        new Promise<WebRtcAnswererPipe>((resolve) => {
          releasePipe = resolve;
        }),
    });
    ingress.armRoom("room-slow", { inviteCode: "code" });
    const disarmed = ingress.disarmRoom("room-slow");
    releasePipe!(fake.pipe);
    await disarmed;

    expect(fake.closed).toBe(true);
    expect(attached).toHaveLength(0);
    expect(ingress.status()).toEqual([]);
  });

  it("close() closes every pipe and refuses later arms", async () => {
    const { ingress, pipes, logs } = makeHarness();
    ingress.armRoom("room-a", { inviteCode: "a" });
    ingress.armRoom("room-b", { deviceId: "dev_b" });
    await flush();

    await ingress.close();
    expect([...pipes.values()].every((p) => p.closed)).toBe(true);
    expect(ingress.status()).toEqual([]);

    ingress.armRoom("room-c", { inviteCode: "c" });
    await flush();
    expect(ingress.status()).toEqual([]);
    expect(logs.some((line) => line.includes("ingress is closed"))).toBe(true);
  });

  it("arms one room per stored device on startup (rooms persisted at redemption)", async () => {
    const storePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ingress-boot-")),
      "devices.json"
    );
    {
      const store = new DeviceAuthStore(storePath);
      store.completePairing({
        code: store.createPairingCode(60_000, { room: "room-dev-1" }),
        label: "Phone",
      });
      store.completePairing({
        code: store.createPairingCode(60_000, { room: "room-dev-2" }),
        label: "Tablet",
      });
      // Revoked devices must NOT be re-armed.
      const revoked = store.completePairing({
        code: store.createPairingCode(60_000, { room: "room-dev-3" }),
        label: "Old laptop",
      });
      store.revokeDevice(revoked.deviceId);
    }

    // Server restart: fresh store from disk, arm one room per live device —
    // the same loop src/server/index.ts runs after starting the pool.
    const reloaded = new DeviceAuthStore(storePath);
    const { ingress, attached } = makeHarness();
    for (const device of reloaded.listDevices()) {
      if (!device.revokedAt && device.room) {
        ingress.armRoom(device.room, { deviceId: device.deviceId });
      }
    }
    await flush();

    expect(attached).toHaveLength(2);
    expect(
      ingress
        .status()
        .map((s) => s.room)
        .sort()
    ).toEqual(["room-dev-1", "room-dev-2"]);
    expect(ingress.status().every((s) => s.deviceId?.startsWith("dev_"))).toBe(true);
  });

  it("a pipe-factory failure fails loud and leaves no ghost room", async () => {
    const { ingress, attached, logs } = makeHarness({
      createPipe: async () => {
        throw new Error("node-datachannel is not built");
      },
    });
    ingress.armRoom("room-a", { inviteCode: "a" });
    await vi.waitFor(() => {
      expect(logs.some((line) => line.includes("failed to arm room room-a"))).toBe(true);
    });
    expect(attached).toHaveLength(0);
    expect(ingress.status()).toEqual([]);
  });

  it("a stale pipe-factory failure does not delete a freshly re-armed room", async () => {
    let rejectFirst!: (error: Error) => void;
    let calls = 0;
    const { ingress, attached } = makeHarness({
      createPipe: (room) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<WebRtcAnswererPipe>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve(makeFakePipe(room).pipe);
      },
    });

    ingress.armRoom("room-a", { inviteCode: "a" });
    const disarmed = ingress.disarmRoom("room-a");
    ingress.armRoom("room-a", { deviceId: "dev-a" });
    await flush();

    rejectFirst(new Error("old create failed"));
    await disarmed;
    await flush();

    expect(attached).toHaveLength(1);
    expect(ingress.status()).toEqual([
      { room: "room-a", status: "disconnected", deviceId: "dev-a", candidateType: null },
    ]);
  });

  // --- relay alarm telemetry (§9.8) -----------------------------------------

  it("status() surfaces each pipe's candidateType (null while no peer is up)", async () => {
    const { ingress, pipes } = makeHarness();
    ingress.armRoom("room-a", { deviceId: "dev_a" });
    ingress.armRoom("room-b", { deviceId: "dev_b" });
    await flush();

    pipes.get("room-a")!.emitCandidateType("host");
    pipes.get("room-b")!.emitCandidateType("relay");
    let byRoom = new Map(ingress.status().map((s) => [s.room, s]));
    expect(byRoom.get("room-a")).toMatchObject({ status: "connected", candidateType: "host" });
    expect(byRoom.get("room-b")).toMatchObject({ status: "connected", candidateType: "relay" });

    // Pipe down → candidateType null again.
    pipes.get("room-b")!.emitCandidateType(null);
    byRoom = new Map(ingress.status().map((s) => [s.room, s]));
    expect(byRoom.get("room-b")).toMatchObject({ status: "disconnected", candidateType: null });
  });

  it("logs each connect's path and WARNS loudly when TURN relay engages", async () => {
    const { ingress, pipes, logs, warns } = makeHarness();
    ingress.armRoom("room-a", { deviceId: "dev_a" });
    ingress.armRoom("room-b", { inviteCode: "code-b" });
    await flush();

    pipes.get("room-a")!.emitCandidateType("host");
    expect(logs).toContain("room=room-a device=dev_a path=host");
    expect(warns).toEqual([]); // P2P path — no alarm

    pipes.get("room-b")!.emitCandidateType("relay");
    expect(logs).toContain("room=room-b path=relay");
    expect(warns).toEqual(["room=room-b: TURN relay engaged — P2P failed or forced"]);

    // A pipe-down (null) is not a connect — nothing new is logged or counted.
    const logCount = logs.length;
    pipes.get("room-a")!.emitCandidateType(null);
    expect(logs).toHaveLength(logCount);
    expect(ingress.stats()).toEqual({ connects: 2, relayConnects: 1 });
  });

  it("fires the aggregated relay-rate alarm ONCE when relay share exceeds 0.5 with >= 4 connects", async () => {
    const { ingress, pipes, warns } = makeHarness();
    ingress.armRoom("room-a", { deviceId: "dev_a" });
    await flush();
    const pipe = pipes.get("room-a")!;

    // 2 relay of 3 connects: rate > 0.5 but below the 4-connect floor — no alarm.
    pipe.emitCandidateType("relay");
    pipe.emitCandidateType(null);
    pipe.emitCandidateType("relay");
    pipe.emitCandidateType(null);
    pipe.emitCandidateType("host");
    pipe.emitCandidateType(null);
    expect(warns.filter((w) => w.includes("relay rate exceeds baseline"))).toHaveLength(0);

    // 4th connect over relay: 3/4 > 0.5 with >= 4 connects — the alarm fires…
    pipe.emitCandidateType("relay");
    const alarms = warns.filter((w) => w.includes("relay rate exceeds baseline"));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain("3/4");

    // …exactly once (no re-alarm on every subsequent relay connect).
    pipe.emitCandidateType(null);
    pipe.emitCandidateType("relay");
    expect(warns.filter((w) => w.includes("relay rate exceeds baseline"))).toHaveLength(1);
    expect(ingress.stats()).toEqual({ connects: 5, relayConnects: 4 });
  });
});
