import {
  EndpointGenerationOwner,
  IROH_REACH_VERSION,
  type IrohReach,
} from "@vibestudio/iroh-transport";
import type { IrohPhysicalConnection, IrohPhysicalEndpoint } from "@vibestudio/iroh-transport";
import type { NodePhysicalConnection, NodePhysicalEndpoint } from "@vibestudio/iroh-transport/node";
import { describe, expect, it, vi } from "vitest";
import { DesktopIrohConnectionSupervisor } from "./desktopIrohConnectionSupervisor.js";
import type { IrohServerClient } from "./irohServerClient.js";

const LOCAL_ID = "ab".repeat(32);
const HUB_ID = "01".repeat(32);
const WORKSPACE_ID = "02".repeat(32);
const relays = ["https://relay-one.example/", "https://relay-two.example/"] as const;

class FakeConnection implements IrohPhysicalConnection {
  readonly peerEndpointId = HUB_ID;
  openBi(): Promise<never> {
    throw new Error("not used");
  }
  acceptBi(): Promise<never> {
    throw new Error("not used");
  }
  close(): void {}
  closed(): Promise<string> {
    return Promise.resolve("closed");
  }
}

class FakeEndpoint implements IrohPhysicalEndpoint<FakeConnection> {
  readonly endpointId = LOCAL_ID;
  private rejectDial: ((error: Error) => void) | null = null;

  connect(): Promise<FakeConnection> {
    return new Promise((_resolve, reject) => {
      this.rejectDial = reject;
    });
  }
  accept(): Promise<null> {
    return Promise.resolve(null);
  }
  close(): Promise<void> {
    this.rejectDial?.(new Error("endpoint generation closed"));
    this.rejectDial = null;
    return Promise.resolve();
  }
}

function reach(endpointId: string): IrohReach {
  return { endpointId, relays, v: IROH_REACH_VERSION };
}

function fakeClient(
  invalidations: Array<{ generation: number; reason: string }>
): IrohServerClient {
  return {
    invalidateEndpointGeneration(generation: number, reason: string) {
      invalidations.push({ generation, reason });
    },
    exposeHostMethod: vi.fn(),
    call: vi.fn(),
    callTarget: vi.fn(),
    stream: vi.fn(),
    onDirectEvent: vi.fn(() => () => undefined),
    callAs: vi.fn(),
    sendAs: vi.fn(),
    streamAs: vi.fn(),
    addMessageListener: vi.fn(() => () => undefined),
    openPanelSession: vi.fn(),
    isConnected: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected"),
    transportDiagnostics: vi.fn(() => null),
    close: vi.fn(async () => undefined),
  } as unknown as IrohServerClient;
}

describe("desktop Iroh process connection supervisor", () => {
  it("invalidates hub and workspace clients on the same endpoint-generation edge", async () => {
    const endpoints: FakeEndpoint[] = [];
    const owner = new EndpointGenerationOwner({
      bind: async () => {
        const endpoint = new FakeEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
    });
    const invalidations = new Map<string, Array<{ generation: number; reason: string }>>([
      [HUB_ID, []],
      [WORKSPACE_ID, []],
    ]);
    const createClient = vi.fn(async (args: { reach: IrohReach }) =>
      fakeClient(invalidations.get(args.reach.endpointId)!)
    );
    const supervisor = new DesktopIrohConnectionSupervisor(new Uint8Array(32), relays, {
      endpointOwner: owner as unknown as EndpointGenerationOwner<
        NodePhysicalConnection,
        NodePhysicalEndpoint
      >,
      createClient: createClient as never,
    });
    await Promise.all([
      supervisor.connect(reach(HUB_ID), {
        callerId: "shell:device",
        getShellToken: () => "token",
      }),
      supervisor.connect(reach(WORKSPACE_ID), {
        callerId: "shell:device",
        getShellToken: () => "token",
      }),
    ]);

    await expect(
      owner.dial({ reach: reach(HUB_ID), overallDeadlineMs: 30, perAttemptDeadlineMs: 10 })
    ).rejects.toThrow(/Unable to reach/);

    expect(invalidations.get(HUB_ID)).toEqual([
      expect.objectContaining({ generation: 1, reason: expect.stringContaining("timed-out dial") }),
      expect.objectContaining({ generation: 2, reason: expect.stringContaining("timed-out dial") }),
    ]);
    expect(invalidations.get(WORKSPACE_ID)).toEqual(invalidations.get(HUB_ID));
    expect(endpoints).toHaveLength(3);
    await supervisor.close();
  });
});
