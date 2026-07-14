import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeRpcTransport, RpcEnvelope } from "@vibestudio/rpc";
import { initRuntime } from "./initRuntime.js";
import { setStateArgs } from "../panel/stateArgs.js";
import { DEFAULT_THEME_CONFIG } from "../types.js";

const g = globalThis as typeof globalThis & {
  __vibestudioEntityId?: string;
  __vibestudioSlotId?: string;
  __vibestudioContextId?: string;
  __vibestudioKind?: "panel" | "shell";
  __vibestudioParentId?: string | null;
  __vibestudioParentEntityId?: string | null;
  __vibestudioInitialTheme?: "light" | "dark";
  __vibestudioGatewayConfig?: { serverUrl: string; token: string };
  __vibestudioEnv?: Record<string, string>;
  __vibestudioShell?: Record<string, unknown>;
  __vibestudioStateArgs?: Record<string, unknown>;
};

function createTransport(options?: {
  onSend?: (
    envelope: RpcEnvelope,
    deliver: (envelope: RpcEnvelope) => void
  ) => void | Promise<void>;
}): EnvelopeRpcTransport {
  let messageHandler: ((envelope: RpcEnvelope) => void) | null = null;
  return {
    send: vi.fn(async (envelope) => {
      if (
        envelope.target === "main" &&
        envelope.message.type === "request" &&
        envelope.message.method === "panel.getThemeConfig"
      ) {
        messageHandler?.(responseFor(envelope, DEFAULT_THEME_CONFIG));
        return;
      }
      await options?.onSend?.(envelope, (inboundEnvelope) => {
        messageHandler?.(inboundEnvelope);
      });
    }),
    onMessage: vi.fn((handler) => {
      messageHandler = handler;
      return vi.fn();
    }),
  };
}

function responseFor(envelope: RpcEnvelope, result: unknown): RpcEnvelope {
  if (envelope.message.type !== "request") {
    throw new Error("responseFor expects a request envelope");
  }
  return {
    from: envelope.target,
    target: envelope.from,
    delivery: { caller: { callerId: envelope.target, callerKind: "server" } },
    provenance: envelope.provenance,
    message: {
      type: "response",
      requestId: envelope.message.requestId,
      result,
    },
  };
}

function stubPanelWindow(): EventTarget & { __vibestudioStateArgs?: Record<string, unknown> } {
  const panelWindow = new EventTarget() as EventTarget & {
    __vibestudioStateArgs?: Record<string, unknown>;
  };
  vi.stubGlobal("window", panelWindow);
  if (typeof CustomEvent === "undefined") {
    vi.stubGlobal(
      "CustomEvent",
      class<T> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      }
    );
  }
  return panelWindow;
}

