import { describe, expect, it, vi } from "vitest";
import { sha256Integrity, type Call } from "@vibestudio/client-host-core";
import { MemoryStore, bytesOf } from "../../core/src/testing.js";
import { ClientLaunchHost, readVerifiedArtifact } from "./clientLaunchHost.js";
import { ControlChannel, createMessagePortPair } from "./controlChannel.js";

async function setup() {
  const [a, b] = createMessagePortPair();
  const main = new ControlChannel(a, "a");
  const store = new MemoryStore();
  const text = "console.log(1)";
  const integrity = await sha256Integrity(bytesOf(text));
  const call: Call = async (service, method) => {
    if (service === "clients" && method === "launch") {
      return {
        state: "ready",
        client: {
          source: "clients/chat",
          id: "chat",
          runtime: "web",
          title: "Chat",
          buildKey: "bk1",
          executionDigest: "a".repeat(64),
          effectiveVersion: "ev",
          hostAbi: "web-host-1",
          artifacts: [{ path: "a.js", role: "asset", contentType: "text/javascript", integrity }],
          grantedCapabilities: [],
          deniedOptional: [],
        },
      };
    }
    if (service === "auth") {
      return {
        credential: "clientcred:secret",
        principalId: "client:chat:web:d",
        deviceId: "d",
        serverId: "s",
        serverBootId: "b",
      };
    }
    throw new Error(`unexpected ${service}.${method}`);
  };
  const fetchArtifact = vi.fn(async () => new Response(text));
  const host = new ClientLaunchHost({
    channel: new ControlChannel(b, "b"),
    call,
    fetchArtifact,
    store,
  });
  const descriptor = {
    host: "desktop",
    hostVersion: "1",
    runtimes: { web: "web-host-1" },
    capabilities: [],
  } as never;
  return { main, host, store, fetchArtifact, descriptor, integrity };
}

describe("ClientLaunchHost", () => {
  it("launches in the connection process and tells main everything but the credential", async () => {
    const t = await setup();
    const states: unknown[] = [];
    t.main.on("launch.state", (event) => states.push(event));
    const result = await t.main.request<any>("launch.start", {
      launchId: 1,
      descriptor: t.descriptor,
      select: { id: "chat" },
    });
    expect(result.state).toBe("ready");
    expect(result.launched.principalId).toBe("client:chat:web:d");
    expect(JSON.stringify(result)).not.toContain("clientcred:secret");
    expect(result.launched.artifacts[0].handle).toContain(t.integrity);
    expect(states).toHaveLength(1);
    expect(t.fetchArtifact).toHaveBeenCalledTimes(1);
  });

  it("admits the principal it launched, for that exact build, and no other", async () => {
    const t = await setup();
    const sessions = t.host.principalSessions("system");
    await expect(sessions.credential("client:chat:web:d")).rejects.toThrow(/No client launched/);
    await t.main.request("launch.start", {
      launchId: 1,
      descriptor: t.descriptor,
      select: { id: "chat" },
    });
    await expect(sessions.credential("client:chat:web:d")).resolves.toBe("clientcred:secret");
    await expect(sessions.credential("client:other:web:d")).rejects.toThrow(/No client launched/);
  });

  it("registers an already running build for its principal, and reports where a session ended", async () => {
    const t = await setup();
    const ended: unknown[] = [];
    t.main.on("clients.session-ended", (event) => ended.push(event));
    const sessions = t.host.principalSessions("workspace-b");
    const principal = await t.main.request("launch.adopt", {
      build: { source: "clients/chat", buildKey: "bk1", executionDigest: "a".repeat(64) },
    });
    expect(principal).toBe("client:chat:web:d");
    await expect(sessions.credential("client:chat:web:d")).resolves.toBe("clientcred:secret");
    const caller = { callerId: "client:chat:web:d", callerKind: "client" as const };
    sessions.sessionEnded(caller, "trust-revoked");
    await vi.waitFor(() =>
      expect(ended).toEqual([{ caller, workspaceId: "workspace-b", reason: "trust-revoked" }])
    );
  });

  it("serves verified bytes and refuses bytes that changed on disk", async () => {
    const t = await setup();
    await t.main.request("launch.start", {
      launchId: 1,
      descriptor: t.descriptor,
      select: { id: "chat" },
    });
    const bytes = await t.main.request<Uint8Array>("artifacts.read", { integrity: t.integrity });
    expect(new TextDecoder().decode(bytes)).toBe("console.log(1)");
    t.store.files.set(t.integrity, { bytes: bytesOf("evil"), name: "a.js" });
    await expect(
      t.main.request("artifacts.read", { integrity: t.integrity })
    ).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    await t.store.remove(t.integrity);
    await expect(
      t.main.request("artifacts.read", { integrity: t.integrity })
    ).rejects.toMatchObject({
      code: "artifact-not-cached",
    });
  });

  it("collects cached artifacts no retained build needs, and drops an ended launch", async () => {
    const t = await setup();
    await t.main.request("launch.start", {
      launchId: 1,
      descriptor: t.descriptor,
      select: { id: "chat" },
    });
    await t.main.request("launch.retain", {
      retained: [{ clientId: "chat", integrities: [t.integrity] }],
    });
    expect(await t.store.has(t.integrity)).toBe(true);
    await t.main.request("launch.retain", { retained: [] });
    expect(await t.store.has(t.integrity)).toBe(false);
    await t.main.request("launch.end", { launchId: 1 });
    await expect(t.main.request("launch.clients-changed", { launchId: 1 })).rejects.toThrow(
      /ended/
    );
  });

  it("checks cached bytes against their integrity in one place", async () => {
    const store = new MemoryStore();
    await expect(readVerifiedArtifact(store, "sha256-AAAA")).rejects.toMatchObject({
      code: "artifact-not-cached",
    });
  });
});
