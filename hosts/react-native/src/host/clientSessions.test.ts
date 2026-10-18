import { describe, expect, it, vi } from "vitest";
import { decodeRpcJson, encodeRpcJson, envelopeFromMessage, type RpcEnvelope } from "@vibestudio/rpc";
import { createRnClientApi } from "@vibestudio/rn-client-api";
import { createMemoryBroker } from "@vibestudio/rn-client-api/testing";
import type { ClientHostEvent, ClientHostMethod } from "@vibestudio/rn-client-api/protocol";
import type { LaunchedClient } from "@vibestudio/client-host-core";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { ClientInstance, type ClientInstanceHooks } from "./clientInstance";
import { HostState } from "./hostState";
import type { KeyValueStore } from "./ports";
import { fakeOpeners } from "./testSupport";

const DIGEST = "d".repeat(64);
const PRINCIPAL = "client:browser:react-native:dev1";

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
    remove: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
  };
}

function launched(granted: ClientCapability[]): LaunchedClient {
  return {
    client: {
      source: "clients/mobile-browser",
      id: "browser",
      runtime: "react-native",
      title: "Vibestudio",
      buildKey: "bk-1",
      executionDigest: DIGEST,
      effectiveVersion: "1.0.0",
      hostAbi: "rn-host-6",
      artifacts: [],
      grantedCapabilities: granted,
      deniedOptional: [],
    },
    artifacts: [],
    grant: {
      connectionGrant: "grant-1",
      expiresAt: 1,
      principalId: PRINCIPAL,
      deviceId: "dev1",
      serverId: "srv",
      serverBootId: "boot",
      workspaceId: "ws-system",
    },
  };
}

function setup(granted: ClientCapability[] = ["device-session", "hub-control", "panel-hosting"]) {
  const { openers, opened } = fakeOpeners((kind) =>
    kind === "principal" ? PRINCIPAL : "shell:dev1"
  );
  let issued = 1; // the launch's own grant is grant-1
  const acquire = vi.fn(async (_build: unknown) => ({
    connectionGrant: `grant-${(issued += 1)}`,
    expiresAt: 1,
    principalId: PRINCIPAL,
    deviceId: "dev1",
    serverId: "srv",
    serverBootId: "boot",
    workspaceId: "ws-system",
  }));
  const hooks = {
    restart: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    trustRevoked: vi.fn(),
    resetDevice: vi.fn(async () => undefined),
  } satisfies ClientInstanceHooks;
  const events: ClientHostEvent[] = [];
  const state = new HostState(memoryStore());
  let emit: (event: ClientHostEvent) => void = () => undefined;
  const instance = new ClientInstance({
    launched: launched(granted),
    platform: "android",
    openers,
    grants: { acquire },
    state,
    device: {
      setClipboard: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      browserImport: {} as never,
    },
    hooks,
    notifications: {} as never,
    intent: null,
    deliver: (event) => {
      events.push(event);
      emit(event);
    },
  });
  const { channel, host } = createMemoryBroker(async (method: ClientHostMethod, args) => {
    const outcome = await instance.broker.handle(method, encodeRpcJson(args));
    if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code });
    return decodeRpcJson(outcome.resultJson);
  });
  emit = host.emit;
  return { instance, channel, opened, acquire, hooks, events, state };
}

const request = (from: string): RpcEnvelope =>
  envelopeFromMessage({
    selfId: from,
    from,
    target: "main",
    callerKind: "client",
    message: { type: "request", requestId: "r1", method: "m", args: [] } as never,
  });

