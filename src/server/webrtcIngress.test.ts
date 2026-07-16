import { describe, expect, it } from "vitest";
import type { WebRtcAnswererPipe } from "@vibestudio/rpc/transports/webrtcAnswerer";
import type { RtcCandidateType } from "@vibestudio/rpc/transports/webrtcPeer";
import { startWebRtcIngress, type WebRtcIngress } from "./webrtcIngress.js";

interface FakePipe {
  pipe: WebRtcAnswererPipe;
  room: string;
  closed: boolean;
  closeCalls: number;
  connectPending: boolean;
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
    closeCalls: 0,
    connectPending: false,
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
      connect: () => {
        fake.connectPending = true;
        return new Promise<void>((_resolve, reject) => {
          rejectConnect = reject;
        }).finally(() => {
          fake.connectPending = false;
        });
      },
      status: () => status,
      close: async () => {
        fake.closed = true;
        fake.closeCalls += 1;
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

describe("startWebRtcIngress (the pool, plan §2.1)", () => {
  it("arms one pipe per room and attaches each to the rpc server", async () => {
    const { ingress, attached, pipes } = makeHarness();
    await Promise.all([
      ingress.armRoom("room-a", {}),
      ingress.armRoom("room-b", { deviceId: "dev_b" }),
      ingress.armRoom("room-c", {}),
    ]);

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
    await ingress.armRoom("room-a", {});
    // Redemption re-tags the SAME room with the device id — no new pipe.
    await ingress.armRoom("room-a", { deviceId: "dev_1" });
    await ingress.armRoom("room-a", { deviceId: "dev_1" });

    expect(pipes.size).toBe(1);
    expect(attached).toHaveLength(1);
    expect(ingress.status()).toEqual([
      { room: "room-a", status: "disconnected", deviceId: "dev_1", candidateType: null },
    ]);
  });

  it("refuses to arm rooms past the armed-room cap (DoS backstop), keeping existing rooms", async () => {
    const { ingress, warns } = makeHarness();
    const CAP = 4096; // matches MAX_ARMED_ROOMS
    await Promise.all(Array.from({ length: CAP }, (_, i) => ingress.armRoom(`room-${i}`, {})));
    expect(ingress.status()).toHaveLength(CAP);

    await expect(ingress.armRoom("one-too-many", {})).rejects.toThrow("armed-room cap");
    expect(ingress.status()).toHaveLength(CAP);
    expect(ingress.status().some((s) => s.room === "one-too-many")).toBe(false);
    expect(warns.some((w) => w.includes("armed-room cap"))).toBe(true);

    // Re-arming an ALREADY-armed room at the cap is still allowed (meta merge).
    await ingress.armRoom("room-0", { deviceId: "dev_0" });
    expect(ingress.status().find((s) => s.room === "room-0")?.deviceId).toBe("dev_0");

    await ingress.close();
  });

  it("disarmRoom closes the pipe and removes the room", async () => {
    const { ingress, attached, pipes } = makeHarness();
    await Promise.all([
      ingress.armRoom("room-a", {}),
      ingress.armRoom("room-b", { deviceId: "dev_b" }),
    ]);

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
    const armed = ingress.armRoom("room-slow", {});
    const disarmed = ingress.disarmRoom("room-slow");
    releasePipe!(fake.pipe);
    await expect(armed).rejects.toThrow("room was disarmed");
    await disarmed;

    expect(fake.closed).toBe(true);
    expect(attached).toHaveLength(0);
    expect(ingress.status()).toEqual([]);
  });

  it("close() closes every pipe, drains connect work, and refuses later arms", async () => {
    const { ingress, pipes } = makeHarness();
    await Promise.all([
      ingress.armRoom("room-a", {}),
      ingress.armRoom("room-b", { deviceId: "dev_b" }),
    ]);

    const firstClose = ingress.close();
    expect(ingress.close()).toBe(firstClose);
    await firstClose;
    expect([...pipes.values()].every((p) => p.closed)).toBe(true);
    expect([...pipes.values()].every((p) => !p.connectPending)).toBe(true);
    expect([...pipes.values()].every((p) => p.closeCalls === 1)).toBe(true);
    expect(ingress.status()).toEqual([]);

    await expect(ingress.armRoom("room-c", {})).rejects.toThrow("ingress is closed");
    expect(ingress.status()).toEqual([]);
  });

  it("disarmRoom drains signaling and detaches ingress telemetry", async () => {
    const { ingress, pipes } = makeHarness();
    await ingress.armRoom("room-a", { deviceId: "dev_a" });
    const pipe = pipes.get("room-a")!;
    pipe.emitCandidateType("host");
    expect(ingress.stats()).toEqual({ connects: 1, relayConnects: 0 });

    const firstDisarm = ingress.disarmRoom("room-a");
    expect(ingress.disarmRoom("room-a")).toBe(firstDisarm);
    await firstDisarm;
    expect(pipe.connectPending).toBe(false);
    expect(pipe.closeCalls).toBe(1);

    pipe.emitCandidateType("relay");
    expect(ingress.stats()).toEqual({ connects: 1, relayConnects: 0 });
  });

  it("a pipe-factory failure fails loud and leaves no ghost room", async () => {
    const { ingress, attached, logs } = makeHarness({
      createPipe: async () => {
        throw new Error("node-datachannel is not built");
      },
    });
    await expect(ingress.armRoom("room-a", {})).rejects.toThrow("node-datachannel is not built");
    expect(logs.some((line) => line.includes("failed to arm room room-a"))).toBe(true);
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

    const staleArm = ingress.armRoom("room-a", {});
    const disarmed = ingress.disarmRoom("room-a");
    const freshArm = ingress.armRoom("room-a", { deviceId: "dev-a" });

    rejectFirst(new Error("old create failed"));
    await expect(staleArm).rejects.toThrow("old create failed");
    await disarmed;
    await freshArm;

    expect(attached).toHaveLength(1);
    expect(ingress.status()).toEqual([
      { room: "room-a", status: "disconnected", deviceId: "dev-a", candidateType: null },
    ]);
  });

  // --- relay alarm telemetry (§9.8) -----------------------------------------

  it("status() surfaces each pipe's candidateType (null while no peer is up)", async () => {
    const { ingress, pipes } = makeHarness();
    await Promise.all([
      ingress.armRoom("room-a", { deviceId: "dev_a" }),
      ingress.armRoom("room-b", { deviceId: "dev_b" }),
    ]);

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
    await Promise.all([
      ingress.armRoom("room-a", { deviceId: "dev_a" }),
      ingress.armRoom("room-b", {}),
    ]);

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
    await ingress.armRoom("room-a", { deviceId: "dev_a" });
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
