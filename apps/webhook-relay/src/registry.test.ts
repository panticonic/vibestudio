import { beforeEach, describe, expect, it } from "vitest";

import { RelayRegistry, verifyBackhaulAuth, type Env } from "./registry";
import { hmacSha256Hex, sha256Hex } from "./envelope";

// ---- Fakes ------------------------------------------------------------------
//
// The RelayRegistry is a plain DO class taking (state, env), so we can drive it
// in node by injecting a minimal in-memory DurableObjectState + fake sockets.
// This avoids `cloudflare:workers` and the runtime-only 101 upgrade Response.

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  private attachment: unknown = null;

  send(data: string): void {
    this.sent.push(data);
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
  frames(): any[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

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
  keys(prefix: string): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

class FakeState {
  storage = new FakeStorage();
  private sockets: { ws: FakeWebSocket; tags: string[] }[] = [];

  acceptWebSocket(ws: FakeWebSocket, tags: string[]): void {
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string): FakeWebSocket[] {
    return this.sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
  }
}

function makeRegistry(env: Partial<Env> = {}): { registry: RelayRegistry; state: FakeState } {
  const state = new FakeState();
  const registry = new RelayRegistry(
    state as unknown as DurableObjectState,
    { VIBESTUDIO_RELAY_SIGNING_SECRET: "relay-secret", ...env } as Env,
  );
  return { registry, state };
}

/**
 * A fresh RelayRegistry over the SAME durable state — simulates the DO being
 * evicted/hibernated and re-instantiated: empty in-memory fields, but intact
 * `ctx.storage`. Anything kept only in memory would be gone for this instance.
 */
function freshInstanceOver(state: FakeState, env: Partial<Env> = {}): RelayRegistry {
  return new RelayRegistry(
    state as unknown as DurableObjectState,
    { VIBESTUDIO_RELAY_SIGNING_SECRET: "relay-secret", ...env } as Env,
  );
}

async function until(pred: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function send(registry: RelayRegistry, ws: FakeWebSocket, frame: unknown): Promise<void> {
  return registry.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(frame));
}

function ingress(registry: RelayRegistry, subscriptionId: string, body: string, query = ""): Promise<Response> {
  const url = `https://relay.example/i/${subscriptionId}${query ? `?${query}` : ""}`;
  return registry.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-provider-sig": "psig", cookie: "drop-me" }, body }));
}

describe("RelayRegistry — webhook profile", () => {
  it("buffers a webhook, delivers it over the backhaul with a valid relay envelope, and returns the server's response", async () => {
    const { registry, state } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-1" });
    expect(ws.frames().some((f) => f.t === "registered" && f.id === "sub-1")).toBe(true);

    const body = JSON.stringify({ hello: "world" });
    const respPromise = ingress(registry, "sub-1", body, "x=1");

    // The webhook frame is sent down the backhaul before the ack is awaited.
    await until(() => ws.frames().some((f) => f.t === "webhook"), "webhook frame");
    const frame = ws.frames().find((f) => f.t === "webhook")!;
    expect(frame.subscriptionId).toBe("sub-1");
    expect(frame.path).toBe("/i/sub-1");
    expect(frame.query).toBe("x=1");
    expect(frame.headers["x-provider-sig"]).toBe("psig");
    expect(frame.headers.cookie).toBeUndefined();
    expect(atobToString(frame.bodyBase64)).toBe(body);

    // The relay envelope must be byte-identical to what the server verifies.
    const bodySha256 = await sha256Hex(new TextEncoder().encode(body).buffer as ArrayBuffer);
    expect(frame.relay.bodySha256).toBe(bodySha256);
    const canonical = ["POST", "/i/sub-1", "x=1", frame.relay.timestamp, bodySha256].join("\n");
    expect(frame.relay.signature).toBe(`v1=${await hmacSha256Hex("relay-secret", canonical)}`);

    // Server acks with a body to relay back to the provider.
    await send(registry, ws, {
      t: "ack",
      deliveryId: frame.deliveryId,
      response: { status: 200, bodyBase64: btoa("challenge-echo"), contentType: "text/plain" },
    });

    const resp = await respPromise;
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("challenge-echo");
    // Buffer drained.
    expect(state.storage.keys("buf:")).toHaveLength(0);
  });

  it("buffers while the server is offline and flushes on reconnect", async () => {
    const { registry, state } = makeRegistry();
    const ws1 = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws1 as unknown as WebSocket);
    await send(registry, ws1, { t: "register-webhook", subscriptionId: "sub-2" });

    // Server drops.
    ws1.close();
    const resp = await ingress(registry, "sub-2", JSON.stringify({ n: 1 }));
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ buffered: true });
    expect(state.storage.keys("buf:")).toHaveLength(1);

    // Server reconnects and re-registers — buffered delivery is flushed.
    const ws2 = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws2 as unknown as WebSocket);
    await send(registry, ws2, { t: "register-webhook", subscriptionId: "sub-2" });
    await until(() => ws2.frames().some((f) => f.t === "webhook"), "flushed webhook");
    expect(ws2.frames().find((f) => f.t === "webhook")!.subscriptionId).toBe("sub-2");
  });

  it("rejects an un-registered subscription (negative)", async () => {
    const { registry } = makeRegistry();
    const resp = await ingress(registry, "ghost", "{}");
    expect(resp.status).toBe(404);
    expect(await resp.json()).toMatchObject({ error: "subscription not registered" });
  });

  it("fails closed when the relay signing secret is missing", async () => {
    const { registry } = makeRegistry({ VIBESTUDIO_RELAY_SIGNING_SECRET: undefined });
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-3" });
    const resp = await ingress(registry, "sub-3", "{}");
    expect(resp.status).toBe(500);
    expect(await resp.json()).toMatchObject({ error: "VIBESTUDIO_RELAY_SIGNING_SECRET is not configured" });
  });
});