describe("a client's principal session", () => {
  it("holds the principal session for a running client that never opens one, and acts on its revocation", () => {
    const t = setup();
    t.instance.holdPrincipalSession();
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]!.kind).toBe("principal");

    t.opened[0]!.handlers.onTerminalClose(new Error("trust-revoked"));

    expect(t.hooks.trustRevoked).toHaveBeenCalledTimes(1);
  });

  it("spends the launch's grant once, then redeems a fresh grant for the exact build at each re-authentication", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    await api.session.openPrincipal();
    const principal = t.opened[0]!;
    expect(principal.kind).toBe("principal");

    expect(await principal.getToken!()).toBe("grant-1");
    expect(t.acquire).not.toHaveBeenCalled();

    expect(await principal.getToken!()).toBe("grant-2");
    expect(await principal.getToken!()).toBe("grant-3");
    expect(t.acquire).toHaveBeenCalledTimes(2);
    for (const [build] of t.acquire.mock.calls) {
      expect(build).toEqual({
        source: "clients/mobile-browser",
        buildKey: "bk-1",
        executionDigest: DIGEST,
      });
    }
  });

  it("is the client's principal on the server, whatever identity the client's envelopes claim", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    expect(connection.callerId).toBe(PRINCIPAL);

    await connection.session.send(request("client:somebody-else:react-native:dev9"));

    const sent = t.opened[0]!.session.sent[0]!;
    expect(sent.from).toBe(PRINCIPAL);
    expect(sent.delivery.caller).toEqual({ callerId: PRINCIPAL, callerKind: "client" });
    expect(sent.provenance).toEqual([{ callerId: PRINCIPAL, callerKind: "client" }]);
    expect((sent.message as { fromId: string }).fromId).toBe(PRINCIPAL);
  });

  it("delivers what the server sends to the client's end of the session", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    const seen: RpcEnvelope[] = [];
    connection.session.onMessage((envelope) => seen.push(envelope));

    t.opened[0]!.session.deliver(request("main"));

    expect(seen).toHaveLength(1);
  });

  it("refuses to reuse or forge session ids", async () => {
    const t = setup();
    await createRnClientApi(t.channel);
    const open = async (id: string) =>
      t.instance.broker.handle("session.openPrincipal", encodeRpcJson([id]));
    expect((await open("s-aaaaaaaa-1")).ok).toBe(true);
    expect(await open("s-aaaaaaaa-1")).toMatchObject({ ok: false, code: "SESSION_ID_REUSED" });
    expect(await open("../../etc")).toMatchObject({ ok: false, code: "BAD_SESSION_ID" });
    expect(
      await t.instance.broker.handle("session.postEnvelope", encodeRpcJson(["s-unknown-1", {}]))
    ).toMatchObject({ ok: false, code: "UNKNOWN_SESSION" });
  });
});

describe("capability enforcement on sessions", () => {
  it("opens routed workspaces and hub control only for a client that holds them", async () => {
    const t = setup([]);
    const api = await createRnClientApi(t.channel);

    await expect(api.session.openAccount()).rejects.toMatchObject({ code: "CAPABILITY_NOT_GRANTED" });
    expect(t.opened).toHaveLength(0);
    // The principal session needs no capability: every client has its own.
    await api.session.openPrincipal();
    expect(t.opened.map((call) => call.kind)).toEqual(["principal"]);
  });

  it("opens panel sessions only with panel-hosting, on the connection's own exact identity", async () => {
    const denied = setup(["device-session", "hub-control"]);
    const deniedApi = await createRnClientApi(denied.channel);
    const parent = await deniedApi.session.openPrincipal();
    await expect(
      parent.transport.openSession({ label: "panel", getToken: () => "t" }).ready()
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_GRANTED" });

    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    const panel = connection.transport.openSession({
      label: "panel e1",
      connectionId: "lease-connection-7",
      getToken: () => "panel-token",
    });
    await panel.ready();
    const call = t.opened.find((entry) => entry.kind === "auxiliary")!;
    expect(call.connectionId).toBe("lease-connection-7");
    // The host asks the client for each authentication's token.
    expect(await call.getToken!()).toBe("panel-token");
  });

  it("serves a routed workspace as a device shell session on the shared connection", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const account = await api.session.openAccount();
    const workspace = await account.openWorkspace("ws-personal");
    const call = t.opened.find((entry) => entry.kind === "workspace")!;
    expect(call.workspaceId).toBe("ws-personal");
    expect(workspace.hubControlRpc).toBe(account.control.rpc);
    await account.close();
    expect(t.opened.every((entry) => entry.released)).toBe(true);
  });
});

