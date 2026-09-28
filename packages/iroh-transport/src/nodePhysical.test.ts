import type { Connection, Endpoint } from "@number0/iroh";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePhysicalConnection, NodePhysicalEndpoint } from "./nodePhysical.js";

describe("Node Iroh physical diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("advertises the current native home before configured fallback relays", () => {
    const relays = ["https://us.example/", "https://eu.example/"];
    let home: string | null = relays[1]!;
    const endpoint = new NodePhysicalEndpoint({
      id: () => ({ toString: () => "a".repeat(64) }),
      addr: () => ({ relayUrl: () => home }),
    } as unknown as Endpoint);
    expect(endpoint.reach(relays)).toEqual({
      endpointId: "a".repeat(64),
      v: 5,
      relays: [relays[1], relays[0]],
    });
    home = relays[0]!;
    expect(endpoint.reach(relays).relays).toEqual(relays);
    home = "https://unconfigured.example/";
    expect(endpoint.reach(relays).relays).toEqual(relays);
    home = null;
    expect(endpoint.reach(relays).relays).toEqual(relays);
    expect(relays).toEqual(["https://us.example/", "https://eu.example/"]);
  });

  it("samples only while subscribed and emits changed path/stat snapshots", async () => {
    vi.useFakeTimers();
    let transmittedBytes = 10;
    let lostPackets = 0;
    const native = {
      remoteId: () => ({ toString: () => "peer-endpoint" }),
      rtt: () => 12,
      stats: () => ({
        udpTxDatagrams: 1,
        udpTxBytes: transmittedBytes,
        udpRxDatagrams: 1,
        udpRxBytes: 20,
        lostPackets: 0,
        lostBytes: 0,
      }),
      paths: () => [
        {
          isSelected: true,
          isRelay: true,
          remoteAddr: "relay.example:443",
          rttMs: 12,
          stats: {
            udpTxDatagrams: 1,
            udpTxBytes: transmittedBytes,
            udpRxDatagrams: 1,
            udpRxBytes: 20,
            cwnd: 12000,
            congestionEvents: 0,
            lostPackets,
            lostBytes: 0,
            currentMtu: 1200,
          },
        },
      ],
      closed: () => new Promise<string>(() => undefined),
    } as unknown as Connection;
    const connection = new NodePhysicalConnection(native);
    const snapshots: ReturnType<NodePhysicalConnection["diagnostics"]>[] = [];
    const unsubscribe = connection.onDiagnosticsChange((snapshot) => snapshots.push(snapshot));

    expect(snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshots).toHaveLength(1);

    transmittedBytes = 30;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ transmittedBytes: 30, rttMs: 12 });

    // Congestion may change while the selected address and top-level byte
    // counters stay fixed. That still needs to reach an active profiler.
    lostPackets = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]?.paths[0]?.stats).toMatchObject({
      lostPackets: 2,
      currentMtu: 1200,
      cwnd: 12000,
    });

    unsubscribe();
    transmittedBytes = 40;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(snapshots).toHaveLength(3);
  });
});

describe("Node Iroh physical ingress", () => {
  it.each(["accept", "connect"] as const)(
    "keeps listening when one incoming handshake fails during %s",
    async (failureStage) => {
      const failedAccepting = {
        connect: vi.fn(async () => {
          throw new Error("timed out");
        }),
      };
      const failedIncoming = {
        accept: vi.fn(async () => {
          if (failureStage === "accept") throw new Error("timed out");
          return failedAccepting;
        }),
      };
      const connection = {
        remoteId: () => ({ toString: () => "peer-endpoint" }),
        setMaxConcurrentBiStreams: vi.fn(),
        setMaxConcurrentUniStreams: vi.fn(),
      } as unknown as Connection;
      const acceptedIncoming = {
        accept: vi.fn(async () => ({ connect: vi.fn(async () => connection) })),
      };
      const native = {
        id: () => ({ toString: () => "server-endpoint" }),
        acceptNext: vi
          .fn()
          .mockResolvedValueOnce(failedIncoming)
          .mockResolvedValueOnce(acceptedIncoming),
      } as unknown as Endpoint;

      const endpoint = new NodePhysicalEndpoint(native);
      const accepted = await endpoint.accept();

      expect(native.acceptNext).toHaveBeenCalledTimes(2);
      expect(accepted?.peerEndpointId).toBe("peer-endpoint");
    }
  );
});
