import { describe, expect, it } from "vitest";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { DeviceOperations } from "@vibestudio/shared/deviceDriver";
import type { ClientWindow } from "./clientWindow.js";
import type { LaunchObservation } from "./clientHost.js";
import {
  DesktopDriverSignals,
  createDesktopDeviceOps,
  type DesktopDriverDeps,
  type WindowTextPort,
} from "./testApiDevice.js";

const never = new AbortController().signal;

const capabilityCard = (approvalId: string) =>
  ({
    approvalId,
    kind: "capability",
    callerId: "worker:x",
    callerKind: "worker",
    repoPath: "r",
    effectiveVersion: "1",
    requestedAt: 1,
    capability: "x.y",
    title: "t",
  }) as unknown as PendingApproval;

function fakeWindow(id: string, clientId: string, buildKey = "b1", capabilities: string[] = []) {
  const window = {
    windowId: id,
    callerId: id,
    hostsPanels: false,
    spec: { clientId, buildKey, capabilities },
  };
  return window as unknown as ClientWindow & { spec: { buildKey: string; capabilities: string[] } };
}

function listing(id: string) {
  return {
    source: `clients/${id}`,
    id,
    runtime: "web",
    title: id,
    hostAbi: "1",
    status: "available",
    isDefault: false,
    trusted: false,
    intents: [{ name: "open", kind: "foreground" }],
    activeBuildKey: "b1",
    canRollback: false,
  };
}

function fixture() {
  const signals = new DesktopDriverSignals();
  const open: ClientWindow[] = [];
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const listed: ReturnType<typeof listing>[] = [];
  const pending: unknown[] = [];
  const launchers: Array<{
    clientId: string;
    paths: string[];
    platform: "linux";
    fingerprint: string;
  }> = [];
  const launcherListeners = new Set<() => void>();
  const sessionListeners = new Set<(caller: { callerId: string }, reason: string) => void>();
  let page = "";
  const pageWaiters = new Set<() => void>();
  const text: WindowTextPort = {
    read: async () => page,
    changed: () => {
      let fired = false;
      let wake: (() => void) | null = null;
      const l = () => {
        fired = true;
        wake?.();
      };
      pageWaiters.add(l);
      return {
        wait: () => new Promise<void>((resolve) => (fired ? resolve() : (wake = resolve))),
        dispose: () => void pageWaiters.delete(l),
      };
    },
    type: async () => undefined,
  };
  const closed: ClientWindow[] = [];
  let launchSelect: unknown = null;
  const deps: DesktopDriverDeps = {
    call: async (service, method, args) => {
      calls.push({ service, method, args });
      if (service === "auth") return { serverBootId: "boot-1" };
      if (service === "clients" && method === "list") return listed;
      if (service === "clients" && method === "invokeIntent") return { text: "hi" };
      if (service === "shellApproval" && method === "listPending") return pending;
      return undefined;
    },
    descriptor: {
      host: "desktop",
      hostVersion: "1",
      runtimes: { web: "1" },
      capabilities: [],
    } as never,
    hostPid: 4242,
    signals,
    clientHost: {
      launch: async (select) => {
        launchSelect = select;
      },
      setDevelopmentMode: () => undefined,
      pendingFor: () => null,
      runningClient: () => ({ deniedOptional: [] }),
    },
    windows: {
      all: () => [...open],
      windowsOf: (clientId) => open.filter((w) => w.spec.clientId === clientId),
      close: (window) => {
        closed.push(window);
      },
    },
    text,
    launchers: {
      install: async (clientId) => {
        launchers.push({
          clientId,
          paths: [`/x/${clientId}.desktop`],
          platform: "linux",
          fingerprint: "f",
        });
        return true;
      },
      records: () => launchers,
      onChanged: (l) => {
        launcherListeners.add(l);
        return () => launcherListeners.delete(l);
      },
    },
    refreshIntegration: async () => undefined,
    onSessionEnded: (l) => {
      sessionListeners.add(l as never);
      return () => sessionListeners.delete(l as never);
    },
  };
  const { ops, close } = createDesktopDeviceOps(deps);
  const run = <K extends keyof DeviceOperations>(name: K, args: unknown, signal = never) =>
    (ops[name] as unknown as (a: unknown, s: AbortSignal) => Promise<unknown>)(args, signal);
  return {
    signals,
    open,
    listed,
    pending,
    calls,
    launchers,
    launcherListeners,
    sessionListeners,
    closed,
    run,
    close,
    setPage(value: string) {
      page = value;
      for (const l of [...pageWaiters]) l();
    },
    get launchSelect() {
      return launchSelect;
    },
  };
}