describe("trust revoked", () => {
  it("tells the client why, ends its sessions and asks the host to tear the instance down", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    const closed = vi.fn();
    connection.session.onClosed(closed);

    t.opened[0]!.handlers.onTerminalClose(new Error("trust-revoked"));

    expect(closed).toHaveBeenCalledWith({ reason: "trust-revoked", message: "trust-revoked" });
    expect(t.hooks.trustRevoked).toHaveBeenCalledTimes(1);
    expect(t.opened[0]!.released).toBe(true);
    await expect(connection.session.send(request(PRINCIPAL))).rejects.toThrow(/closed/);
  });

  it("is not trust revocation when the server closes for another reason", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    const closed = vi.fn();
    connection.session.onClosed(closed);

    t.opened[0]!.handlers.onTerminalClose(new Error("Token revoked"));

    expect(closed).toHaveBeenCalledWith({ reason: "server-closed", message: "Token revoked" });
    expect(t.hooks.trustRevoked).not.toHaveBeenCalled();
  });
});

describe("streams over a session", () => {
  it("relays a response body chunk by chunk, acknowledged by the client", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const connection = await api.session.openPrincipal();
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    t.opened[0]!.session.streamResponse = async () => ({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/octet-stream"]],
      finalUrl: "",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    const streamEnvelope = envelopeFromMessage({
      selfId: PRINCIPAL,
      from: PRINCIPAL,
      target: "main",
      callerKind: "client",
      message: { type: "stream-request", requestId: "s1", method: "gateway.fetch", args: [] } as never,
    });

    const response = await connection.session.streamReadable!(streamEnvelope, null, null);

    expect(response.status).toBe(200);
    const received: number[] = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(...value);
    }
    expect(received).toEqual([1, 2, 3, 4, 5]);
    // The envelope that reached the server carries the authenticated identity.
    expect(t.opened[0]!.session.streams[0]!.envelope.from).toBe(PRINCIPAL);
  });
});

describe("state, updates and device calls", () => {
  it("keeps each client's state in its own namespace", async () => {
    const store = memoryStore();
    const state = new HostState(store);
    const a = state.clientState("browser");
    const b = state.clientState("chat");
    await a.set("theme", "dark");
    expect(await b.get("theme")).toBeNull();
    expect(await a.keys()).toEqual(["theme"]);
    await a.remove("theme");
    expect(await a.get("theme")).toBeNull();
  });

  it("offers an announced update and restarts only when the client asks at its safe point", async () => {
    const t = setup();
    const api = await createRnClientApi(t.channel);
    const offered = vi.fn();
    api.updates.onUpdate(offered);
    await expect(api.updates.restartAtSafePoint()).rejects.toMatchObject({ code: "NO_UPDATE" });

    t.instance.offerUpdate({
      buildKey: "bk-2",
      effectiveVersion: "2.0.0",
      previousBuildKey: "bk-1",
      change: {} as never,
    });
    expect(offered).toHaveBeenCalledTimes(1);
    expect(api.updates.pending()?.buildKey).toBe("bk-2");
    expect(t.hooks.restart).not.toHaveBeenCalled();

    await api.updates.restartAtSafePoint();
    expect(t.hooks.restart).toHaveBeenCalledTimes(1);
  });

  it("applies a development-mode switch and a widened grant live", async () => {
    const t = setup(["device-session"]);
    const api = await createRnClientApi(t.channel);
    expect(api.client.developmentMode).toBe(false);
    await api.device.setDevelopmentMode(true);
    expect(t.state.isDevelopment("browser")).toBe(true);

    await expect(api.clipboard.setString("x")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_GRANTED",
    });
    t.instance.setCapabilities(["device-session", "clipboard"]);
    expect(api.capabilities.has("clipboard")).toBe(true);
    await api.clipboard.setString("x");
  });
});
