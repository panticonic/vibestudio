import { describe, expect, it } from "vitest";
import { EndpointGenerationOwner } from "./endpointGeneration.js";
import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "./physical.js";
import { IROH_REACH_VERSION, type IrohReach } from "./reach.js";

const PEER_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCAL_ID = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const OTHER_PEER_ID = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const reach: IrohReach = {
  endpointId: PEER_ID,
  relays: ["https://relay-one.example/", "https://relay-two.example/"],
  v: IROH_REACH_VERSION,
};

class FakeConnection implements IrohPhysicalConnection {
  readonly peerEndpointId = PEER_ID;
  closedReason = "";

  close(_code: bigint, reason: Uint8Array): void {
    this.closedReason = new TextDecoder().decode(reason);
  }

  async closed(): Promise<string> {
    return this.closedReason;
  }

  async openBi(): Promise<never> {
    throw new Error("not used");
  }

  async acceptBi(): Promise<never> {
    throw new Error("not used");
  }
}

class FakeEndpoint implements IrohPhysicalEndpoint<FakeConnection> {
  readonly endpointId = LOCAL_ID;
  readonly attempts: string[] = [];
  closed = false;
  private hangingReject: ((error: Error) => void) | null = null;

  async connect(_reach: IrohReach, relayUrl: string): Promise<FakeConnection> {
    this.attempts.push(relayUrl);
    if (relayUrl === reach.relays[0]) {
      return await new Promise<FakeConnection>((_resolve, reject) => {
        this.hangingReject = reject;
      });
    }
    return new FakeConnection();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.hangingReject?.(new Error("endpoint generation closed"));
    this.hangingReject = null;
  }

  async accept(): Promise<null> {
    return null;
  }
}

class FakeBinding implements IrohEndpointBinding<FakeConnection, FakeEndpoint> {
  readonly endpoints: FakeEndpoint[] = [];

  async bind(): Promise<FakeEndpoint> {
    const endpoint = new FakeEndpoint();
    this.endpoints.push(endpoint);
    return endpoint;
  }
}

describe("endpoint generation owner", () => {
  it("closes a timed-out generation before attempting the next relay", async () => {
    const binding = new FakeBinding();
    const owner = new EndpointGenerationOwner(binding);
    const generations: number[] = [];
    owner.onGeneration(({ generation }) => generations.push(generation));

    const result = await owner.dial({
      reach,
      overallDeadlineMs: 1_000,
      perAttemptDeadlineMs: 10,
    });

    expect(result).toMatchObject({ relayUrl: reach.relays[1], attempts: 2, generation: 2 });
    expect(binding.endpoints).toHaveLength(2);
    expect(binding.endpoints[0]?.closed).toBe(true);
    expect(binding.endpoints[0]?.attempts).toEqual([reach.relays[0]]);
    expect(binding.endpoints[1]?.attempts).toEqual([reach.relays[1]]);
    expect(generations).toEqual([1, 2]);
    await owner.close();
  });

  it("single-flights concurrent dial operations", async () => {
    const active: number[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const endpoint: IrohPhysicalEndpoint<FakeConnection> = {
      endpointId: LOCAL_ID,
      async connect() {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        active.push(inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return new FakeConnection();
      },
      async close() {},
      async accept() {
        return null;
      },
    };
    const owner = new EndpointGenerationOwner({
      async bind() {
        return endpoint;
      },
    });
    await Promise.all([
      owner.dial({ reach, overallDeadlineMs: 1_000, perAttemptDeadlineMs: 500 }),
      owner.dial({ reach, overallDeadlineMs: 1_000, perAttemptDeadlineMs: 500 }),
    ]);
    expect(active).toEqual([1, 1]);
    expect(maximumInFlight).toBe(1);
    await owner.close();
  });

  it("reuses the last successful relay across peers sharing one endpoint", async () => {
    const binding = new FakeBinding();
    const owner = new EndpointGenerationOwner(binding);

    const hub = await owner.dial({
      reach,
      overallDeadlineMs: 1_000,
      perAttemptDeadlineMs: 10,
    });
    expect(hub).toMatchObject({ relayUrl: reach.relays[1], attempts: 2, generation: 2 });

    const workspace = await owner.dial({
      reach: { ...reach, endpointId: OTHER_PEER_ID },
      overallDeadlineMs: 1_000,
      perAttemptDeadlineMs: 10,
    });

    expect(workspace).toMatchObject({
      relayUrl: reach.relays[1],
      attempts: 1,
      generation: 2,
    });
    expect(binding.endpoints).toHaveLength(2);
    expect(binding.endpoints[1]?.closed).toBe(false);
    expect(binding.endpoints[1]?.attempts).toEqual([reach.relays[1], reach.relays[1]]);
    await owner.close();
  });

  it("fails loud if a rebind changes the durable endpoint identity", async () => {
    const first = new FakeEndpoint();
    const second = Object.assign(new FakeEndpoint(), { endpointId: PEER_ID });
    let binds = 0;
    const owner = new EndpointGenerationOwner({
      async bind() {
        binds += 1;
        return binds === 1 ? first : second;
      },
    });
    await expect(
      owner.dial({ reach, overallDeadlineMs: 1_000, perAttemptDeadlineMs: 10 })
    ).rejects.toThrow(/endpoint identity changed across generations/);
    expect(second.closed).toBe(true);
    await owner.close();
  });
});
