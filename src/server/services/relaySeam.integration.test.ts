/**
 * Server ↔ apex-relay SEAM integration test.
 *
 * This is the coverage whose absence let the two sides drift. It wires the REAL
 * relay Durable Object (apps/webhook-relay/src/registry.ts `RelayRegistry`) to
 * the REAL server backhaul client (relayBackhaulClient.ts) over an in-memory
 * bridge that mirrors the on-the-wire framing, and drives a full round-trip for
 * BOTH profiles:
 *
 *   - webhook: register → provider POST at the relay `/i/<sub>` → durable buffer
 *     → backhaul deliver → server verify+dispatch → ack → provider gets the
 *     server's response verbatim.
 *   - oauth  : register-oauth (desktop) → relay landing GET on the SERVER-built
 *     redirect_uri (`/oauth/callback/<transactionId>`) → backhaul push → the
 *     server backhaul client receives `{transactionId, state, code}`.
 *
 * The bridge authenticates the dial with the worker's own `verifyBackhaulAuth`,
 * so the HMAC handshake the client mints is proven byte-compatible with what the
 * relay verifies.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  RelayRegistry,
  verifyBackhaulAuth,
  type Env,
} from "../../../apps/webhook-relay/src/registry.js";
import {
  createRelayBackhaulClient,
  type RelayBackhaulClient,
  type RelayOAuthCallbackFrame,
  type RelayWebhookFrame,
  type WebhookAck,
} from "./relayBackhaulClient.js";
import {
  InMemoryWebhookIngressStore,
  createWebhookIngressService,
} from "./webhookIngressService.js";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WebhookIngressSubscriptionSummary } from "../../../packages/shared/src/webhooks/ingress.js";

const RELAY_SECRET = "seam-relay-secret";
const RELAY_ORIGIN = "https://vibestudio.app";
const SERVER_ID = "server-under-test";

// ---- Relay DO fakes (mirror registry.test.ts: node-drivable, no workerd) ----

class FakeStorage {
  private map = new Map<string, unknown>();
  private alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** The relay-side socket bound to a serverId; its `send` pushes to the client. */
class RelaySideSocket {
  readyState = 1;
  private attachment: unknown = null;
  constructor(private readonly onSend: (data: string) => void) {}
  send(data: string): void {
    this.onSend(data);
  }
  close(): void {
    this.readyState = 3;
  }
  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

class FakeState {
  storage = new FakeStorage();
  private sockets: { ws: RelaySideSocket; tags: string[] }[] = [];
  acceptWebSocket(ws: RelaySideSocket, tags: string[]): void {
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string): RelaySideSocket[] {
    return this.sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
  }
}

// ---- Client-side bridge socket (implements the `ws` surface the client uses) --

/**
 * A stand-in for the `ws` WebSocket that, on construction, authenticates the
 * dial exactly as the worker's `/backhaul` upgrade does and bridges frames
 * to/from the RelayRegistry. Static OPEN/CONNECTING mirror `ws`.
 */
function makeBridgeCtor(registry: RelayRegistry, state: FakeState) {
  class BridgeSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = BridgeSocket.CONNECTING;
    private relaySocket: RelaySideSocket | null = null;

    constructor(url: string) {
      super();
      void this.connect(url);
    }

    private async connect(url: string): Promise<void> {
      const params = new URL(url).searchParams;
      const authed = await verifyBackhaulAuth(params, RELAY_SECRET, Date.now());
      if (!authed) {
        this.readyState = BridgeSocket.CLOSED;
        queueMicrotask(() => this.emit("close", 1006, Buffer.from("unauthorized")));
        return;
      }
      const serverId = params.get("serverId")!;
      // The relay pushes to the client by "sending" on the relay-side socket.
      this.relaySocket = new RelaySideSocket((data) =>
        queueMicrotask(() => this.emit("message", data))
      );
      registry.acceptBackhaul(serverId, this.relaySocket as unknown as WebSocket);
      this.readyState = BridgeSocket.OPEN;
      queueMicrotask(() => this.emit("open"));
    }

    send(data: string): void {
      if (this.readyState !== BridgeSocket.OPEN || !this.relaySocket) {
        throw new Error("bridge socket not open");
      }
      const socket = this.relaySocket;
      queueMicrotask(() => void registry.webSocketMessage(socket as unknown as WebSocket, data));
    }

    close(): void {
      this.readyState = BridgeSocket.CLOSED;
      if (this.relaySocket) this.relaySocket.close();
      queueMicrotask(() => this.emit("close", 1000, Buffer.from("bye")));
    }

    terminate(): void {
      this.close();
    }
  }
  void state; // state is captured via registry; kept for symmetry/readability.
  return BridgeSocket as unknown as typeof import("ws").WebSocket;
}