describe("RelayRegistry — first-writer-wins registration", () => {
  it("binds a subscription to the first backhaul and rejects a second registrant", async () => {
    const { registry } = makeRegistry();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    registry.acceptBackhaul("serverA", wsA as unknown as WebSocket);
    registry.acceptBackhaul("serverB", wsB as unknown as WebSocket);

    await send(registry, wsA, { t: "register-webhook", subscriptionId: "sub-x" });
    expect(wsA.frames().some((f) => f.t === "registered" && f.id === "sub-x")).toBe(true);

    await send(registry, wsB, { t: "register-webhook", subscriptionId: "sub-x" });
    expect(wsB.frames().some((f) => f.t === "register-rejected" && f.id === "sub-x")).toBe(true);
    expect(wsB.frames().some((f) => f.t === "registered")).toBe(false);

    // The first writer still owns delivery: a webhook routes to serverA.
    const respPromise = ingress(registry, "sub-x", "{}");
    await until(() => wsA.frames().some((f) => f.t === "webhook"), "delivery to first writer");
    expect(wsB.frames().some((f) => f.t === "webhook")).toBe(false);
    const frame = wsA.frames().find((f) => f.t === "webhook")!;
    await send(registry, wsA, { t: "ack", deliveryId: frame.deliveryId });
    await respPromise;
  });

  it("re-registration by the same server is idempotent (reconnect)", async () => {
    const { registry } = makeRegistry();
    const wsA = new FakeWebSocket();
    registry.acceptBackhaul("serverA", wsA as unknown as WebSocket);
    await send(registry, wsA, { t: "register-webhook", subscriptionId: "sub-y" });
    await send(registry, wsA, { t: "register-webhook", subscriptionId: "sub-y" });
    expect(wsA.frames().filter((f) => f.t === "registered").length).toBe(2);
    expect(wsA.frames().some((f) => f.t === "register-rejected")).toBe(false);
  });

  it("never leaks an owned subscription to a different backhaul identity, even when it is the only one online (negative)", async () => {
    const { registry, state } = makeRegistry();
    const wsA = new FakeWebSocket();
    registry.acceptBackhaul("serverA", wsA as unknown as WebSocket);
    await send(registry, wsA, { t: "register-webhook", subscriptionId: "sub-own" });

    // The owner drops; an UNRELATED second identity connects and is now the ONLY
    // live backhaul. The persisted ownerKey binding must still protect sub-own.
    wsA.close();
    const wsB = new FakeWebSocket();
    registry.acceptBackhaul("serverB", wsB as unknown as WebSocket);

    // serverB cannot claim the owned sub (first-writer-wins survives the owner
    // going offline because the binding is in DO storage, not on the socket).
    await send(registry, wsB, { t: "register-webhook", subscriptionId: "sub-own" });
    expect(wsB.frames().some((f) => f.t === "register-rejected" && f.id === "sub-own")).toBe(true);
    expect(wsB.frames().some((f) => f.t === "registered")).toBe(false);

    // A webhook for the owned sub is buffered for the owner, NEVER handed to the
    // connected non-owner. Delivery binds to the owner, not "whoever is online".
    const resp = await ingress(registry, "sub-own", JSON.stringify({ n: 1 }));
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ buffered: true });
    expect(wsB.frames().some((f) => f.t === "webhook")).toBe(false);
    expect(state.storage.keys("buf:")).toHaveLength(1);
  });
});