describe("desktop device ops", () => {
  it("reports identities from the server boot id and the open windows", async () => {
    const f = fixture();
    f.open.push(fakeWindow("w1", "chat"));
    expect(await f.run("identities", {})).toEqual({
      serverBootId: "boot-1",
      hostPid: 4242,
      instances: [{ clientId: "chat", instanceId: "w1", buildKey: "b1" }],
    });
    f.close();
  });

  it("settles waitForListing on clients:changed, never on a clock", async () => {
    const f = fixture();
    const waiting = f.run("waitForListing", { id: "hello", present: true });
    await Promise.resolve();
    f.listed.push(listing("hello"));
    f.signals.clientsChanged();
    expect(await waiting).toMatchObject({ id: "hello", activeBuildKey: "b1" });
    const gone = f.run("waitForListing", { id: "hello", present: false });
    f.listed.length = 0;
    f.signals.clientsChanged();
    expect(await gone).toBeNull();
    f.close();
  });

  it("launches through the host and waits past preparing and approval-required states", async () => {
    const f = fixture();
    const window = fakeWindow("w1", "chat");
    const launching = f.run("launch", { id: "chat" });
    await Promise.resolve();
    const select = f.launchSelect as { id: string };
    f.signals.launchObserved({
      select,
      state: { state: "preparing", phase: "build", reason: "x" },
    } as LaunchObservation);
    // An install review waiting for the person is not an answer either.
    f.signals.launchObserved({
      select,
      state: { state: "approval-required", approvals: [{}] },
    } as unknown as LaunchObservation);
    f.open.push(window);
    f.signals.launchObserved({
      select,
      state: { state: "ready", launched: {} },
    } as unknown as LaunchObservation);
    expect(await launching).toEqual({
      state: "ready",
      surfaceId: "w1",
      instance: { clientId: "chat", instanceId: "w1", buildKey: "b1" },
    });
    f.close();
  });

  it("reports an unavailable launch and rethrows a failed one", async () => {
    const f = fixture();
    const unavailable = f.run("launch", { id: "x" });
    await Promise.resolve();
    f.signals.launchObserved({
      select: f.launchSelect as { id: string },
      state: {
        state: "unavailable",
        reason: "needs camera",
        missing: { capabilities: ["camera"] },
      },
    } as LaunchObservation);
    expect(await unavailable).toEqual({
      state: "unavailable",
      reason: "needs camera",
      missing: { capabilities: ["camera"] },
    });
    const failed = f.run("launch", { id: "y" });
    await Promise.resolve();
    f.signals.launchObserved({
      select: f.launchSelect as { id: string },
      failure: new Error("boom"),
    });
    await expect(failed).rejects.toThrow("boom");
    f.close();
  });

  it("waits for text from page changes and fails when the window closes first", async () => {
    const f = fixture();
    const window = fakeWindow("w1", "chat");
    f.open.push(window);
    const shown = f.run("waitForText", { surfaceId: "w1", text: "Hello" });
    await Promise.resolve();
    f.setPage("Hello world");
    expect(await shown).toBe("Hello world");

    f.setPage("");
    const doomed = f.run("waitForText", { surfaceId: "w1", text: "never" });
    await Promise.resolve();
    f.open.length = 0;
    f.signals.closed(window, "retired");
    await expect(doomed).rejects.toThrow(/closed \(retired\)/u);
    f.close();
  });

  it("answers waitForClosed from a close that happened before the question", async () => {
    const f = fixture();
    const window = fakeWindow("w1", "chat");
    f.open.push(window);
    f.open.length = 0;
    f.signals.closed(window, "trust-revoked");
    expect(await f.run("waitForClosed", { surfaceId: "w1" })).toEqual({ reason: "trust-revoked" });
    expect(await f.run("surfaceInfo", { surfaceId: "w1" })).toMatchObject({
      closed: { reason: "trust-revoked" },
    });
    f.close();
  });

  it("follows build and capability changes of a window", async () => {
    const f = fixture();
    const window = fakeWindow("w1", "chat", "b1");
    f.open.push(window);
    const rebuilt = f.run("waitForBuildChange", { surfaceId: "w1", fromBuildKey: "b1" });
    const granted = f.run("waitForGranted", { surfaceId: "w1", capability: "notifications" });
    await Promise.resolve();
    window.spec.buildKey = "b2";
    window.spec.capabilities = ["notifications"];
    f.signals.changed(window);
    expect(await rebuilt).toEqual({ clientId: "chat", instanceId: "w1", buildKey: "b2" });
    expect(await granted).toMatchObject({ grantedCapabilities: ["notifications"] });
    f.close();
  });

  it("settles waitForBuildChange with the rejection when the rebuild is not adopted", async () => {
    const f = fixture();
    f.open.push(fakeWindow("w1", "chat", "b1"));
    f.listed.push({ ...listing("chat"), lastError: "build failed: TS2304" } as never);
    const rebuilt = f.run("waitForBuildChange", { surfaceId: "w1", fromBuildKey: "b1" });
    await expect(rebuilt).rejects.toMatchObject({
      code: "EBUILDREJECTED",
      message: expect.stringContaining("TS2304"),
    });
    f.close();
  });

  it("wakes waitForBuildChange on a supervision change", async () => {
    const f = fixture();
    f.open.push(fakeWindow("w1", "chat", "b1"));
    f.listed.push(listing("chat") as never);
    const rebuilt = f.run("waitForBuildChange", { surfaceId: "w1", fromBuildKey: "b1" });
    const outcome = rebuilt.then(
      () => null,
      (error: Error) => error
    );
    await Promise.resolve();
    f.listed[0] = { ...listing("chat"), lastError: "adoption refused" } as never;
    f.signals.supervisionChanged();
    expect(await outcome).toMatchObject({ code: "EBUILDREJECTED" });
    f.close();
  });

  it("keeps a session end that arrives before the test asks", async () => {
    const f = fixture();
    for (const l of f.sessionListeners) l({ callerId: "client:chat:web:dev1" }, "trust-revoked");
    expect(await f.run("waitForSessionClosed", { clientId: "chat" })).toEqual({
      reason: "trust-revoked",
      principalId: "client:chat:web:dev1",
    });
    f.close();
  });

  it("closes a surface through the host with a stated reason", async () => {
    const f = fixture();
    const window = fakeWindow("w1", "chat");
    f.open.push(window);
    await f.run("closeSurface", { surfaceId: "w1" });
    expect(f.closed).toEqual([window]);
    f.close();
  });

  it("returns the server's raw intent result and its failure code", async () => {
    const f = fixture();
    expect(await f.run("invokeIntent", { id: "chat", intent: "ask" })).toEqual({
      ok: true,
      text: "hi",
      fields: ["text"],
    });
    f.close();
  });

  it("installs a launcher and waits for its removal from the host's own changes", async () => {
    const f = fixture();
    expect(await f.run("installLauncher", { id: "chat" })).toEqual({
      clientId: "chat",
      kind: ".desktop",
      path: "/x/chat.desktop",
    });
    const removed = f.run("waitForArtifactsRemoved", { clientId: "chat" });
    await Promise.resolve();
    f.launchers.length = 0;
    for (const l of [...f.launcherListeners]) l();
    expect(await removed).toBeNull();
    f.close();
  });

  it("hands each pending approval out once and ends on release", async () => {
    const f = fixture();
    const card = capabilityCard("a1");
    f.pending.push(card);
    expect(await f.run("nextApproval", {})).toMatchObject({ approvalId: "a1" });
    const next = f.run("nextApproval", {});
    await Promise.resolve();
    await f.run("releaseApprovals", {});
    expect(await next).toBeNull();
    f.close();
  });

  it("rejects accept-review for an approval that is not an install review", async () => {
    const f = fixture();
    f.pending.push(capabilityCard("a1"));
    await expect(
      f.run("resolveApproval", { approvalId: "a1", decision: "accept-review" })
    ).rejects.toThrow(/not an install review/u);
    f.close();
  });

  it("cancels a wait when the test gives up", async () => {
    const f = fixture();
    const controller = new AbortController();
    const waiting = f.run("waitForListing", { id: "never", present: true }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("test over"));
    await expect(waiting).rejects.toThrow("test over");
    f.close();
  });
});
