import { describe, expect, it } from "vitest";
import { IROH_REACH_VERSION, type IrohReach } from "./reach.js";
import { dialOrderedRelays, OrderedRelayDialError } from "./relayDial.js";

const reach: IrohReach = {
  endpointId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  relays: [
    "https://relay-one.example/",
    "https://relay-two.example/",
    "https://relay-three.example/",
  ],
  v: IROH_REACH_VERSION,
};

describe("ordered Iroh relay dialing", () => {
  it("has exactly one in-flight attempt and advances in advertised order", async () => {
    const visited: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const result = await dialOrderedRelays({
      reach,
      deadlineMs: 1_000,
      async dial({ relayUrl }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        visited.push(relayUrl);
        await Promise.resolve();
        active -= 1;
        if (relayUrl !== reach.relays[2]) throw new Error("unreachable");
        return "connected";
      },
    });

    expect(result).toEqual({ value: "connected", relayUrl: reach.relays[2], attempts: 3 });
    expect(visited).toEqual(reach.relays);
    expect(maximumActive).toBe(1);
  });

  it("uses the last successful relay as a hint without mutating durable reach", async () => {
    const before = [...reach.relays];
    const visited: string[] = [];
    await dialOrderedRelays({
      reach,
      preferredRelay: reach.relays[1],
      deadlineMs: 1_000,
      async dial({ relayUrl }) {
        visited.push(relayUrl);
        return relayUrl;
      },
    });
    expect(visited).toEqual([reach.relays[1]]);
    expect(reach.relays).toEqual(before);
  });

  it("applies one overall deadline across every relay", async () => {
    const started: string[] = [];
    await expect(
      dialOrderedRelays({
        reach,
        deadlineMs: 25,
        async dial({ relayUrl, signal }) {
          started.push(relayUrl);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return "unreachable";
        },
      })
    ).rejects.toBeInstanceOf(OrderedRelayDialError);
    expect(started).toEqual([reach.relays[0]]);
  });
});