describe("RelayRegistry — OAuth profile (state-keyed handoff, one path per platform)", () => {
  it("desktop: forwards {state,code} verbatim down the owning server's backhaul", async () => {
    const { registry } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-d", platform: "desktop" });

    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-d?code=AUTHCODE&state=CSRFSTATE"),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");

    const cb = ws.frames().find((f) => f.t === "oauth-callback");
    expect(cb).toBeDefined();
    expect(cb).toMatchObject({ transactionId: "tx-d", code: "AUTHCODE", state: "CSRFSTATE" });

    // Single-use: a replay of the same landing no longer resolves.
    const replay = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-d?code=AUTHCODE&state=CSRFSTATE"),
    );
    expect(replay.status).toBe(404);
  });

  it("mobile: does NOT forward over the backhaul (the app forwards over the pipe)", async () => {
    const { registry } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-m", platform: "mobile" });

    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-m?code=AUTHCODE&state=CSRFSTATE"),
    );
    // Reaching the landing for a mobile tx means the deep-link failed: fail loud
    // with a non-200 (monitoring sees it), never silently forward down desktop.
    expect(resp.status).toBe(404);
    expect(await resp.text()).toContain("Vibestudio app");
    expect(ws.frames().some((f) => f.t === "oauth-callback")).toBe(false);
  });

  it("rejects an unknown OAuth transaction (negative)", async () => {
    const { registry } = makeRegistry();
    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-ghost?code=x&state=y"),
    );
    expect(resp.status).toBe(404);
  });

  it("desktop handoff fails loud when the home server is offline", async () => {
    const { registry } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-off", platform: "desktop" });
    ws.close();
    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-off?code=x&state=y"),
    );
    expect(resp.status).toBe(503);
  });
});

describe("RelayRegistry — OAuth tx durability across DO eviction (FIX: durable single-handoff)", () => {
  it("persists a desktop tx so it survives hibernation between register-oauth and the landing GET, and stays single-use", async () => {
    const { registry, state } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-durable", platform: "desktop" });
    // The handoff binding is in durable storage, not just memory.
    expect(state.storage.keys("oauth-tx:")).toHaveLength(1);

    // Simulate eviction: a brand-new instance with empty in-memory fields but the
    // same ctx.storage. An in-memory-only map would have been lost here.
    const revived = freshInstanceOver(state);
    const resp = await revived.fetch(
      new Request("https://relay.example/oauth/callback/tx-durable?code=AUTHCODE&state=CSRFSTATE"),
    );
    expect(resp.status).toBe(200);
    const cb = ws.frames().find((f) => f.t === "oauth-callback");
    expect(cb).toBeDefined();
    expect(cb).toMatchObject({ transactionId: "tx-durable", code: "AUTHCODE", state: "CSRFSTATE" });

    // Single-use: the delete-on-read was flushed durably, so a replay on the
    // revived instance (and the durable store) now fails loud.
    const replay = await revived.fetch(
      new Request("https://relay.example/oauth/callback/tx-durable?code=AUTHCODE&state=CSRFSTATE"),
    );
    expect(replay.status).toBe(404);
    expect(state.storage.keys("oauth-tx:")).toHaveLength(0);
  });

  it("keeps an UNCONSUMED tx durable for retry when the handoff fails loud across eviction (offline owner)", async () => {
    const { registry, state } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-survive", platform: "desktop" });
    ws.close(); // owner offline at landing time

    // Revived instance: the durable tx is found, but the handoff fails loud (503)
    // because the owner's backhaul is down — and the tx is NOT consumed.
    const revived = freshInstanceOver(state);
    const resp = await revived.fetch(
      new Request("https://relay.example/oauth/callback/tx-survive?code=x&state=y"),
    );
    expect(resp.status).toBe(503);
    // No silent 200, and the durable tx remains for the user's retry.
    expect(state.storage.keys("oauth-tx:")).toHaveLength(1);
  });

  it("expires a stale durable tx (TTL) and fails loud at landing time (negative)", async () => {
    const { registry, state } = makeRegistry();
    let clock = 1_000;
    registry.now = () => clock;
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-stale", platform: "desktop" });

    // Jump past the OAuth TTL (10 min) before the landing arrives.
    const revived = freshInstanceOver(state);
    revived.now = () => clock + 11 * 60 * 1000;
    const resp = await revived.fetch(
      new Request("https://relay.example/oauth/callback/tx-stale?code=x&state=y"),
    );
    expect(resp.status).toBe(404);
    // The expired entry is evicted on read rather than lingering forever.
    expect(state.storage.keys("oauth-tx:")).toHaveLength(0);
  });

  it("reclaims expired durable txs on the next register (storage hygiene)", async () => {
    const { registry, state } = makeRegistry();
    let clock = 1_000;
    registry.now = () => clock;
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-old", platform: "desktop" });
    expect(state.storage.keys("oauth-tx:")).toHaveLength(1);

    // Advance past the TTL, then register a different tx: the stale entry (an
    // abandoned/mobile flow that was never consumed) is reclaimed, not leaked.
    clock += 11 * 60 * 1000;
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-new", platform: "desktop" });
    const keys = state.storage.keys("oauth-tx:");
    expect(keys).toEqual(["oauth-tx:tx-new"]);
  });
});