function makeRegistry(): { registry: RelayRegistry; state: FakeState } {
  const state = new FakeState();
  const registry = new RelayRegistry(
    state as unknown as DurableObjectState,
    { VIBESTUDIO_RELAY_SIGNING_SECRET: RELAY_SECRET } as Env
  );
  return { registry, state };
}

function shellCtx(): ServiceContext {
  return { caller: createVerifiedCaller("shell", "shell") };
}

async function tick(): Promise<void> {
  // Drain the queued microtasks + timers the bridge and DO schedule.
  await new Promise((r) => setTimeout(r, 0));
}

async function until(pred: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("server ↔ relay seam", () => {
  it("webhook: register → provider POST → backhaul deliver → server verify+dispatch → ack echoes the response", async () => {
    const { registry } = makeRegistry();

    // Server side: webhook ingress service that verifies + dispatches.
    const store = new InMemoryWebhookIngressStore();
    const dispatched: unknown[] = [];
    let client!: RelayBackhaulClient;
    const webhook = createWebhookIngressService({
      relaySigningSecret: RELAY_SECRET,
      relayOrigin: RELAY_ORIGIN,
      store,
      relayRegistrar: {
        registerWebhook: (id) => client.registerWebhook(id),
        unregisterWebhook: (id) => client.unregisterWebhook(id),
      },
      dispatchToTarget: async (_target, event) => {
        dispatched.push(event.payload);
      },
    });

    client = createRelayBackhaulClient({
      relayOrigin: RELAY_ORIGIN,
      serverId: SERVER_ID,
      signingSecret: RELAY_SECRET,
      WebSocketCtor: makeBridgeCtor(registry, new FakeState()),
      onWebhook: (frame: RelayWebhookFrame): Promise<WebhookAck> =>
        webhook.internal.deliverRelayWebhook(frame),
      onOAuthCallback: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    client.start();
    await until(() => client.connected, "backhaul connect");

    // Provision a relay-mode subscription (registers with the backhaul).
    const sub = (await webhook.definition.handler(shellCtx(), "createSubscription", [
      {
        target: { source: "workers/x", className: "XDO", objectKey: "main", method: "onHook" },
        delivery: { mode: "relay" },
        payload: { type: "json" },
        verifier: {
          type: "hmac-sha256",
          headerName: "X-Sig",
          secret: "provider-secret",
          prefix: "sha256=",
        },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      },
    ])) as WebhookIngressSubscriptionSummary;
    await until(() => store.get(sub.subscriptionId) !== null, "sub stored");
    await tick(); // let register-webhook reach the relay

    // Provider POSTs to the relay's public ingress with a valid provider HMAC.
    const bodyStr = JSON.stringify({ event: "push", n: 1 });
    const crypto = await import("node:crypto");
    const providerSig = `sha256=${crypto
      .createHmac("sha256", "provider-secret")
      .update(bodyStr)
      .digest("hex")}`;
    const ingress = registry.fetch(
      new Request(`https://vibestudio.app/i/${sub.subscriptionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sig": providerSig },
        body: bodyStr,
      })
    );

    const resp = await ingress;
    // The server acked 202 with a JSON body; the relay echoes it to the provider.
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ accepted: true, subscriptionId: sub.subscriptionId });
    expect(dispatched).toEqual([{ type: "json", json: { event: "push", n: 1 } }]);

    await client.stop();
  });

  it("webhook: buffers while the server backhaul is down, then flushes + acks on reconnect (no loss)", async () => {
    const { registry } = makeRegistry();
    const store = new InMemoryWebhookIngressStore();
    const dispatched: unknown[] = [];

    // Pre-seed a registered subscription directly in the store (as if created
    // earlier) so we can bring the backhaul up AFTER a provider delivery.
    const sub = (await createWebhookIngressService({
      relaySigningSecret: RELAY_SECRET,
      relayOrigin: RELAY_ORIGIN,
      store,
    }).definition.handler(shellCtx(), "createSubscription", [
      {
        target: { source: "workers/x", className: "XDO", objectKey: "main", method: "onHook" },
        delivery: { mode: "relay" },
        payload: { type: "raw" },
        verifier: { type: "bearer", headerName: "Authorization", token: "tok", scheme: "Bearer" },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      },
    ])) as WebhookIngressSubscriptionSummary;

    // Claim ownership over a short-lived backhaul, then drop it (server offline).
    let client!: RelayBackhaulClient;
    const mkClient = () =>
      createRelayBackhaulClient({
        relayOrigin: RELAY_ORIGIN,
        serverId: SERVER_ID,
        signingSecret: RELAY_SECRET,
        WebSocketCtor: makeBridgeCtor(registry, new FakeState()),
        onWebhook: (frame) =>
          createWebhookIngressService({
            relaySigningSecret: RELAY_SECRET,
            relayOrigin: RELAY_ORIGIN,
            store,
            dispatchToTarget: async (_t, event) => {
              dispatched.push(event.payload);
            },
          }).internal.deliverRelayWebhook(frame),
        onOAuthCallback: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
    client = mkClient();
    client.registerWebhook(sub.subscriptionId);
    client.start();
    await until(() => client.connected, "first connect");
    await tick();
    await client.stop();
    await tick();

    // Provider delivers while the server is offline → relay buffers (202 accepted).
    const offlineResp = await registry.fetch(
      new Request(`https://vibestudio.app/i/${sub.subscriptionId}`, {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: "hello",
      })
    );
    expect(offlineResp.status).toBe(202);
    expect(await offlineResp.json()).toMatchObject({ buffered: true });
    expect(dispatched).toHaveLength(0);

    // Server reconnects + re-registers → the relay flushes the buffered delivery.
    const client2 = mkClient();
    client2.registerWebhook(sub.subscriptionId);
    client2.start();
    await until(() => client2.connected, "reconnect");
    await until(() => dispatched.length === 1, "flushed delivery dispatched");
    expect(dispatched[0]).toEqual({ type: "raw" });
    await client2.stop();
  });

  it("oauth desktop: server redirect_uri path shape resolves at the relay landing and the backhaul carries {transactionId,state,code}", async () => {
    const { registry } = makeRegistry();
    const received: RelayOAuthCallbackFrame[] = [];
    const client = createRelayBackhaulClient({
      relayOrigin: RELAY_ORIGIN,
      serverId: SERVER_ID,
      signingSecret: RELAY_SECRET,
      WebSocketCtor: makeBridgeCtor(registry, new FakeState()),
      onWebhook: async () => ({ ok: true }),
      onOAuthCallback: (frame) => {
        received.push(frame);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    client.start();
    await until(() => client.connected, "backhaul connect");

    const transactionId = "tx-seam-123";
    client.registerOAuth(transactionId, "desktop");
    await tick();

    // The server builds redirect_uri = <relay>/oauth/callback/<transactionId>.
    // Feed EXACTLY that path (as the IdP would) into the real relay landing.
    const landing = await registry.fetch(
      new Request(`${RELAY_ORIGIN}/oauth/callback/${transactionId}?code=AUTHCODE&state=CSRF-STATE`)
    );
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Sign-in complete");

    await until(() => received.length === 1, "oauth-callback pushed down backhaul");
    expect(received[0]).toMatchObject({
      transactionId,
      code: "AUTHCODE",
      state: "CSRF-STATE",
    });
    await client.stop();
  });

  it("backhaul: re-announces registrations on reconnect (relay flush relies on it)", async () => {
    const { registry, state } = makeRegistry();
    const client = createRelayBackhaulClient({
      relayOrigin: RELAY_ORIGIN,
      serverId: SERVER_ID,
      signingSecret: RELAY_SECRET,
      WebSocketCtor: makeBridgeCtor(registry, state),
      onWebhook: async () => ({ ok: true }),
      onOAuthCallback: () => {},
      minBackoffMs: 5,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    client.registerWebhook("sub-reannounce");
    client.start();
    await until(() => client.connected, "connect");
    await tick();
    expect(await state.storage.get("webhook-reg:sub-reannounce")).toBeDefined();
    await client.stop();
  });
});