describe("initRuntime", () => {
  afterEach(() => {
    delete g.__vibestudioEntityId;
    delete g.__vibestudioSlotId;
    delete g.__vibestudioContextId;
    delete g.__vibestudioKind;
    delete g.__vibestudioParentId;
    delete g.__vibestudioParentEntityId;
    delete g.__vibestudioInitialTheme;
    delete g.__vibestudioGatewayConfig;
    delete g.__vibestudioEnv;
    delete g.__vibestudioShell;
    delete g.__vibestudioStateArgs;
    vi.unstubAllGlobals();
  });

  it("uses the injected canonical panel id as the RPC self id", () => {
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.entityId).toBe("panel:panel-1");
    expect(config.slotId).toBe("slot-1");
    expect(runtime.rpc.selfId).toBe("panel:panel-1");
  });

  it("preserves call delivery metadata through the runtime transport envelope", async () => {
    const sent: RpcEnvelope[] = [];
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sent.push(envelope);
            deliver(responseFor(envelope, "ok"));
          },
        }),
      fs: {} as never,
    });

    await expect(
      runtime.rpc.call("main", "fs.writeFile", ["/tmp/x", "y"], {
        idempotencyKey: "idem-1",
        readOnly: true,
      })
    ).resolves.toBe("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: "main",
      delivery: { idempotencyKey: "idem-1", readOnly: true },
      message: {
        type: "request",
        method: "fs.writeFile",
      },
    });
    expect(sent[0]!.message).not.toHaveProperty("idempotencyKey");
    expect(sent[0]!.message).not.toHaveProperty("readOnly");
  });

  it("uses the stable slot id and applies returned current-panel state args locally", async () => {
    const panelTreeSetStateArgsMock = vi.fn();
    const stateArgsChanged = vi.fn();
    const panelWindow = stubPanelWindow();
    g.__vibestudioEntityId = "panel:entity-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener("vibestudio:stateArgsChanged", stateArgsChanged);

    initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            panelTreeSetStateArgsMock(message.method, message.args);
            deliver(responseFor(envelope, { mode: "live", fromHost: true }));
          },
        }),
      fs: {} as never,
    });

    await setStateArgs({ mode: "live" });

    expect(panelTreeSetStateArgsMock).toHaveBeenCalledWith("panelTree.setStateArgs", [
      "slot-1",
      { mode: "live" },
    ]);
    expect(panelWindow.__vibestudioStateArgs).toEqual({ mode: "live", fromHost: true });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      mode: "live",
      fromHost: true,
    });
  });

  it("applies host-published state args for non-caller updates", () => {
    const panelWindow = stubPanelWindow();
    const stateArgsChanged = vi.fn();
    const shellListeners: Array<(event: string, payload: unknown) => void> = [];
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      addEventListener: vi.fn((listener: (event: string, payload: unknown) => void) => {
        shellListeners.push(listener);
        return 1;
      }),
      removeEventListener: vi.fn(),
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener("vibestudio:stateArgsChanged", stateArgsChanged);

    initRuntime({
      createTransport,
      fs: {} as never,
    });
    expect(shellListeners).toHaveLength(2);
    for (const listener of shellListeners) {
      listener("runtime:stateArgsChanged", { mode: "external" });
    }

    expect(panelWindow.__vibestudioStateArgs).toEqual({ mode: "external" });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      mode: "external",
    });
  });

  it("normalizes loopback gateway URLs to the panel page origin", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://localhost:3000");
    expect(config.gatewayConfig.aliases).toContain("http://127.0.0.1:3000");
  });

  it("does not normalize non-equivalent gateway origins", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__vibestudioEntityId = "panel:panel-1";
    g.__vibestudioSlotId = "slot-1";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:4000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://127.0.0.1:4000");
    expect(config.gatewayConfig.aliases).toBeUndefined();
  });

  it("uses the parent slot id for handle identity/control and the parent entity id for RPC", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioParentId = "parent-slot";
    g.__vibestudioParentEntityId = "panel:parent-entity";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            deliver(
              responseFor(envelope, { wsEndpoint: "ws://server/cdp/parent-slot", token: "t" })
            );
          },
        }),
      fs: {} as never,
    });

    expect(config.parentId).toBe("parent-slot");
    expect(config.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.parentId).toBe("parent-slot");
    expect(runtime.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.getParent()?.id).toBe("parent-slot");
    await expect(runtime.getParent()?.getInfo()).resolves.toMatchObject({
      id: "parent-slot",
      parentId: null,
    });

    await runtime.getParent()?.call["ping"]?.();
    await expect(runtime.getParent()?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/parent-slot",
      token: "t",
    });

    expect(sends).toEqual([
      { targetId: "panel:parent-entity", method: "ping", args: [] },
      { targetId: "main", method: "panelCdp.getCdpEndpoint", args: ["parent-slot"] },
    ]);
  });

  it("exposes full panelTree lifecycle and state operations on the unified parent handle", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioParentId = "parent-slot";
    g.__vibestudioParentEntityId = "panel:parent-entity";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            const result = (() => {
              switch (message.method) {
                case "panelTree.close":
                  return {
                    panelId: "parent-slot",
                    operation: "close",
                    status: "closed",
                    loaded: false,
                    rebuilt: false,
                    reloaded: false,
                  };
                case "panelTree.navigate":
                  return {
                    id: "parent-slot",
                    title: "Parent",
                    source: "panels/next",
                    kind: "workspace",
                    contextId: "ctx-next",
                  };
                case "panelTree.metadata":
                  return {
                    id: "parent-slot",
                    title: "Parent",
                    source: "panels/next",
                    kind: "workspace",
                    parentId: null,
                    contextId: "ctx-next",
                    runtimeEntityId: "panel:parent-entity",
                  };
                case "panelTree.setStateArgs":
                  return { mode: "fixture" };
                case "panelTree.list":
                  return [
                    {
                      panelId: "sibling-slot",
                      title: "Sibling",
                      source: "panels/sibling",
                      kind: "workspace",
                      parentId: "parent-slot",
                      contextId: "ctx-1",
                      runtimeEntityId: "panel:sibling-entity",
                    },
                  ];
                default:
                  return undefined;
              }
            })();
            deliver(responseFor(envelope, result));
          },
        }),
      fs: {} as never,
    });

    const parent = runtime.parent;
    await parent.close();
    await parent.navigate("panels/next", { contextId: "ctx-next" });
    await parent.stateArgs.set({ mode: "fixture" });
    const children = await parent.children();

    expect(children.map((child) => child.id)).toEqual(["sibling-slot"]);
    expect(sends).toEqual([
      { targetId: "main", method: "panelTree.close", args: ["parent-slot"] },
      {
        targetId: "main",
        method: "panelTree.navigate",
        args: ["parent-slot", "panels/next", { contextId: "ctx-next" }],
      },
      { targetId: "main", method: "panelTree.metadata", args: ["parent-slot"] },
      {
        targetId: "main",
        method: "panelTree.setStateArgs",
        args: ["parent-slot", { mode: "fixture" }],
      },
      { targetId: "main", method: "panelTree.list", args: ["parent-slot"] },
    ]);
  });

  it("launches workers through runtime.createEntity (server derives the parent)", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__vibestudioEntityId = "panel:child-entity";
    g.__vibestudioSlotId = "child-slot";
    g.__vibestudioContextId = "ctx-1";
    g.__vibestudioKind = "panel";
    g.__vibestudioGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__vibestudioShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            deliver(
              responseFor(envelope, {
                id: "worker:workers/agent:agent",
                kind: "worker",
                source: { repoPath: "workers/agent" },
                contextId: "ctx-1",
                targetId: "worker:workers/agent:agent",
              })
            );
          },
        }),
      fs: {} as never,
    });

    // The panel-side client no longer injects parent metadata — the worker entity
    // is created through the unified runtime path, where the SERVER derives the
    // launch parent from the verified caller.
    await runtime.callMain("runtime.createEntity", {
      kind: "worker",
      source: "workers/agent",
      key: "agent",
      contextId: "ctx-1",
    });

    expect(sends).toEqual([
      {
        targetId: "main",
        method: "runtime.createEntity",
        args: [
          {
            kind: "worker",
            source: "workers/agent",
            key: "agent",
            contextId: "ctx-1",
          },
        ],
      },
    ]);
  });
});