describe("RelayRegistry — backhaul auth (the trust anchor)", () => {
  const secret = "relay-secret";

  it("accepts a freshly-signed handshake", async () => {
    const ts = String(Date.now());
    const sig = `v1=${await hmacSha256Hex(secret, `serverA\n${ts}`)}`;
    const params = new URLSearchParams({ serverId: "serverA", ts, sig });
    expect(await verifyBackhaulAuth(params, secret, Date.now())).toBe(true);
  });

  it("rejects a forged signature, a stale timestamp, and a missing secret (negative)", async () => {
    const ts = String(Date.now());
    const good = `v1=${await hmacSha256Hex(secret, `serverA\n${ts}`)}`;

    expect(await verifyBackhaulAuth(new URLSearchParams({ serverId: "serverA", ts, sig: "v1=deadbeef" }), secret, Date.now())).toBe(false);
    // Right signature for serverA but presented as serverB — fails closed.
    expect(await verifyBackhaulAuth(new URLSearchParams({ serverId: "serverB", ts, sig: good }), secret, Date.now())).toBe(false);
    // Stale beyond tolerance.
    const staleTs = String(Date.now() - 10 * 60 * 1000);
    const staleSig = `v1=${await hmacSha256Hex(secret, `serverA\n${staleTs}`)}`;
    expect(await verifyBackhaulAuth(new URLSearchParams({ serverId: "serverA", ts: staleTs, sig: staleSig }), secret, Date.now())).toBe(false);
    // No secret configured.
    expect(await verifyBackhaulAuth(new URLSearchParams({ serverId: "serverA", ts, sig: good }), undefined, Date.now())).toBe(false);
  });

  it("rejects an un-authed backhaul upgrade at the fetch boundary (negative)", async () => {
    const { registry } = makeRegistry();
    const resp = await registry.fetch(
      new Request("https://relay.example/backhaul?serverId=serverA&ts=1&sig=v1=bad", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(resp.status).toBe(401);
  });
});

describe("RelayRegistry — backhaul eviction (zombie duplicate)", () => {
  it("evicts a same-serverId incumbent so a handoff targets the fresh socket, not the dead one", async () => {
    const { registry } = makeRegistry();
    const ws1 = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws1 as unknown as WebSocket);
    // A second backhaul for the SAME serverId (unclean reconnect / restart).
    const ws2 = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws2 as unknown as WebSocket);
    // Incumbent superseded; the fresh socket owns the slot.
    expect(ws1.readyState).toBe(3);
    expect(ws2.readyState).toBe(1);

    // A desktop OAuth handoff must reach ws2, never the dead ws1 (which would
    // silently lose it while the landing showed "Sign-in complete").
    await send(registry, ws2, { t: "register-oauth", transactionId: "tx-evict", platform: "desktop" });
    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/tx-evict?code=C&state=S"),
    );
    expect(resp.status).toBe(200);
    expect(ws2.frames().some((f) => f.t === "oauth-callback")).toBe(true);
    expect(ws1.frames().some((f) => f.t === "oauth-callback")).toBe(false);
  });
});

