// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MethodDefinition, PubSubClient } from "@workspace/pubsub";

const pubsubMock = vi.hoisted(() => ({
  connectViaRpc: vi.fn(),
}));

vi.mock("@workspace/pubsub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/pubsub")>()),
  connectViaRpc: pubsubMock.connectViaRpc,
}));

vi.mock("@workspace/tool-ui", () => ({
  useFeedbackManager: () => ({
    activeFeedbacks: new Map(),
    addFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    dismissFeedback: vi.fn(),
    handleFeedbackError: vi.fn(),
  }),
  useToolApproval: () => ({
    settings: {},
    setGlobalFloor: vi.fn(),
  }),
}));

import { useAgenticChat } from "./useAgenticChat";
import type { ChatContextValue, ConnectionConfig } from "../types";

function createClient(): PubSubClient & {
  updateChannelConfig: ReturnType<typeof vi.fn>;
} {
  return {
    clientId: "panel:chat",
    channelConfig: {},
    connected: false,
    ready: vi.fn(async () => undefined),
    onReady: vi.fn(() => () => undefined),
    close: vi.fn(),
    events: vi.fn(async function* () {}),
    onRoster: vi.fn(() => () => undefined),
    onReconnect: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getMessageTypes: vi.fn(async () => []),
    updateChannelConfig: vi.fn(async () => undefined),
  } as unknown as PubSubClient & { updateChannelConfig: ReturnType<typeof vi.fn> };
}

function Probe({
  config,
  onContext,
}: {
  config: ConnectionConfig;
  onContext?: (value: ChatContextValue) => void;
}) {
  const { contextValue } = useAgenticChat({
    config,
    channelName: "chat-title-test",
    metadata: { name: "Chat Panel", type: "panel", handle: "user" },
    sandbox: {
      rpc: config.rpc,
      loadImport: vi.fn(async () => ""),
    },
  });
  onContext?.(contextValue);
  return null;
}

describe("useAgenticChat set_title", () => {
  beforeEach(() => {
    document.title = "";
    pubsubMock.connectViaRpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the runtime RPC id, not the channel participant id, for browser handoff", async () => {
    const client = createClient();
    pubsubMock.connectViaRpc.mockReturnValue(client);
    const latestContext: { current: ChatContextValue | null } = { current: null };
    const config: ConnectionConfig = {
      clientId: "panel:slot-id",
      rpc: {
        selfId: "panel:runtime-entity",
        call: vi.fn(async () => undefined) as unknown as ConnectionConfig["rpc"]["call"],
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(
      <Probe
        config={config}
        onContext={(value) => {
          latestContext.current = value;
        }}
      />
    );

    await waitFor(() => {
      expect(latestContext.current?.selfId).toBe("panel:chat");
    });
    expect(latestContext.current?.browserHandoffCaller).toEqual({
      id: "panel:runtime-entity",
      kind: "panel",
    });
    expect(pubsubMock.connectViaRpc).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "panel:slot-id" })
    );

    unmount();
  });

  it("sets the calling panel title directly and preserves channel title metadata", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const call = vi.fn(async () => undefined) as unknown as ConnectionConfig["rpc"]["call"];
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(methods?.["set_title"]).toBeDefined();
    });

    const result = await methods!["set_title"]!.execute(
      { title: "Welcome to Vibez1" },
      {} as never
    );

    expect(result).toEqual({ ok: true });
    expect(document.title).toBe("Welcome to Vibez1");
    expect(config.rpc.call).toHaveBeenCalledWith("main", "runtime.setTitle", [
      "Welcome to Vibez1",
      { explicit: true },
    ]);
    expect(client.updateChannelConfig).toHaveBeenCalledWith({
      title: "Welcome to Vibez1",
      titleExplicit: false,
    });

    unmount();
  });

  it("reports a warning if the direct runtime title update fails", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.setTitle") {
        throw new Error("runtime unavailable");
      }
      return null;
    }) as unknown as ConnectionConfig["rpc"]["call"];
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(methods?.["set_title"]).toBeDefined();
    });

    const result = await methods!["set_title"]!.execute(
      { title: "Welcome to Vibez1" },
      {} as never
    );

    expect(result).toEqual({ ok: true, warnings: ["runtime unavailable"] });
    expect(client.updateChannelConfig).toHaveBeenCalledWith({
      title: "Welcome to Vibez1",
      titleExplicit: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "[useAgenticChat] runtime.setTitle failed:",
      expect.any(Error)
    );

    unmount();
  });
});
