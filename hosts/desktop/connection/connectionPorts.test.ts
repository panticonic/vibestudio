import { describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import { ControlChannel, controlChannelClosed, createMessagePortPair } from "./controlChannel.js";
import { MemoryStore } from "../../core/src/testing.js";
import { ConnectionHost } from "./connectionHost.js";
import type { HostToRenderer, RendererToHost } from "./rendererPortProtocol.js";
import { ConnectionLink, type ConnectionHandlers } from "../main/connectionLink.js";
import { createHostServiceEndpoint } from "../main/hostServiceEndpoint.js";
import type { ConnectedSession } from "../main/serverSession.js";
import type { ConnectedServerClient } from "../main/serverClient.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeClient() {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const client = {
    isClosed: () => false,
    isConnected: () => true,
    getConnectionStatus: () => "connected" as const,
    transportDiagnostics: () => null,
    onRecovery: vi.fn(() => () => undefined),
    onConnectionStatusChange: vi.fn(() => () => undefined),
    onDirectEvent: vi.fn(() => () => undefined),
    exposeHostMethod: vi.fn(),
    exposeHostStream: vi.fn(),
    setClientPrincipalSessions: vi.fn(),
    close: vi.fn(async () => undefined),
    call: vi.fn(async (_s: string, _m: string, args: unknown[]) => ({ called: args[0] })),
    callTarget: vi.fn(async () => undefined),
    callAs: vi.fn(async (_c: unknown, _s: string, _m: string, args: unknown[]) => ({
      as: args[0],
    })),
    stream: vi.fn(async () => new Response("streamed")),
    streamReadable: vi.fn(),
    streamAs: vi.fn(),
    openHostUiSession: vi.fn(),
    openPanelSession: vi.fn(),
    sendAs: vi.fn(async () => undefined),
    addMessageListener: vi.fn((_caller: unknown, listener: (envelope: RpcEnvelope) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    releaseClientSession: vi.fn(async () => undefined),
  };
  return {
    client,
    push: (envelope: RpcEnvelope) => listeners.forEach((l) => l(envelope)),
    listeners,
  };
}

function session(client: ConnectedServerClient): ConnectedSession {
  return {
    nativeStorageScope: "scope",
    connectionMode: "local",
    serverOwnership: "external",
    protocol: "http",
    gatewayPort: 1,
    externalHost: "localhost",
    gatewayConfig: { serverUrl: "http://127.0.0.1:1" },
    workerdPort: 0,
    workspaceName: "System",
    workspaceId: "system",
    workspacePath: "/p",
    statePath: "/s",
    workspaceConfig: { id: "system" } as never,
    serverClient: client,
    close: vi.fn(async () => undefined),
    panelHttpServer: { invalidateBuild: () => undefined, getPort: () => 1 },
    serverInfo: {} as never,
    getCdpAuthToken: () => "",
    onCdpAuthToken: () => () => undefined,
    hubControlClient: fakeClient().client as unknown as ConnectedServerClient,
    hubProcessManager: null,
    connectWorkspace: vi.fn(async () => {
      throw new Error("unused");
    }),
  };
}

const handlers: ConnectionHandlers = {
  confirmExistingLocalHub: async () => "attach",
  credentials: { load: () => null, preflight: () => undefined, save: () => undefined },
  onStartupProgress: () => undefined,
  onConnectionStatusChanged: () => undefined,
  onTransportDiagnosticsChanged: () => undefined,
  onReconnectProgress: () => undefined,
  onLocalRecoveryFailure: () => undefined,
  onMainSessionTerminalClose: () => undefined,
  onCredentialSaveFailed: () => undefined,
};

async function setup(services: string[] = []) {
  const [mainPort, utilityPort] = createMessagePortPair();
  const mainChannel = new ControlChannel(mainPort, "a", { endOnPortClose: false });
  const utilityChannel = new ControlChannel(utilityPort, "b");
  const workspace = fakeClient();
  const connected = session(workspace.client as unknown as ConnectedServerClient);
  new ConnectionHost({
    channel: utilityChannel,
    establish: async () => connected,
    createCentralData: () => ({}) as never,
    createArtifactStore: () => new MemoryStore(),
  });
  const link = new ConnectionLink(mainChannel);
  const dispatch = vi.fn(async (_ctx: unknown, service: string, method: string) => ({
    host: `${service}.${method}`,
  }));
  link.serveHost(
    createHostServiceEndpoint({
      resolveWorkspace: async (workspaceId) => ({
        workspaceId,
        dispatcher: {
          getServices: () => services,
          hasService: (name: string) => services.includes(name),
          dispatch,
          observeFailure: vi.fn(),
        } as never,
      }),
      codeIdentityForCaller: () => null,
      panelRuntimeConnection: () => undefined,
    })
  );
  const sessionConnection = await link.establish(
    { mode: null, prepareInitialWorkspace: false, appVersion: "1", userDataPath: "/u" },
    handlers
  );
  return { link, mainChannel, utilityChannel, workspace, connected, sessionConnection, dispatch };
}

/** A renderer document: the far end of a port the connection process serves. */
function renderer() {
  const [near, far] = createMessagePortPair();
  const received: HostToRenderer[] = [];
  far.on("message", (event) => received.push(event.data as HostToRenderer));
  far.start();
  const closed = vi.fn();
  far.on("close", closed);
  return {
    near,
    send: (message: RendererToHost) => far.postMessage(message),
    received,
    closed,
    closeFar: () => far.close(),
  };
}

const binding = {
  caller: {
    callerId: "window:chat:1",
    callerKind: "client" as const,
    runtimeId: "client:chat:web:dev",
    workspaceId: "system",
  },
  state: {
    hostsPanels: false,
    client: {
      capabilities: [] as string[],
      executionDigest: "d",
      effectiveVersion: "1",
      principalId: "client:chat:web:dev",
      workspaceId: "system",
    },
  },
};

function request(method: string, id = "r1"): RpcEnvelope {
  const caller = { callerId: "client:chat:web:dev", callerKind: "client" as const };
  return {
    from: "client:chat:web:dev",
    target: "main",
    delivery: { caller },
    provenance: [caller],
    message: { type: "request", requestId: id, fromId: "client:chat:web:dev", method, args: ["x"] },
  };
}

function responseFor(received: HostToRenderer[], id: string) {
  return received.find(
    (m) =>
      m.t === "message" &&
      m.envelope.message.type === "response" &&
      m.envelope.message.requestId === id
  ) as Extract<HostToRenderer, { t: "message" }> | undefined;
}

describe("connection process", () => {
  it("serves main's own calls through a client proxy over the control channel", async () => {
    const { sessionConnection, workspace } = await setup();
    await expect(sessionConnection.serverClient.call("svc", "m", ["a"])).resolves.toEqual({
      called: "a",
    });
    expect(workspace.client.call).toHaveBeenCalledWith("svc", "m", ["a"], expect.anything());
    expect(sessionConnection.workspaceId).toBe("system");
    expect(sessionConnection.serverClient.isConnected()).toBe(true);
  });

  it("carries a renderer's request straight to its principal's session and the answer back", async () => {
    const { link, workspace } = await setup();
    const doc = renderer();
    await link.bindPort(binding, doc.near);
    doc.send({ t: "send", envelope: request("svc.method") });
    await tick();
    expect(workspace.client.callAs).toHaveBeenCalledWith(
      { callerId: "client:chat:web:dev", callerKind: "client", instanceId: "window:chat:1" },
      "svc",
      "method",
      ["x"]
    );
    const answer = responseFor(doc.received, "r1");
    expect((answer?.envelope.message as { result?: unknown }).result).toEqual({ as: "x" });
  });

  it("answers host-owned services through main, as the caller main attested", async () => {
    const { link, dispatch, workspace } = await setup(["view"]);
    const doc = renderer();
    await link.bindPort(binding, doc.near);
    doc.send({ t: "send", envelope: request("view.setBounds") });
    await tick();
    expect(workspace.client.callAs).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        caller: { runtime: { id: "window:chat:1", kind: "client" } },
      }),
      "view",
      "setBounds",
      ["x"]
    );
    const answer = responseFor(doc.received, "r1");
    expect((answer?.envelope.message as { result?: unknown }).result).toEqual({
      host: "view.setBounds",
    });
  });

  it("refuses shellApproval to a client that lacks the approval-surface capability", async () => {
    const { link } = await setup();
    const doc = renderer();
    await link.bindPort(binding, doc.near);
    doc.send({ t: "send", envelope: request("shellApproval.list") });
    await tick();
    const answer = responseFor(doc.received, "r1");
    expect((answer?.envelope.message as { error?: { message: string } }).error?.message).toContain(
      "approval surface"
    );
  });

  it("releases a document's session when its port closes, and only that session", async () => {
    const { link, workspace } = await setup();
    const first = renderer();
    const second = renderer();
    await link.bindPort(binding, first.near);
    await link.bindPort(binding, second.near);
    first.send({ t: "send", envelope: request("svc.m", "a") });
    second.send({ t: "send", envelope: request("svc.m", "b") });
    await tick();
    expect(workspace.listeners.size).toBe(2);
    first.closeFar();
    await tick();
    expect(workspace.listeners.size).toBe(1);
    // The window's shared scoped session lives while another document uses it.
    expect(workspace.client.releaseClientSession).not.toHaveBeenCalled();
    second.closeFar();
    await tick();
    expect(workspace.listeners.size).toBe(0);
    expect(workspace.client.releaseClientSession).toHaveBeenCalledTimes(1);
  });

  it("tells the document why when the host ends its session", async () => {
    const { link } = await setup();
    const doc = renderer();
    await link.bindPort(binding, doc.near);
    await link.releaseCaller("window:chat:1");
    await tick();
    expect(doc.received).toContainEqual({ t: "closed", reason: "The window was closed" });
    expect(doc.closed).toHaveBeenCalled();
  });

  it("delivers the server's messages to the document and events main produced to the chrome", async () => {
    const { link, workspace } = await setup();
    const chrome = renderer();
    await link.bindPort(
      { ...binding, state: { ...binding.state, hostsPanels: true } },
      chrome.near
    );
    chrome.send({ t: "send", envelope: request("svc.m") });
    await tick();
    const pushed = request("svc.event", "evt");
    workspace.push(pushed);
    link.sendEventToShell("system", "workspace-focused", { workspaceId: "p" });
    await tick();
    expect(
      chrome.received.some(
        (m) =>
          m.t === "message" &&
          m.envelope.message.type === "request" &&
          m.envelope.message.requestId === "evt"
      )
    ).toBe(true);
    expect(
      chrome.received.some(
        (m) =>
          m.t === "message" &&
          m.envelope.message.type === "event" &&
          m.envelope.message.event === "workspace-focused"
      )
    ).toBe(true);
  });

  it("fails pending calls and every client with the process's exit reason", async () => {
    const { sessionConnection, workspace, mainChannel } = await setup();
    let release!: () => void;
    workspace.client.call.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ called: 1 })))
    );
    const statuses: string[] = [];
    sessionConnection.serverClient.onConnectionStatusChange((status) => statuses.push(status));
    const pending = sessionConnection.serverClient.call("svc", "slow", []);
    await tick();
    const reason = controlChannelClosed("The connection process exited unexpectedly (code 11)");
    mainChannel.fail(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(sessionConnection.serverClient.call("svc", "again", [])).rejects.toBe(reason);
    expect(sessionConnection.serverClient.isClosed()).toBe(true);
    expect(statuses).toEqual(["disconnected"]);
    release();
  });

  it("admits client sessions itself and reports one ending (trust-revoked, retired) to main", async () => {
    const { link, workspace } = await setup();
    const ended = vi.fn();
    link.onClientSessionEnded(ended);
    const principals = workspace.client.setClientPrincipalSessions.mock.calls.at(-1)?.[0] as {
      connectionGrant(id: string): Promise<string>;
      sessionEnded(caller: unknown, reason: string): void;
    };
    // No client was launched through this process, so it grants nobody a session.
    await expect(principals.connectionGrant("client:chat:web:dev")).rejects.toThrow(
      /No client launched/
    );
    principals.sessionEnded(
      { callerId: "client:chat:web:dev", callerKind: "client" },
      "trust-revoked"
    );
    await tick();
    expect(ended).toHaveBeenCalledWith(
      { callerId: "client:chat:web:dev", callerKind: "client" },
      "trust-revoked"
    );
  });

  it("closes the sessions of every document when the connection closes", async () => {
    const { link, sessionConnection, connected } = await setup();
    const doc = renderer();
    await link.bindPort(binding, doc.near);
    await sessionConnection.close();
    await tick();
    expect(doc.received.some((m) => m.t === "closed")).toBe(true);
    expect(connected.close).toHaveBeenCalled();
  });

  it("re-establishes on a replacement process: the same proxies work again, subscriptions replay, recovery runs", async () => {
    const { link, mainChannel, sessionConnection } = await setup();
    const client = sessionConnection.serverClient;
    const recovered: string[] = [];
    client.onRecovery((kind) => void recovered.push(kind));
    const seen = vi.fn();
    client.onDirectEvent("clients:changed" as never, seen);
    client.exposeHostMethod("m", async () => "hosted");
    await tick();

    // The first process dies: everything pending fails with its reason.
    mainChannel.fail(controlChannelClosed("The connection process exited unexpectedly (code 9)"));
    await expect(client.call("svc", "x", [])).rejects.toThrow(/exited unexpectedly/);
    expect(client.isClosed()).toBe(true);

    // A replacement process serves the same link.
    const [mainPort2, utilityPort2] = createMessagePortPair();
    const channel2 = new ControlChannel(mainPort2, "a", { endOnPortClose: false });
    const second = fakeClient();
    new ConnectionHost({
      channel: new ControlChannel(utilityPort2, "b"),
      establish: async () => session(second.client as unknown as ConnectedServerClient),
      createCentralData: () => ({}) as never,
      createArtifactStore: () => new MemoryStore(),
    });
    await link.reestablish(channel2, {
      mode: null,
      prepareInitialWorkspace: false,
      appVersion: "1",
      userDataPath: "/u",
    });
    await tick();

    expect(link.channel).toBe(channel2);
    expect(client.isClosed()).toBe(false);
    await expect(client.call("svc", "again", [7])).resolves.toEqual({ called: 7 });
    expect(second.client.call).toHaveBeenCalled();
    expect(second.client.onDirectEvent).toHaveBeenCalledWith(
      "clients:changed",
      expect.any(Function)
    );
    expect(second.client.exposeHostMethod).toHaveBeenCalledWith("m", expect.any(Function));
    // The server sessions are new: listeners replay their state.
    expect(recovered).toEqual(["cold-recover"]);
  });
});
