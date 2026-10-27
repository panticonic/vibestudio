import type { WorkspaceCreationReviewState } from "@vibestudio/service-schemas/shellApproval";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import { describe, expect, it, vi } from "vitest";
import { ClientArtifactCache } from "./artifactCache.js";
import { buildHostDescriptor } from "./hostDescriptor.js";
import {
  ClientLauncher,
  type Call,
  type LaunchState,
  type ClientLauncherOptions,
} from "./launch.js";
import { MemoryStore, integrityOf, responseOf } from "./testing.js";
import type { ReadyClient } from "@vibestudio/workspace-contracts/clients";

const descriptor = buildHostDescriptor({
  host: "terminal",
  hostVersion: "1",
  implemented: ["notifications"],
});
const DIGEST = "a".repeat(64);
const grantResponse = {
  credential: "clientcred:g",
  principalId: "client:chat:terminal:dev",
  deviceId: "dev",
  serverId: "s",
  serverBootId: "b",
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

function creationApproval(approvalId: string): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    mode: "adopt-root",
    title: "Start this workspace?",
    description: "",
    parts: [],
    summary: { panels: 0, agents: 0, services: 0, clients: 0, extensions: 0 },
    unchangedPartCount: 0,
  };
}

function setup(
  results: unknown[] | (() => Promise<unknown>),
  prepare?: ClientLauncherOptions["prepare"],
  companions?: ClientLauncherOptions["companions"],
  primaryCreation?: {
    state: WorkspaceCreationReviewState;
    approvals?: PendingUnitInstallReviewApproval[];
  }
) {
  const calls: { service: string; method: string; args: unknown[] }[] = [];
  const queue = typeof results === "function" ? [] : [...results];
  const call: Call = async (service, method, args) => {
    calls.push({ service, method, args });
    if (service === "clients" && method === "launch")
      return typeof results === "function" ? results() : queue.shift();
    if (service === "auth") return grantResponse;
    if (service === "shellApproval" && method === "getWorkspaceCreationReviewState")
      return primaryCreation?.state ?? { status: "resolved" };
    if (service === "shellApproval" && method === "listPending")
      return primaryCreation?.approvals ?? [];
    if (service === "shellApproval" && method === "resolveBootstrap") {
      if (primaryCreation && args[1] === "once") primaryCreation.state = { status: "resolved" };
      return [];
    }
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
    prepare,
    companions,
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
    expect(t.calls.find((call) => call.service === "clients")!.args[0]).toMatchObject({
      host: descriptor,
      select: { default: true },
    });
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
    expect(t.calls.find((call) => call.service === "clients")!.args[0]).toMatchObject({
      rollbackTo: "bk0",
    });
  });

  it("prepares workspace source only after its ordinary creation review is granted", async () => {
    const prepare = vi.fn(async () => {});
    const approval = creationApproval("ap:workspace");
    const primary = {
      state: {
        status: "pending",
        approvalId: approval.approvalId,
        partCount: 1,
      } as WorkspaceCreationReviewState,
      approvals: [approval],
    };
    const t = setup([{ state: "ready", client: await readyClient() }], prepare, [], primary);
    const gate = await t.launcher.launch({ default: true });
    expect(gate).toEqual({ state: "approval-required", approvals: [approval] });
    expect(prepare).not.toHaveBeenCalled();
    expect(launchCalls(t.calls)).toBe(0);
    expect(t.fetches()).toBe(0);
    if (gate.state !== "approval-required") throw new Error("Expected workspace review");
    await t.launcher.resolveApprovals(gate.approvals, "deny");
    expect(prepare).not.toHaveBeenCalled();
    expect(launchCalls(t.calls)).toBe(0);
    expect((await t.launcher.resolveApprovals(gate.approvals, "once"))?.state).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
  });

  it.each(["host ABI is incompatible", "source build is broken"])(
    "prepares admitted source before attempting an old client whose %s",
    async (reason) => {
      let current = false;
      const client = await readyClient({ buildKey: "bk2" });
      const prepare = vi.fn(async () => {
        current = true;
      });
      const t = setup(
        async () => (current ? { state: "ready", client } : { state: "unavailable", reason }),
        prepare
      );
      expect((await t.launcher.launch({ default: true })).state).toBe("ready");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(launchCalls(t.calls)).toBe(1);
      expect(t.routes).toEqual(["/_a/bk2/main.mjs"]);
      expect(t.grantCalls).toEqual([
        { source: "clients/chat-terminal", buildKey: "bk2", executionDigest: DIGEST },
      ]);
    }
  );

  it("waits for the new source build through ordinary lifecycle events without delivering an old build", async () => {
    const prepare = vi.fn(async () => {});
    const t = setup(
      [
        { state: "preparing", phase: "build", reason: "Building updated source" },
        { state: "ready", client: await readyClient({ buildKey: "bk2" }) },
      ],
      prepare
    );
    expect(await t.launcher.launch({ source: "clients/chat-terminal" })).toEqual({
      state: "preparing",
      phase: "build",
      reason: "Building updated source",
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(launchCalls(t.calls)).toBe(1);
    expect(t.fetches()).toBe(0);
    expect(t.grantCalls).toEqual([]);
    expect((await t.launcher.onClientsChanged())?.state).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(t.routes).toEqual(["/_a/bk2/main.mjs"]);
  });

  it("uses the existing client review gate when prepared source needs a unit approval", async () => {
    const prepare = vi.fn(async () => {});
    const approval = { kind: "unit-install-review", approvalId: "ap:updated-build" };
    const t = setup(
      [
        { state: "approval-required", approvals: [approval] },
        { state: "ready", client: await readyClient({ buildKey: "bk2" }) },
      ],
      prepare
    );
    const state = await t.launcher.launch({ default: true });
    expect(state).toEqual({ state: "approval-required", approvals: [approval] });
    expect(t.fetches()).toBe(0);
    if (state.state !== "approval-required") throw new Error("Expected updated source review");
    expect((await t.launcher.resolveApprovals(state.approvals, "once"))?.state).toBe("ready");
    expect(t.routes).toEqual(["/_a/bk2/main.mjs"]);
  });

  it("propagates preparation failure before resolving or delivering a client", async () => {
    const failure = new Error("Workspace update failed");
    const prepare = vi.fn(async () => {
      throw failure;
    });
    const t = setup([{ state: "ready", client: await readyClient() }], prepare);
    await expect(t.launcher.launch({ default: true })).rejects.toBe(failure);
    expect(launchCalls(t.calls)).toBe(0);
    expect(t.fetches()).toBe(0);
    expect(t.grantCalls).toEqual([]);
  });

  it("resolves the current client once after successful admission and preparation", async () => {
    const prepare = vi.fn(async () => {});
    const t = setup([{ state: "ready", client: await readyClient() }], prepare);
    expect((await t.launcher.launch({ default: true })).state).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(launchCalls(t.calls)).toBe(1);
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
  });

  it("joins a pending companion creation review even when the selected client is ready", async () => {
    const approval = creationApproval("ap:personal");
    let approved = false;
    const companion = vi.fn<Call>(async (service, method, args) => {
      expect(service).toBe("shellApproval");
      if (method === "getWorkspaceCreationReviewState")
        return approved
          ? { status: "resolved" }
          : { status: "pending", approvalId: approval.approvalId, partCount: 1 };
      if (method === "listPending") return [approval];
      if (method === "resolveBootstrap") {
        expect(args).toEqual([[approval.approvalId], "once"]);
        approved = true;
        return [];
      }
      throw new Error(`Unexpected companion method ${method}`);
    });
    const prepare = vi.fn(async () => {});
    const t = setup(
      [
        { state: "ready", client: await readyClient() },
        { state: "ready", client: await readyClient() },
      ],
      prepare,
      [companion]
    );
    const seen: LaunchState["state"][] = [];
    t.launcher.subscribe((state) => seen.push(state.state));
    const gate = await t.launcher.launch({ default: true });
    expect(gate).toEqual({ state: "approval-required", approvals: [approval] });
    expect(t.launcher.state).toEqual(gate);
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
    if (gate.state !== "approval-required") throw new Error("Expected companion review");
    expect((await t.launcher.resolveApprovals(gate.approvals, "once"))?.state).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
    expect(t.calls.filter((call) => call.method === "resolveBootstrap")).toEqual([]);
    expect(seen).toEqual(["approval-required", "ready"]);
  });

  it("waits for a preparing companion through ordinary launch events before preparation", async () => {
    let ready = false;
    const companion = vi.fn<Call>(async (service, method) => {
      expect(service).toBe("shellApproval");
      if (method === "getWorkspaceCreationReviewState")
        return { status: ready ? "resolved" : "preparing" };
      throw new Error(`Unexpected companion method ${method}`);
    });
    const prepare = vi.fn(async () => {});
    const t = setup(
      [
        { state: "ready", client: await readyClient() },
        { state: "ready", client: await readyClient() },
      ],
      prepare,
      [companion]
    );
    expect(await t.launcher.launch({ default: true })).toEqual({
      state: "preparing",
      phase: "resolve",
      reason: "Getting your workspaces ready",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
    expect(launchCalls(t.calls)).toBe(0);
    ready = true;
    expect((await t.launcher.onClientsChanged())?.state).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(launchCalls(t.calls)).toBe(1);
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
  });

  it("reports an authoritative companion creation failure without preparing or delivering a client", async () => {
    const reason = "Personal template acquisition failed: exact source unavailable";
    const companion: Call = async (_service, method) => {
      if (method === "getWorkspaceCreationReviewState") return { status: "failed", error: reason };
      throw new Error(`Unexpected companion method ${method}`);
    };
    const prepare = vi.fn(async () => {});
    const t = setup([{ state: "ready", client: await readyClient() }], prepare, [companion]);
    expect(await t.launcher.launch({ default: true })).toEqual({ state: "unavailable", reason });
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
    expect(t.grantCalls).toEqual([]);
    expect(await t.launcher.onClientsChanged()).toBeNull();
  });

  it("waits on lifecycle events when a companion's pending approval snapshot is not yet listed", async () => {
    const approval = creationApproval("ap:personal");
    let listed = false;
    const companion: Call = async (_service, method) => {
      if (method === "getWorkspaceCreationReviewState")
        return { status: "pending", approvalId: approval.approvalId, partCount: 1 };
      if (method === "listPending") return listed ? [approval] : [];
      throw new Error(`Unexpected companion method ${method}`);
    };
    const prepare = vi.fn(async () => {});
    const t = setup(
      [
        { state: "ready", client: await readyClient() },
        { state: "ready", client: await readyClient() },
      ],
      prepare,
      [companion]
    );
    expect((await t.launcher.launch({ default: true })).state).toBe("preparing");
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
    expect(launchCalls(t.calls)).toBe(0);
    listed = true;
    expect(await t.launcher.onClientsChanged()).toEqual({
      state: "approval-required",
      approvals: [approval],
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
  });

  it("keeps an unresolved companion at the existing preparation gate", async () => {
    const companion: Call = async (_service, method) => {
      if (method === "getWorkspaceCreationReviewState") return { status: "unresolved" };
      throw new Error(`Unexpected companion method ${method}`);
    };
    const prepare = vi.fn(async () => {});
    const t = setup([{ state: "ready", client: await readyClient() }], prepare, [companion]);
    expect(await t.launcher.launch({ default: true })).toEqual({
      state: "preparing",
      phase: "resolve",
      reason: "Getting your workspaces ready",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(t.fetches()).toBe(0);
  });

  it("retains readiness events received during an older companion snapshot and drains them once ready", async () => {
    let started!: () => void;
    let release!: (value: { status: "preparing" }) => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const snapshot = new Promise<{ status: "preparing" }>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const companion: Call = async (_service, method) => {
      if (method !== "getWorkspaceCreationReviewState") throw new Error(`Unexpected ${method}`);
      if (reads++ === 0) {
        started();
        return snapshot;
      }
      return { status: "resolved" };
    };
    const prepare = vi.fn(async () => {});
    const t = setup(
      [
        { state: "ready", client: await readyClient() },
        { state: "ready", client: await readyClient() },
      ],
      prepare,
      [companion]
    );
    const launching = t.launcher.launch({ default: true });
    await reading;
    // The lifecycle is now ready, but the in-flight RPC returns its preceding
    // preparing snapshot. Both genuine events must wait behind that response.
    const firstEvent = t.launcher.onClientsChanged();
    const secondEvent = t.launcher.onClientsChanged();
    release({ status: "preparing" });
    expect((await launching).state).toBe("preparing");
    expect((await firstEvent)?.state).toBe("ready");
    expect(await secondEvent).toBeNull();
    expect(launchCalls(t.calls)).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(t.routes).toEqual(["/_a/bk1/main.mjs"]);
  });
});
