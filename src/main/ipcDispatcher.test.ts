import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCodeIdentity,
} from "@vibestudio/shared/serviceDispatcher";
import type { RpcEnvelope, RpcMessage } from "@vibestudio/rpc";
import { IpcDispatcher } from "./ipcDispatcher.js";

const ipcHandlers = new Map<string, (...args: never[]) => void>();
const ipcInvokeHandlers = new Map<string, (...args: never[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: never[]) => void) => {
      ipcHandlers.set(channel, handler);
    }),
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      ipcInvokeHandlers.set(channel, handler);
    }),
  },
}));

function makeWebContents(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn(),
  };
}

function rpcEnvelope(
  from: string,
  callerKind: "server" | "shell" | "app" | "panel" | "unknown",
  message: RpcMessage,
  delivery?: Pick<RpcEnvelope["delivery"], "idempotencyKey" | "readOnly">,
  target = "main"
): RpcEnvelope {
  const caller = { callerId: from, callerKind };
  return {
    from,
    target,
    delivery: { caller, ...delivery },
    provenance: [caller],
    message,
  };
}

function expectSentRpcMessage(
  wc: ReturnType<typeof makeWebContents>,
  target: string,
  message: RpcMessage
): void {
  expect(wc.send).toHaveBeenCalledWith(
    "vibestudio:rpc:message",
    expect.objectContaining({
      from: "main",
      target,
      message,
    })
  );
}

function makeDispatcher(opts: {
  resolve: (
    webContentsId: number
  ) => { callerId: string; callerKind: "shell" | "panel" | "app" } | null;
  getCodeIdentityForCaller?: (callerId: string) => VerifiedCodeIdentity | null;
  getWebContentsForCaller?: (callerId: string) => ReturnType<typeof makeWebContents> | null;
  call?: ReturnType<typeof vi.fn>;
  callAs?: ReturnType<typeof vi.fn>;
  addMessageListener?: ReturnType<typeof vi.fn>;
  configureDispatcher?: (dispatcher: ServiceDispatcher) => void;
  authorizeAppServerCall?: (
    callerId: string,
    service: string,
    method: string,
    args: readonly unknown[]
  ) => void;
  onServerRpcResult?: ReturnType<typeof vi.fn>;
  openPanelSession?: ReturnType<typeof vi.fn>;
  getPanelRuntimeConnection?: (
    panelId: string
  ) => { runtimeEntityId: string; connectionId: string } | undefined;
}) {
  ipcHandlers.clear();
  ipcInvokeHandlers.clear();
  const dispatcher = new ServiceDispatcher();
  opts.configureDispatcher?.(dispatcher);
  dispatcher.markInitialized();
  const serverClient = {
    call: opts.call ?? vi.fn(async () => ({ ok: "shell" })),
    callAs: opts.callAs ?? vi.fn(async () => ({ ok: "app" })),
    stream: vi.fn(async () => new Response()),
    addMessageListener: opts.addMessageListener ?? vi.fn(() => vi.fn()),
    openPanelSession:
      opts.openPanelSession ??
      vi.fn(async () => ({
        send: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        status: () => "connected" as const,
        isClosed: () => false,
        close: vi.fn(),
      })),
    isConnected: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected" as const),
    close: vi.fn(async () => {}),
  };
  const eventService = { registerSubscriber: vi.fn() };
  new IpcDispatcher({
    dispatcher,
    serverClient,
    getShellWebContents: () => null,
    resolveCallerForWebContents: opts.resolve,
    getCodeIdentityForCaller: opts.getCodeIdentityForCaller,
    getWebContentsForCaller: (opts.getWebContentsForCaller ?? (() => null)) as never,
    getPanelRuntimeConnection: opts.getPanelRuntimeConnection,
    authorizeAppServerCall: opts.authorizeAppServerCall,
    onServerRpcResult: opts.onServerRpcResult,
    eventService: eventService as never,
  });
  return { serverClient, eventService };
}

