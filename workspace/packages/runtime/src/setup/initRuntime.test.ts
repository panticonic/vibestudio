import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMessage, RpcTransport } from "@natstack/rpc";
import { initRuntime } from "./initRuntime.js";
import { setStateArgs } from "../panel/stateArgs.js";

const g = globalThis as typeof globalThis & {
  __natstackEntityId?: string;
  __natstackId?: string;
  __natstackSlotId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
  __natstackParentEntityId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGatewayConfig?: { serverUrl: string; token: string };
  __natstackEnv?: Record<string, string>;
  __natstackShell?: Record<string, unknown>;
};

function createTransport(options?: {
  onSend?: (
    targetId: string,
    message: RpcMessage,
    deliver: (sourceId: string, message: RpcMessage) => void
  ) => void | Promise<void>;
}): RpcTransport {
  let anyMessageHandler: ((sourceId: string, message: RpcMessage) => void) | null = null;
  return {
    send: vi.fn(async (targetId, message) => {
      await options?.onSend?.(targetId, message, (sourceId, inboundMessage) => {
        anyMessageHandler?.(sourceId, inboundMessage);
      });
    }),
    onMessage: vi.fn(() => vi.fn()),
    onAnyMessage: vi.fn((handler) => {
      anyMessageHandler = handler;
      return vi.fn();
    }),
  };
}

describe("initRuntime", () => {
  afterEach(() => {
    delete g.__natstackEntityId;
    delete g.__natstackId;
    delete g.__natstackSlotId;
    delete g.__natstackContextId;
    delete g.__natstackKind;
    delete g.__natstackParentId;
    delete g.__natstackParentEntityId;
    delete g.__natstackInitialTheme;
    delete g.__natstackGatewayConfig;
    delete g.__natstackEnv;
    delete g.__natstackShell;
  });

  it("uses the injected canonical panel id as the RPC self id", () => {
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.entityId).toBe("panel:panel-1");
    expect(config.id).toBe("panel:panel-1");
    expect(config.slotId).toBe("slot-1");
    expect(runtime.rpc.selfId).toBe("panel:panel-1");
  });

  it("uses the stable slot id for current-panel state args", async () => {
    const panelTreeSetStateArgsMock = vi.fn();
    g.__natstackEntityId = "panel:entity-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (_targetId, message, deliver) => {
            if (message.type !== "request") return;
            panelTreeSetStateArgsMock(message.method, message.args);
            deliver("main", {
              type: "response",
              requestId: message.requestId,
              result: undefined,
            });
          },
        }),
      fs: {} as never,
    });

    await setStateArgs({ mode: "live" });

    expect(panelTreeSetStateArgsMock).toHaveBeenCalledWith("panelTree.setStateArgs", [
      "slot-1",
      { mode: "live" },
    ]);
  });

  it("uses the parent slot id for handle identity/CDP and the parent entity id for RPC", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackParentId = "parent-slot";
    g.__natstackParentEntityId = "panel:parent-entity";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (targetId, message, deliver) => {
            if (message.type !== "request") return;
            sends.push({ targetId, method: message.method, args: message.args });
            deliver(targetId, {
              type: "response",
              requestId: message.requestId,
              result: { wsEndpoint: "ws://server/cdp/parent-slot", token: "t" },
            });
          },
        }),
      fs: {} as never,
    });

    expect(config.parentId).toBe("parent-slot");
    expect(config.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.parentId).toBe("parent-slot");
    expect(runtime.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.getParent()?.id).toBe("parent-slot");

    await runtime.getParent()?.call["ping"]?.();
    await runtime.getParent()?.cdp.getCdpEndpoint();

    expect(sends).toEqual([
      { targetId: "panel:parent-entity", method: "ping", args: [] },
      { targetId: "main", method: "panelCdp.getCdpEndpoint", args: ["parent-slot"] },
    ]);
  });

  it("exposes full panelTree lifecycle and state operations on the unified parent handle", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackParentId = "parent-slot";
    g.__natstackParentEntityId = "panel:parent-entity";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (targetId, message, deliver) => {
            if (message.type !== "request") return;
            sends.push({ targetId, method: message.method, args: message.args });
            deliver(targetId, {
              type: "response",
              requestId: message.requestId,
              result:
                message.method === "panelTree.list"
                  ? [
                      {
                        panelId: "sibling-slot",
                        title: "Sibling",
                        source: "panels/sibling",
                        kind: "workspace",
                        parentId: "parent-slot",
                        runtimeEntityId: "panel:sibling-entity",
                      },
                    ]
                  : undefined,
            });
          },
        }),
      fs: {} as never,
    });

    const parent = runtime.parent;
    await parent.close();
    await parent.stateArgs.set({ mode: "fixture" });
    const children = await parent.children();

    expect(children.map((child) => child.id)).toEqual(["sibling-slot"]);
    expect(sends).toEqual([
      { targetId: "main", method: "panelTree.close", args: ["parent-slot"] },
      {
        targetId: "main",
        method: "panelTree.setStateArgs",
        args: ["parent-slot", { mode: "fixture" }],
      },
      { targetId: "main", method: "panelTree.list", args: ["parent-slot"] },
    ]);
  });

  it("defaults panel-created workers to the current panel slot parent id", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (targetId, message, deliver) => {
            if (message.type !== "request") return;
            sends.push({ targetId, method: message.method, args: message.args });
            deliver(targetId, {
              type: "response",
              requestId: message.requestId,
              result: {
                name: "agent",
                source: "workers/agent",
                contextId: "ctx-1",
                callerId: "worker:agent",
                env: {},
                bindings: {},
                status: "running",
              },
            });
          },
        }),
      fs: {} as never,
    });

    await runtime.workers.create({ source: "workers/agent", contextId: "ctx-1" });

    expect(sends).toEqual([
      {
        targetId: "main",
        method: "workerd.createInstance",
        args: [
          {
            parentId: "child-slot",
            parentEntityId: "panel:child-entity",
            parentKind: "panel",
            source: "workers/agent",
            contextId: "ctx-1",
          },
        ],
      },
    ]);
  });
});