describe("RelayRegistry — webhook ingress guards", () => {
  it("rejects an over-cap webhook body with 413 and buffers nothing (fail loud, no lost delivery)", async () => {
    const { registry, state } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-big" });
    const huge = "x".repeat(1_500_001);
    const resp = await ingress(registry, "sub-big", huge);
    expect(resp.status).toBe(413);
    expect(state.storage.keys("buf:")).toHaveLength(0);
  });

  it("rejects the newest delivery with 507 once the per-subscription buffer cap is reached", async () => {
    const { registry, state } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-cap" });
    ws.close(); // offline: every delivery buffers durably
    // Pre-seed the buffer to the cap via direct storage puts (fast, deterministic).
    const now = Date.now();
    const batch: Record<string, unknown> = {};
    for (let i = 0; i < 256; i++) {
      const id = `pre-${i}`;
      batch["buf:" + id] = {
        deliveryId: id,
        subscriptionId: "sub-cap",
        serverId: "serverA",
        method: "POST",
        path: "/i/sub-cap",
        query: "",
        headers: {},
        bodyBase64: "",
        bodySha256: "",
        createdAt: now,
        expiresAt: now + 60_000,
        attempts: 0,
        lastAttemptAt: 0,
      };
    }
    for (const [k, v] of Object.entries(batch)) await state.storage.put(k, v);
    expect(state.storage.keys("buf:")).toHaveLength(256);

    const resp = await ingress(registry, "sub-cap", JSON.stringify({ n: 1 }));
    expect(resp.status).toBe(507);
    // The buffer did not grow past the cap.
    expect(state.storage.keys("buf:")).toHaveLength(256);
  });
});

describe("RelayRegistry — OAuth landing hardening", () => {
  it("fails closed with 400 (not 500) on a malformed transactionId %-escape", async () => {
    const { registry } = makeRegistry();
    const resp = await registry.fetch(
      new Request("https://relay.example/oauth/callback/%zz?code=c&state=s"),
    );
    expect(resp.status).toBe(400);
  });

  it("desktop provider error: forwards it down the backhaul AND renders a non-200 surfacing the message", async () => {
    const { registry } = makeRegistry();
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-oauth", transactionId: "tx-err", platform: "desktop" });
    const resp = await registry.fetch(
      new Request(
        "https://relay.example/oauth/callback/tx-err?error=access_denied&error_description=User%20denied&state=S",
      ),
    );
    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body).toContain("access_denied");
    expect(body).toContain("User denied");
    // The error is still forwarded so the server fails the transaction promptly.
    const cb = ws.frames().find((f) => f.t === "oauth-callback");
    expect(cb).toMatchObject({ transactionId: "tx-err", error: "access_denied" });
  });
});

describe("RelayRegistry — alarm (retry + TTL eviction)", () => {
  it("evicts a buffered webhook past its TTL and does not reschedule once the buffer drains", async () => {
    const { registry, state } = makeRegistry();
    let clock = 1_000_000;
    registry.now = () => clock;
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-ttl" });
    ws.close(); // offline: the delivery buffers durably
    await ingress(registry, "sub-ttl", JSON.stringify({ n: 1 }));
    expect(state.storage.keys("buf:")).toHaveLength(1);

    // Jump past the 24h TTL. The runtime clears the pending alarm before alarm() runs.
    clock += 25 * 60 * 60 * 1000;
    await state.storage.deleteAlarm();
    await registry.alarm();

    expect(state.storage.keys("buf:")).toHaveLength(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it("re-sends a live buffered webhook and reschedules while entries remain", async () => {
    const { registry, state } = makeRegistry();
    let clock = 2_000_000;
    registry.now = () => clock;
    const ws = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws as unknown as WebSocket);
    await send(registry, ws, { t: "register-webhook", subscriptionId: "sub-live" });
    ws.close(); // buffer while offline; lastAttemptAt stays 0
    await ingress(registry, "sub-live", JSON.stringify({ n: 2 }));
    expect(state.storage.keys("buf:")).toHaveLength(1);

    // The owner reconnects (fresh socket). The alarm is the retry path.
    const ws2 = new FakeWebSocket();
    registry.acceptBackhaul("serverA", ws2 as unknown as WebSocket);
    clock += 60_000; // > 30s retry interval, < 24h TTL
    await state.storage.deleteAlarm();
    await registry.alarm();

    // Re-sent to the open backhaul, still buffered (unacked), alarm rescheduled.
    expect(ws2.frames().some((f) => f.t === "webhook")).toBe(true);
    expect(state.storage.keys("buf:")).toHaveLength(1);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});

function atobToString(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
