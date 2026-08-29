import type { Connection } from "@number0/iroh";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePhysicalConnection } from "./nodePhysical.js";

describe("Node Iroh physical diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("samples only while subscribed and emits changed path/stat snapshots", async () => {
    vi.useFakeTimers();
    let transmittedBytes = 10;
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

    unsubscribe();
    transmittedBytes = 40;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(snapshots).toHaveLength(2);
  });
});
