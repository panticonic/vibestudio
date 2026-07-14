import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState } from "./state";
import { SessionController } from "./sessionController";

const pubsubMocks = vi.hoisted(() => {
  const client = {
    ready: vi.fn<() => Promise<void>>(async () => {}),
    onRoster: vi.fn<(listener: (roster: unknown) => void) => () => void>(() => () => {}),
    events: vi.fn(async function* () {}),
    close: vi.fn(),
    roster: {} as Record<string, { id: string; metadata: { handle?: string; type?: string } }>,
  };
  return {
    client,
    connectViaRpc: vi.fn(() => client),
  };
});

const bootstrapMocks = vi.hoisted(() => ({
  createAndSubscribeAgent: vi.fn(async () => undefined),
  getChannelDOParticipants: vi.fn<
    () => Promise<Array<{ source: string; className: string; objectKey: string }>>
  >(async () => []),
  listAvailableAgents: vi.fn(async () => []),
  newAgentKey: vi.fn((handle: string) => `agent:${handle}`),
  newChannelName: vi.fn(() => "new-channel"),
  unsubscribeDOFromChannel: vi.fn(),
}));

vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: pubsubMocks.connectViaRpc,
}));

vi.mock("@workspace/runtime", () => ({
  rpc: {},
  panel: {
    slotId: "panel:slot-test",
    stateArgs: { set: vi.fn() },
  },
}));
vi.mock("@workspace/runtime/internal/diagnostics", () => ({
  recoveryCoordinator: {},
}));

vi.mock("../messages/register", () => ({
  registerSpectroliteMessageTypes: vi.fn(async () => undefined),
}));

vi.mock("../bootstrap", () => ({
  createAndSubscribeAgent: bootstrapMocks.createAndSubscribeAgent,
  getChannelDOParticipants: bootstrapMocks.getChannelDOParticipants,
  listAvailableAgents: bootstrapMocks.listAvailableAgents,
  newAgentKey: bootstrapMocks.newAgentKey,
  newChannelName: bootstrapMocks.newChannelName,
  unsubscribeDOFromChannel: bootstrapMocks.unsubscribeDOFromChannel,
}));

describe("SessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapMocks.getChannelDOParticipants.mockResolvedValue([]);
    bootstrapMocks.createAndSubscribeAgent.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rehydrates persisted agents after selecting a vault from the picker", async () => {
    const store = createStore(
      initialState({
        contextId: "ctx",
        channelName: "chan",
        repoRoot: null,
        openPath: null,
        installedAgents: [
          {
            agentId: "SilentAgentWorker",
            handle: "scribe",
            key: "agent:scribe",
            source: "workers/silent-agent-worker",
            className: "SilentAgentWorker",
          },
        ],
      })
    );
    const session = new SessionController(store);

    await session.start();
    expect(pubsubMocks.connectViaRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "panel:slot-test",
        channelCreation: {
          governance: "standard",
          contextBinding: { kind: "context", contextId: "ctx" },
          origin: { kind: "spectrolite-panel" },
          admission: { kind: "workspace-members" },
          presentationEditors: { kind: "workspace-members" },
          presentation: { title: "Spectrolite" },
        },
      })
    );
    expect(bootstrapMocks.createAndSubscribeAgent).not.toHaveBeenCalled();

    store.setState({ repoRoot: "/projects/default" });
    session.onVaultSelected("/projects/default");
    await vi.waitFor(() => {
      expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(1);
    });
    expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:scribe",
        channelId: "chan",
        channelContextId: "ctx",
        replay: true,
      })
    );
  });

  it("waits for durable channel creation before subscribing resident agents", async () => {
    let resolveReady!: () => void;
    pubsubMocks.client.ready.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        })
    );
    const store = createStore(
      initialState({
        contextId: "ctx",
        channelName: "chan",
        repoRoot: "/projects/default",
        openPath: null,
        installedAgents: [],
      })
    );
    const session = new SessionController(store);

    const starting = session.start();
    await vi.waitFor(() => expect(pubsubMocks.client.ready).toHaveBeenCalledOnce());
    expect(bootstrapMocks.createAndSubscribeAgent).not.toHaveBeenCalled();

    resolveReady();
    await starting;
    expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledOnce();
  });

  it("retries failed rehydration with backoff", async () => {
    vi.useFakeTimers();
    const store = createStore(
      initialState({
        contextId: "ctx",
        channelName: "chan",
        repoRoot: "/projects/default",
        openPath: null,
        installedAgents: [
          {
            agentId: "SilentAgentWorker",
            handle: "scribe",
            key: "agent:scribe",
            source: "workers/silent-agent-worker",
            className: "SilentAgentWorker",
          },
        ],
      })
    );
    bootstrapMocks.createAndSubscribeAgent
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const session = new SessionController(store);

    await session.start();
    expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps an agent hidden when roster snapshots flicker during unsubscribe", async () => {
    let resolveUnsubscribe!: () => void;
    bootstrapMocks.unsubscribeDOFromChannel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve;
        })
    );
    bootstrapMocks.getChannelDOParticipants.mockResolvedValue([
      {
        source: "workers/test-agent",
        className: "TestAgentWorker",
        objectKey: "agent:helper",
      },
    ]);
    const store = createStore(
      initialState({
        contextId: "ctx",
        channelName: "chan",
        repoRoot: "/projects/default",
        openPath: null,
        installedAgents: [
          {
            agentId: "TestAgentWorker",
            handle: "helper",
            key: "agent:helper",
            source: "workers/test-agent",
            className: "TestAgentWorker",
          },
        ],
      })
    );
    store.setState({ roster: [{ handle: "helper", status: "live" }] });
    const session = new SessionController(store);
    await session.start();
    const rosterChanged = pubsubMocks.client.onRoster.mock.calls[0]![0];

    const removing = session.removeAgent("helper");
    await vi.waitFor(() => expect(bootstrapMocks.unsubscribeDOFromChannel).toHaveBeenCalledOnce());
    expect(store.getState().removedHandles).toEqual(["helper"]);

    // The channel may briefly omit the participant, then replay a stale live
    // roster before unsubscribe acknowledges. Neither snapshot may resurrect
    // the optimistic row.
    pubsubMocks.client.roster = {};
    rosterChanged(undefined);
    pubsubMocks.client.roster = {
      stale: { id: "stale", metadata: { handle: "helper", type: "agent" } },
    };
    rosterChanged(undefined);
    expect(store.getState().removedHandles).toEqual(["helper"]);

    resolveUnsubscribe();
    await removing;
    expect(store.getState().removedHandles).toEqual(["helper"]);

    pubsubMocks.client.roster = {};
    rosterChanged(undefined);
    expect(store.getState().removedHandles).toEqual([]);
    expect(store.getState().installedAgents).toEqual([]);
  });
});
