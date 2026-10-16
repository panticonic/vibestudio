import { describe, expect, it } from "vitest";
import { ClientArtifactCache } from "./artifactCache.js";
import { buildHostDescriptor } from "./hostDescriptor.js";
import { ClientLauncher, type Call, type LaunchState } from "./launch.js";
import { MemoryStore, integrityOf, responseOf } from "./testing.js";
import type { ReadyClient } from "@vibestudio/workspace-contracts/clients";

const descriptor = buildHostDescriptor({
  host: "terminal",
  hostVersion: "1",
  implemented: ["notifications"],
});
const DIGEST = "a".repeat(64);
const grantResponse = {
  connectionGrant: "g",
  expiresAt: 1,
  principalId: "client:chat:terminal:dev",
  deviceId: "dev",
  serverId: "s",
  serverBootId: "b",
  workspaceId: "w",
};

async function readyClient(over: Record<string, unknown> = {}): Promise<ReadyClient> {
  return {
    source: "clients/chat-terminal",
    id: "chat",
    runtime: "terminal",
    title: "Chat",
    buildKey: "bk1",
    executionDigest: DIGEST,
    effectiveVersion: "1",
    hostAbi: descriptor.runtimes.terminal!,
    artifacts: [
      {
        path: "main.mjs",
        role: "primary",
        contentType: "text/javascript",
        integrity: await integrityOf("main"),
      },
    ],
    grantedCapabilities: [],
    deniedOptional: [],
    ...over,
  };
}

function setup(results: unknown[]) {
  const calls: { service: string; method: string; args: unknown[] }[] = [];
  const queue = [...results];
  const call: Call = async (service, method, args) => {
    calls.push({ service, method, args });
    if (service === "clients" && method === "launch") return queue.shift();
    if (service === "auth") return grantResponse;
    if (service === "shellApproval" && method === "resolveBootstrap") return [];
    throw new Error(`unexpected ${service}.${method}`);
  };
  const store = new MemoryStore();
  let fetches = 0;
  const routes: string[] = [];
  const cache = new ClientArtifactCache(store, async (route) => {
    fetches += 1;
    routes.push(route);
    return responseOf("main");
  });
  const grantCalls: unknown[] = [];
  const launcher = new ClientLauncher({
    call,
    descriptor,
    cache,
    grants: {
      acquire: async (b) => {
        grantCalls.push(b);
        return grantResponse;
      },
    },
  });
  return { launcher, calls, store, grantCalls, routes, fetches: () => fetches };
}

const launchCalls = (calls: { service: string; method: string }[]) =>
  calls.filter((c) => c.service === "clients").length;

describe("ClientLauncher", () => {
  it("delivers a ready client: verified artifacts, then a grant for the exact build", async () => {
    const t = setup([{ state: "ready", client: await readyClient() }]);
    const state = await t.launcher.launch({ default: true });
    expect(state.state).toBe("ready");
    if (state.state !== "ready") return;
    expect(state.launched.artifacts).toHaveLength(1);
    expect(state.launched.artifacts[0]!.handle).toContain("main.mjs");
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
    expect(state.launched.grant.principalId).toBe("client:chat:terminal:dev");
    expect(t.grantCalls).toEqual([
      { source: "clients/chat-terminal", buildKey: "bk1", executionDigest: DIGEST },
    ]);
    expect(t.calls[0]!.args[0]).toMatchObject({ host: descriptor, select: { default: true } });
  });

  it("fetches only artifacts for this host's platform", async () => {
    const client = await readyClient();
    client.artifacts.push({
      path: "android/index.bundle",
      role: "primary",
      contentType: "application/javascript",
      platform: "android",
      integrity: await integrityOf("android"),
    });
    const t = setup([{ state: "ready", client }]);
    const state = await t.launcher.launch({ default: true });
    expect(state.state).toBe("ready");
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
  });

  it("fails with host-abi-mismatch before fetching or granting", async () => {
    const t = setup([
      { state: "ready", client: await readyClient({ hostAbi: "terminal-host-0" }) },
    ]);
    await expect(t.launcher.launch({ default: true })).rejects.toMatchObject({
      code: "host-abi-mismatch",
    });
    expect(t.fetches()).toBe(0);
    expect(t.grantCalls).toEqual([]);
  });

  it("stores nothing and grants nothing on an integrity mismatch", async () => {
    const client = await readyClient({
      artifacts: [
        {
          path: "main.mjs",
          role: "primary",
          contentType: "text/javascript",
          integrity: await integrityOf("other"),
        },
      ],
    });
    const t = setup([{ state: "ready", client }]);
    await expect(t.launcher.launch({ default: true })).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    expect(t.store.writes).toBe(0);
    expect(t.grantCalls).toEqual([]);
  });

  it("surfaces unavailable and preparing, retrying preparing only on an event", async () => {
    const t = setup([
      { state: "unavailable", reason: "no build", missing: { hostAbi: "x" } },
      { state: "preparing", phase: "build", reason: "building" },
      { state: "ready", client: await readyClient() },
    ]);
    const seen: LaunchState["state"][] = [];
    t.launcher.subscribe((s) => seen.push(s.state));

    expect(await t.launcher.launch({ id: "chat" })).toEqual({
      state: "unavailable",
      reason: "no build",
      missing: { hostAbi: "x" },
    });
    expect(await t.launcher.onClientsChanged()).toBeNull();
    expect(launchCalls(t.calls)).toBe(1);

    expect((await t.launcher.launch({ id: "chat" })).state).toBe("preparing");
    await Promise.resolve();
    expect(launchCalls(t.calls)).toBe(2);

    expect((await t.launcher.onClientsChanged())?.state).toBe("ready");
    expect(launchCalls(t.calls)).toBe(3);
    expect(seen).toEqual(["unavailable", "preparing", "ready"]);
    expect(await t.launcher.onClientsChanged()).toBeNull();
  });

  it("surfaces approval-required and relays the decision, then launches again", async () => {
    const approval = { kind: "unit-install-review", approvalId: "ap1" };
    const t = setup([
      { state: "approval-required", approvals: [approval] },
      { state: "ready", client: await readyClient() },
    ]);
    const gate = await t.launcher.launch({ source: "clients/chat-terminal" });
    expect(gate.state).toBe("approval-required");
    if (gate.state !== "approval-required") return;
    expect(gate.approvals).toEqual([approval]);

    expect(await t.launcher.resolveApprovals(gate.approvals, "deny")).toBeNull();
    expect(launchCalls(t.calls)).toBe(1);
    const next = await t.launcher.resolveApprovals(gate.approvals, "once");
    expect(next?.state).toBe("ready");
    const resolves = t.calls.filter((c) => c.method === "resolveBootstrap");
    expect(resolves.map((c) => c.args)).toEqual([
      [["ap1"], "deny"],
      [["ap1"], "once"],
    ]);
  });

  it("passes rollbackTo through and propagates a launch RPC failure", async () => {
    const t = setup([]);
    await t.launcher.launch({ id: "chat" }, { rollbackTo: "bk0" }).catch(() => undefined);
    expect(t.calls[0]!.args[0]).toMatchObject({ rollbackTo: "bk0" });
  });
});