describe("IpcDispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ipcHandlers.clear();
    ipcInvokeHandlers.clear();
  });

  it("forwards app renderer server RPC through an app-scoped server client", async () => {
    const appWc = makeWebContents(10);
    const callAs = vi.fn(async () => ({ workspace: "ok" }));
    const { serverClient } = makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "workspace",
        "getInfo",
        []
      );
    });
    expect(serverClient.call).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-1",
        result: { workspace: "ok" },
      });
    });
  });

  it("forwards the workspace shell renderer panelTree RPC as the apps/shell app principal", async () => {
    // The desktop workspace shell renders as the apps/shell app view, so its
    // panelTree call is scoped to its own app principal via callAs (no shell→app
    // proxy). This is the post-relabel path that replaced the deleted proxy.
    const shellWc = makeWebContents(20);
    const call = vi.fn();
    const callAs = vi.fn(async () => ({ rootPanels: [] }));
    const onServerRpcResult = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      call,
      callAs,
      onServerRpcResult,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: shellWc } as never,
      rpcEnvelope("shell", "shell", {
        type: "request",
        requestId: "req-paneltree",
        fromId: "@workspace-apps/shell",
        method: "panelTree.getTreeSnapshot",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "panelTree",
        "getTreeSnapshot",
        []
      );
    });
    expect(call).not.toHaveBeenCalled();
    expect(onServerRpcResult).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        service: "panelTree",
        method: "getTreeSnapshot",
      })
    );
    await vi.waitFor(() => {
      expectSentRpcMessage(shellWc, "shell", {
        type: "response",
        requestId: "req-paneltree",
        result: { rootPanels: [] },
      });
    });
  });

  it("forwards a native-host shell server RPC on the admin connection (no shell→app proxy)", async () => {
    // electron-main / bootstrap launch gate are native-host `shell` principals;
    // they reach the server via the admin connection (plain call), never via the
    // deleted shell→app panelTree proxy.
    const shellWc = makeWebContents(21);
    const call = vi.fn(async () => ({ ok: true }));
    const callAs = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "shell", callerKind: "shell" }),
      call,
      callAs,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: shellWc } as never,
      rpcEnvelope("shell", "shell", {
        type: "request",
        requestId: "req-shell-server",
        fromId: "shell",
        method: "workspace.hostTargets.beginLaunch",
        args: ["electron"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith("workspace", "hostTargets.beginLaunch", ["electron"]);
    });
    expect(callAs).not.toHaveBeenCalled();
  });

  it("relays a panel renderer over its own panel-principal session, not the shell/app channel", async () => {
    const panelWc = makeWebContents(11);
    const callAs = vi.fn();
    const call = vi.fn();
    const panelSend = vi.fn();
    const openPanelSession = vi.fn(async () => ({
      send: panelSend,
      onMessage: vi.fn(() => vi.fn()),
      status: () => "connected" as const,
      isClosed: () => false,
      close: vi.fn(),
    }));
    makeDispatcher({
      resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
      getWebContentsForCaller: () => panelWc,
      getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
      openPanelSession,
      call,
      callAs,
    });

    const envelope = rpcEnvelope("panel-1", "panel", {
      type: "request",
      requestId: "req-1",
      fromId: "panel-1",
      method: "workspace.getInfo",
      args: [],
    } satisfies RpcMessage);
    ipcHandlers.get("vibestudio:rpc:send")?.({ sender: panelWc } as never, envelope as never);

    await vi.waitFor(() => {
      expect(openPanelSession).toHaveBeenCalledWith("entity-1", "conn-1");
      expect(panelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "entity-1",
          delivery: expect.objectContaining({
            caller: { callerId: "entity-1", callerKind: "panel" },
          }),
          provenance: [{ callerId: "entity-1", callerKind: "panel" }],
          message: expect.objectContaining({ requestId: "req-1", fromId: "entity-1" }),
        })
      );
    });
    // The panel's full surface rides its own session — it never reaches the
    // shell/app server path (call / callAs).
    expect(call).not.toHaveBeenCalled();
    expect(callAs).not.toHaveBeenCalled();
  });

  it("error-responds (not silently drops) a panel envelope with no runtime lease", async () => {
    const panelWc = makeWebContents(12);
    makeDispatcher({
      resolve: () => ({ callerId: "panel-2", callerKind: "panel" }),
      getWebContentsForCaller: () => panelWc,
      getPanelRuntimeConnection: () => undefined,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: panelWc } as never,
      rpcEnvelope("panel-2", "panel", {
        type: "request",
        requestId: "req-2",
        fromId: "panel-2",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(panelWc.send).toHaveBeenCalledWith(
        "vibestudio:rpc:message",
        expect.objectContaining({
          message: expect.objectContaining({ type: "response", requestId: "req-2" }),
        })
      );
    });
  });

  it("denies app server fs RPC before forwarding when authorization fails", async () => {
    const appWc = makeWebContents(14);
    const callAs = vi.fn();
    const authorizeAppServerCall = vi.fn(() => {
      throw new Error("fs.readFile requires app capability 'fs-read'");
    });
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-fs-denied",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-fs-denied",
        error: "fs.readFile requires app capability 'fs-read'",
      });
    });
    expect(authorizeAppServerCall).toHaveBeenCalledWith("@workspace-apps/shell", "fs", "readFile", [
      "/hello.txt",
      "utf8",
    ]);
    expect(callAs).not.toHaveBeenCalled();
  });

  it("forwards app server fs RPC after authorization succeeds", async () => {
    const appWc = makeWebContents(15);
    const callAs = vi.fn(async () => "hello");
    const authorizeAppServerCall = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-fs-ok",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "fs",
        "readFile",
        ["/hello.txt", "utf8"]
      );
    });
    expect(authorizeAppServerCall).toHaveBeenCalledWith("@workspace-apps/shell", "fs", "readFile", [
      "/hello.txt",
      "utf8",
    ]);
    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-fs-ok",
        result: "hello",
      });
    });
  });

  it("forwards IPC delivery metadata as server call options", async () => {
    const appWc = makeWebContents(17);
    const callAs = vi.fn(async () => "ok");
    const request = {
      type: "request",
      requestId: "req-meta",
      fromId: "@workspace-apps/shell",
      method: "fs.readFile",
      args: ["/hello.txt", "utf8"],
    } satisfies RpcMessage;
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall: vi.fn(),
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", request, {
        idempotencyKey: "idem-1",
        readOnly: true,
      }) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "fs",
        "readFile",
        ["/hello.txt", "utf8"],
        { idempotencyKey: "idem-1", readOnly: true }
      );
    });
    expect(request).not.toHaveProperty("idempotencyKey");
    expect(request).not.toHaveProperty("readOnly");
  });

  it("attaches app source identity to Electron-local service dispatch", async () => {
    const appWc = makeWebContents(13);
    let seenContext: ServiceContext | null = null;
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getCodeIdentityForCaller: () => ({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      }),
      configureDispatcher: (dispatcher) => {
        dispatcher.registerService({
          name: "app",
          description: "test app service",
          policy: { allowed: ["app"] },
          methods: {},
          handler: async (ctx) => {
            seenContext = ctx;
            return { ok: true };
          },
        });
      },
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-local",
        fromId: "@workspace-apps/shell",
        method: "app.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() =>
      expect(seenContext?.caller.code).toMatchObject({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      })
    );
  });

  it("bridges server-originated app messages back to the current app WebContents", async () => {
    const appWc = makeWebContents(12);
    const listenerBox: { current?: (envelope: RpcEnvelope) => void } = {};
    const addMessageListener = vi.fn((_caller, nextListener) => {
      listenerBox.current = nextListener;
      return vi.fn();
    });
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      addMessageListener,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );
    await vi.waitFor(() => expect(listenerBox.current).toBeTruthy());
    const emitToApp = listenerBox.current;
    if (!emitToApp) throw new Error("missing app message listener");

    const eventEnvelope = rpcEnvelope(
      "main",
      "server",
      {
        type: "event",
        fromId: "main",
        event: "workspace:changed",
        payload: { id: "ws" },
      },
      undefined,
      "@workspace-apps/shell"
    );
    emitToApp(eventEnvelope);

    expect(appWc.send).toHaveBeenCalledWith("vibestudio:rpc:message", eventEnvelope);
  });

  it("registers an IPC event subscriber for app-backed shell views", async () => {
    const appWc = makeWebContents(16);
    const { eventService } = makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
    });

    ipcHandlers.get("vibestudio:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-local-events",
        fromId: "@workspace-apps/shell",
        method: "events.subscribe",
        args: ["workspace:revision-bumped"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(eventService.registerSubscriber).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        expect.objectContaining({ callerKind: "app" })
      );
    });
  });

  // §3.3: the ONLY recycle signal is a terminal isClosed(); transport status is
  // transient (the transport auto-reopens sessions across pipe reconnects).
  describe("panel session recycling", () => {
    function panelEnvelope(requestId: string): RpcEnvelope {
      return rpcEnvelope("panel-1", "panel", {
        type: "request",
        requestId,
        fromId: "panel-1",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage);
    }

    it("reuses a session whose transport is merely reconnecting (isClosed=false)", async () => {
      const panelWc = makeWebContents(30);
      const panelSend = vi.fn();
      const close = vi.fn();
      let status: "connected" | "connecting" | "disconnected" = "connected";
      const openPanelSession = vi.fn(async () => ({
        send: panelSend,
        onMessage: vi.fn(() => vi.fn()),
        status: () => status,
        isClosed: () => false,
        close,
      }));
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
        openPanelSession,
      });

      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r1") as never
      );
      await vi.waitFor(() => expect(panelSend).toHaveBeenCalledTimes(1));

      // Routine pipe reconnect: transport reads "connecting" but the session is
      // NOT terminally closed — it must be reused, not recycled.
      status = "connecting";
      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r2") as never
      );
      await vi.waitFor(() => expect(panelSend).toHaveBeenCalledTimes(2));

      expect(openPanelSession).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    });

    it("recycles (and re-opens) only a terminally closed session", async () => {
      const panelWc = makeWebContents(31);
      let closed = false;
      const firstSend = vi.fn();
      const firstClose = vi.fn();
      const secondSend = vi.fn();
      const openPanelSession = vi
        .fn()
        .mockResolvedValueOnce({
          send: firstSend,
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => closed,
          close: firstClose,
        })
        .mockResolvedValueOnce({
          send: secondSend,
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => false,
          close: vi.fn(),
        });
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
        openPanelSession,
      });

      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r1") as never
      );
      await vi.waitFor(() => expect(firstSend).toHaveBeenCalledTimes(1));

      closed = true; // lease revoke / server-side teardown: terminal
      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r2") as never
      );
      await vi.waitFor(() => expect(secondSend).toHaveBeenCalledTimes(1));

      expect(openPanelSession).toHaveBeenCalledTimes(2);
      expect(firstClose).toHaveBeenCalled();
      expect(firstSend).toHaveBeenCalledTimes(1);
    });

    it("reopens the panel session when the runtime lease connection changes", async () => {
      const panelWc = makeWebContents(32);
      let connectionId = "conn-1";
      const firstSend = vi.fn();
      const firstClose = vi.fn();
      const secondSend = vi.fn();
      const openPanelSession = vi
        .fn()
        .mockResolvedValueOnce({
          send: firstSend,
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => false,
          close: firstClose,
        })
        .mockResolvedValueOnce({
          send: secondSend,
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => false,
          close: vi.fn(),
        });
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId }),
        openPanelSession,
      });

      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r1") as never
      );
      await vi.waitFor(() => expect(firstSend).toHaveBeenCalledTimes(1));

      connectionId = "conn-2";
      ipcHandlers.get("vibestudio:rpc:send")?.(
        { sender: panelWc } as never,
        panelEnvelope("r2") as never
      );
      await vi.waitFor(() => expect(secondSend).toHaveBeenCalledTimes(1));

      expect(openPanelSession).toHaveBeenCalledTimes(2);
      expect(openPanelSession).toHaveBeenNthCalledWith(1, "entity-1", "conn-1");
      expect(openPanelSession).toHaveBeenNthCalledWith(2, "entity-1", "conn-2");
      expect(firstClose).toHaveBeenCalledTimes(1);
    });
  });

  // §1.6 upload hop: panel request bodies cross the bridge as chunk messages,
  // reassemble host-side, and feed the panel session's streamReadable().
  describe("panel bridge upload streams", () => {
    function streamRequest(): RpcEnvelope {
      return rpcEnvelope("panel-1", "panel", {
        type: "stream-request",
        requestId: "sreq-1",
        fromId: "panel-1",
        method: "gateway.fetch",
        args: [{ path: "/upload" }],
      } as RpcMessage);
    }

    async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }

    function makeStreamingPanelWc(id: number) {
      // Auto-ack response chunks like the panel preload does, so the host's
      // ack-gated response pump advances.
      const wc = makeWebContents(id);
      wc.send.mockImplementation(
        (channel: string, msg: { kind?: string; opId?: string; seq?: number }) => {
          if (channel !== "vibestudio:rpc:stream-message" || msg.kind !== "chunk") return;
          queueMicrotask(() =>
            ipcHandlers.get("vibestudio:rpc:stream-ack")?.(
              { sender: wc } as never,
              { opId: msg.opId, seq: msg.seq } as never
            )
          );
        }
      );
      return wc;
    }

    it("reassembles body chunks, feeds session.streamReadable, and streams the response back", async () => {
      const panelWc = makeStreamingPanelWc(40);
      const seen: { body?: Uint8Array; envelope?: RpcEnvelope } = {};
      const streamReadable = vi.fn(
        async (envelope: RpcEnvelope, _signal: AbortSignal, body: ReadableStream<Uint8Array>) => {
          seen.envelope = envelope;
          seen.body = await drainStream(body);
          return {
            status: 201,
            statusText: "Created",
            headers: [["content-type", "application/json"]] as [string, string][],
            finalUrl: "http://gw/upload",
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new Uint8Array([9, 9]));
                c.close();
              },
            }),
          };
        }
      );
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
        openPanelSession: vi.fn(async () => ({
          send: vi.fn(),
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => false,
          streamReadable,
          close: vi.fn(),
        })),
      });

      const open = ipcInvokeHandlers.get("vibestudio:rpc:stream-open");
      const pushChunk = ipcInvokeHandlers.get("vibestudio:rpc:stream-body-chunk");
      expect(open).toBeTruthy();
      expect(pushChunk).toBeTruthy();

      await open?.(
        { sender: panelWc } as never,
        { opId: "op-1", envelope: streamRequest(), bodyId: "b-1" } as never
      );
      await pushChunk?.(
        { sender: panelWc } as never,
        { bodyId: "b-1", seq: 1, chunk: new Uint8Array([1, 2, 3]) } as never
      );
      await pushChunk?.(
        { sender: panelWc } as never,
        { bodyId: "b-1", seq: 2, done: true } as never
      );

      await vi.waitFor(() => {
        expect(panelWc.send).toHaveBeenCalledWith(
          "vibestudio:rpc:stream-message",
          expect.objectContaining({ kind: "end", opId: "op-1" })
        );
      });
      expect(seen.body).toEqual(new Uint8Array([1, 2, 3]));
      expect(seen.envelope?.from).toBe("entity-1");
      expect(seen.envelope?.message.type).toBe("stream-request");
      expect(
        seen.envelope?.message.type === "stream-request" ? seen.envelope.message.fromId : null
      ).toBe("entity-1");
      expect(panelWc.send).toHaveBeenCalledWith(
        "vibestudio:rpc:stream-message",
        expect.objectContaining({ kind: "head", opId: "op-1", status: 201 })
      );
      expect(panelWc.send).toHaveBeenCalledWith(
        "vibestudio:rpc:stream-message",
        expect.objectContaining({ kind: "chunk", opId: "op-1", chunk: new Uint8Array([9, 9]) })
      );
    });

    it("fails LOUDLY when the panel session has no streamReadable (loopback WS)", async () => {
      const panelWc = makeStreamingPanelWc(41);
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
        // Default session shape: no streamReadable — like the WS PanelSession.
      });

      await ipcInvokeHandlers.get("vibestudio:rpc:stream-open")?.(
        { sender: panelWc } as never,
        { opId: "op-1", envelope: streamRequest(), bodyId: "b-1" } as never
      );

      await vi.waitFor(() => {
        expect(panelWc.send).toHaveBeenCalledWith(
          "vibestudio:rpc:stream-message",
          expect.objectContaining({
            kind: "error",
            opId: "op-1",
            message: expect.stringContaining("require the WebRTC transport"),
          })
        );
      });
    });

    it("rejects stream-open from non-panel senders", async () => {
      const appWc = makeWebContents(42);
      makeDispatcher({
        resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
        getWebContentsForCaller: () => appWc,
      });

      // ipcMain.handle converts a synchronous throw into an invoke() rejection.
      expect(() =>
        ipcInvokeHandlers.get("vibestudio:rpc:stream-open")?.(
          { sender: appWc } as never,
          { opId: "op-1", envelope: streamRequest(), bodyId: "b-1" } as never
        )
      ).toThrow(/non-panel sender/);
    });

    it("aborting from the panel aborts the session stream", async () => {
      const panelWc = makeStreamingPanelWc(43);
      let seenSignal: AbortSignal | null = null;
      const streamReadable = vi.fn(
        (_envelope: RpcEnvelope, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            seenSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted upstream")));
          })
      );
      makeDispatcher({
        resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
        getWebContentsForCaller: () => panelWc,
        getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
        openPanelSession: vi.fn(async () => ({
          send: vi.fn(),
          onMessage: vi.fn(() => vi.fn()),
          status: () => "connected" as const,
          isClosed: () => false,
          streamReadable,
          close: vi.fn(),
        })),
      });

      await ipcInvokeHandlers.get("vibestudio:rpc:stream-open")?.(
        { sender: panelWc } as never,
        { opId: "op-1", envelope: streamRequest(), bodyId: "b-1" } as never
      );
      await vi.waitFor(() => expect(streamReadable).toHaveBeenCalled());

      ipcHandlers.get("vibestudio:rpc:stream-abort")?.(
        { sender: panelWc } as never,
        "op-1" as never
      );
      await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));

      // Late body chunks for the aborted op fail loudly (op is gone).
      await expect(
        Promise.resolve(
          ipcInvokeHandlers.get("vibestudio:rpc:stream-body-chunk")?.(
            { sender: panelWc } as never,
            { bodyId: "b-1", seq: 1, chunk: new Uint8Array([1]) } as never
          )
        )
      ).rejects.toThrow(/unknown bodyId/);
    });
  });
});
