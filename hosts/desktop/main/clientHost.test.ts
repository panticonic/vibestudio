import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Integrity, type Call } from "@vibestudio/client-host-core";
import type { SupervisionChange } from "@vibestudio/shared/events";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { MemoryStore, bytesOf } from "../../core/src/testing.js";
import { DesktopClientHost } from "./clientHost.js";
import { ClientLaunchHost } from "../connection/clientLaunchHost.js";
import { ControlChannel, createMessagePortPair } from "../connection/controlChannel.js";
import { ClientLaunchLink } from "./clientLaunchLink.js";
import { ClientHostState } from "./clientHostState.js";
import { SupervisionRelay } from "./supervisionRelay.js";
import { ClientWindows, type ClientWindow, type ClientWindowSpec } from "./clientWindow.js";
import type { LaunchGateStatus } from "../bootstrap/launchGateModel.js";

const DEVICE = "dev1";
const PRINCIPAL = `client:browser:web:${DEVICE}`;
const DIGEST = (n: number) => String(n).repeat(64).slice(0, 64);

const REQUESTS = [
  {
    capability: "theme",
    resource: { kind: "prefix", prefix: "" },
    tier: "gated",
    evidence: "intentional-broad",
  },
];

class FakeWindow implements ClientWindow {
  readonly callerId: string;
  readonly swaps: ClientWindowSpec[] = [];
  readonly sent: Array<[string, unknown[]]> = [];
  closeCalls = 0;
  shown = 0;
  constructor(
    readonly windowId: string,
    public spec: ClientWindowSpec,
    readonly hostsPanels: boolean,
    private readonly onClose: (window: FakeWindow) => void
  ) {
    this.callerId = hostsPanels ? `native:${spec.principalId}` : windowId;
  }
  contents() {
    return null;
  }
  browserWindow() {
    return null;
  }
  async load() {}
  show() {
    this.shown += 1;
  }
  async swap(next: ClientWindowSpec) {
    this.swaps.push(next);
    this.spec = next;
  }
  setCapabilities(capabilities: readonly ClientCapability[]) {
    this.spec = { ...this.spec, capabilities };
  }
  send(channel: string, ...args: unknown[]) {
    this.sent.push([channel, args]);
  }
  close() {
    this.closeCalls += 1;
    this.onClose(this);
  }
}

interface BuildFiles {
  buildKey: string;
  files: Record<string, string>;
}

async function readyResult(
  build: BuildFiles,
  over: { grantedCapabilities?: ClientCapability[]; intent?: unknown; digest?: string } = {}
) {
  const artifacts = [];
  for (const [path, text] of Object.entries(build.files)) {
    artifacts.push({
      path,
      role: path.endsWith(".html") ? "primary" : "asset",
      contentType: path.endsWith(".html") ? "text/html" : "text/javascript",
      integrity: await sha256Integrity(bytesOf(text)),
    });
  }
  return {
    state: "ready",
    client: {
      source: "clients/desktop-browser",
      id: "browser",
      runtime: "web",
      title: "Browser",
      buildKey: build.buildKey,
      executionDigest: over.digest ?? DIGEST(Number(build.buildKey.slice(2))),
      effectiveVersion: `ev-${build.buildKey}`,
      hostAbi: "web-host-1",
      artifacts,
      grantedCapabilities: over.grantedCapabilities ?? ["device-session", "panel-hosting"],
      deniedOptional: [],
      ...(over.intent ? { intent: over.intent } : {}),
    },
  };
}

const BUILD1: BuildFiles = {
  buildKey: "bk1",
  files: { "index.html": "<html>1</html>", "bundle.js": "one" },
};
const BUILD2: BuildFiles = {
  buildKey: "bk2",
  files: { "index.html": "<html>2</html>", "bundle.js": "two" },
};

function adopted(buildKey: string, previous: string): SupervisionChange {
  return {
    identity: { kind: "client", entityId: "browser" },
    source: "clients/desktop-browser",
    status: "running",
    lastError: null,
    artifact: {
      effectiveVersion: `ev-${buildKey}`,
      buildKey,
      executionDigest: DIGEST(Number(buildKey.slice(2))),
    },
    canRollback: true,
    change: "adopted",
    previousBuildKey: previous,
    previousEffectiveVersion: `ev-${previous}`,
    client: {
      id: "browser",
      runtime: "web",
      grantedCapabilities: ["device-session", "panel-hosting"],
    },
  };
}

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: { builds?: BuildFiles[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "client-host-"));
  tmp.push(dir);
  const launches: unknown[] = [];
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const metadataDigest = new Map<string, string>();
  const served = new Map<string, string>();
  for (const build of options.builds ?? [BUILD1, BUILD2]) {
    for (const [path, text] of Object.entries(build.files)) {
      served.set(`/_a/${build.buildKey}/${path}`, text);
    }
    metadataDigest.set(build.buildKey, DIGEST(Number(build.buildKey.slice(2))));
  }
  const fetched: string[] = [];
  const call: Call = async (service, method, args) => {
    calls.push({ service, method, args });
    if (service === "clients" && method === "launch") {
      const next = launches.shift();
      if (!next) throw new Error("unexpected clients.launch");
      return next;
    }
    if (service === "build" && method === "getBuildMetadata") {
      const key = args[0] as string;
      const digest = metadataDigest.get(key);
      return digest
        ? {
            kind: "client",
            name: "browser",
            buildKey: key,
            sourcePath: "clients/desktop-browser",
            ev: `ev-${key}`,
            sourceStateHash: null,
            sourcemap: false,
            execution: {
              version: 1,
              sourceState: {
                kind: "workspace",
                workspaceId: "workspace:test",
                effectiveVersion: digest,
                state: { kind: "event", eventId: "event:test" },
                contentRoots: [
                  { repoPath: "clients/desktop-browser", stateHash: `state:${digest}` },
                ],
                sourceClosureDigest: digest,
              },
              recipeDigest: digest,
              buildKey: digest,
              artifactDigest: digest,
              executionDigest: digest,
            },
            authority: { requests: REQUESTS, serviceRequests: [], provides: [] },
            details: {
              kind: "client",
              clientId: "browser",
              runtime: "web",
              hostAbi: "web-host-1",
              provider: null,
            },
            builtAt: "2026-01-01",
          }
        : null;
    }
    if (service === "auth" && method === "grantClientPrincipal") {
      return {
        connectionGrant: `grant-${calls.length}`,
        expiresAt: 1,
        principalId: PRINCIPAL,
        deviceId: DEVICE,
        serverId: "s",
        serverBootId: "b",
        workspaceId: "system",
      };
    }
    if (service === "shellApproval" && method === "resolveBootstrap") return [];
    throw new Error(`unexpected ${service}.${method}`);
  };
  const store = new MemoryStore();
  const windowsMade: FakeWindow[] = [];
  const closedWindows: Array<[FakeWindow, string | null]> = [];
  let host!: DesktopClientHost;
  const windows: ClientWindows = new ClientWindows(
    {
      plain: (windowId, spec) => {
        const window = new FakeWindow(windowId, spec, false, (w) => windows.notifyClosed(w));
        windowsMade.push(window);
        return window;
      },
      panelHosting: (windowId, spec) => {
        const window = new FakeWindow(windowId, spec, true, (w) => windows.notifyClosed(w));
        windowsMade.push(window);
        return window;
      },
    },
    {
      opened: async () => undefined,
      closed: (window, reason) => {
        closedWindows.push([window as FakeWindow, reason]);
        host.windowClosed(window);
      },
    }
  );
  const gate: Array<{ title: string | null; status: LaunchGateStatus }> = [];
  let dismissed = 0;
  const notices: Array<[string, string]> = [];
  const offered: string[] = [];
  const supervision = new SupervisionRelay();
  const state = new ClientHostState(join(dir, "state.json"));
  // Launch, the artifact cache and grants run behind the control channel, as in the app.
  const [mainPort, utilityPort] = createMessagePortPair();
  const launchHost = new ClientLaunchHost({
    channel: new ControlChannel(utilityPort, "b"),
    call,
    fetchArtifact: async (route) => {
      fetched.push(route);
      const text = served.get(route);
      return text === undefined ? new Response("missing", { status: 404 }) : new Response(text);
    },
    store,
  });
  const launchLink = new ClientLaunchLink(new ControlChannel(mainPort, "a"));
  host = new DesktopClientHost({
    hostVersion: "1.0.0",
    call,
    launches: launchLink,
    windows,
    supervision,
    state,
    gate: {
      present: (title, status) => gate.push({ title, status }),
      dismiss: () => {
        dismissed += 1;
      },
    },
    workspaceId: () => "system",
    notify: (title, message) => notices.push([title, message]),
    updatesChanged: (clientId) => offered.push(clientId),
  });
  host.follow();
  return {
    host,
    launches,
    calls,
    fetched,
    store,
    windows,
    windowsMade,
    closedWindows,
    gate,
    notices,
    offered,
    supervision,
    state,
    metadataDigest,
    served,
    dismissed: () => dismissed,
    principals: launchHost.principalSessions(),
    launchLink,
    grantCalls: () => calls.filter((c) => c.method === "grantClientPrincipal"),
  };
}

describe("DesktopClientHost launch and delivery", () => {
  it("fetches by gateway route, verifies integrity, grants the exact build, and opens its window", async () => {
    const t = harness();
    t.launches.push(await readyResult(BUILD1));
    const first = await t.host.launch({ default: true });

    expect(first.state).toBe("ready");
    expect(t.fetched.sort()).toEqual(["/_a/bk1/bundle.js", "/_a/bk1/index.html"]);
    expect(t.grantCalls().map((c) => c.args[0])).toEqual([
      { source: "clients/desktop-browser", buildKey: "bk1", executionDigest: DIGEST(1) },
    ]);
    expect(t.windowsMade).toHaveLength(1);
    const [window] = t.windowsMade;
    expect(window!.hostsPanels).toBe(true);
    expect(window!.spec).toMatchObject({
      clientId: "browser",
      principalId: PRINCIPAL,
      buildKey: "bk1",
      entryUrl: "vs-client://browser/bk1/index.html",
      capabilities: ["device-session", "panel-hosting"],
      workspaceId: "system",
      codeIdentity: {
        source: "clients/desktop-browser",
        executionDigest: DIGEST(1),
        requested: REQUESTS,
      },
    });
    expect(t.dismissed()).toBe(1);
    // The page is servable only because its bytes were verified into the store.
    expect(t.host.catalog.lookup("vs-client://browser/bk1/index.html")).not.toBeNull();
  });

  it("opens a client without panel hosting in a plain window", async () => {
    const t = harness();
    t.launches.push(await readyResult(BUILD1, { grantedCapabilities: ["device-session"] }));
    await t.host.launch({ id: "browser" });
    expect(t.windowsMade[0]!.hostsPanels).toBe(false);
  });

  it("stores nothing, grants nothing and opens nothing when the bytes do not match", async () => {
    const t = harness();
    t.served.set("/_a/bk1/bundle.js", "tampered in transit");
    t.launches.push(await readyResult(BUILD1));

    await expect(t.host.launch({ default: true })).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    expect(t.grantCalls()).toEqual([]);
    expect(t.windowsMade).toEqual([]);
    expect(t.host.catalog.lookup("vs-client://browser/bk1/bundle.js")).toBeNull();
    const last = t.gate.at(-1)!.status;
    expect(last.status).toBe("failed");
    expect(last.status === "failed" && last.reason).toMatch(
      /does not match its declared integrity/
    );
  });

  it("refuses a build whose sealed execution identity is not the one the server launched", async () => {
    const t = harness();
    t.metadataDigest.set("bk1", DIGEST(9));
    t.launches.push(await readyResult(BUILD1));

    await t.host.launch({ default: true });
    expect(t.windowsMade).toEqual([]);
    expect(t.gate.at(-1)!.status).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/sealed execution identity/),
    });
  });

  it("shows a review on the gate, relays the decision, and opens the client once approved", async () => {
    const t = harness();
    const approval = { kind: "unit-install-review", approvalId: "ap1" };
    t.launches.push({ state: "approval-required", approvals: [approval] });
    t.launches.push(await readyResult(BUILD1));

    await t.host.launch({ default: true });
    expect(t.gate.at(-1)!.status).toMatchObject({
      status: "approval-required",
      approvals: [approval],
    });
    expect(t.windowsMade).toEqual([]);

    await t.host.resolveGateApprovals("once");
    await vi.waitFor(() => expect(t.windowsMade).toHaveLength(1));
    expect(t.calls.find((c) => c.method === "resolveBootstrap")!.args).toEqual([["ap1"], "once"]);
  });

  it("stands down without opening anything when the person declines the review", async () => {
    const t = harness();
    t.launches.push({
      state: "approval-required",
      approvals: [{ kind: "unit-install-review", approvalId: "ap1" }],
    });
    await t.host.launch({ default: true });

    await t.host.resolveGateApprovals("deny");
    expect(t.gate.at(-1)!.status).toMatchObject({ status: "unavailable", declined: true });
    expect(t.calls.find((c) => c.method === "resolveBootstrap")!.args).toEqual([["ap1"], "deny"]);
    expect(t.windowsMade).toEqual([]);
    await expect(t.host.resolveGateApprovals("once")).rejects.toThrow(/no review waiting/);
  });

  it("continues a launch that waits on a build when the server announces a change, not on a timer", async () => {
    const t = harness();
    t.launches.push({ state: "preparing", phase: "build", reason: "building" });
    t.launches.push(await readyResult(BUILD1));

    await t.host.launch({ default: true });
    expect(t.gate.at(-1)!.status).toMatchObject({ status: "preparing", phase: "build" });
    expect(t.windowsMade).toEqual([]);

    t.host.clientsChanged();
    await vi.waitFor(() => expect(t.windowsMade).toHaveLength(1));
  });

  it("continues a review that was answered elsewhere", async () => {
    const t = harness();
    t.launches.push({
      state: "approval-required",
      approvals: [{ kind: "unit-install-review", approvalId: "ap1" }],
    });
    t.launches.push(await readyResult(BUILD1));
    await t.host.launch({ default: true });

    t.host.approvalResolved({ approvalKind: "unit-install-review", granted: true } as never);
    await vi.waitFor(() => expect(t.windowsMade).toHaveLength(1));
  });
});

describe("DesktopClientHost updates", () => {
  async function running(t: ReturnType<typeof harness>) {
    t.launches.push(await readyResult(BUILD1));
    await t.host.launch({ default: true });
    return t.windowsMade[0]!;
  }

  it("tells the client its own pending update, and only its own", async () => {
    const t = harness();
    await running(t);
    expect(t.host.pendingFor("browser")).toBeNull();
    t.supervision.emit(adopted("bk2", "bk1"));
    await vi.waitFor(() => expect(t.offered).toEqual(["browser"]));
    expect(t.host.pendingFor("browser")).toMatchObject({ appId: "browser", buildKey: "bk2" });
    expect(t.host.pendingFor("chat")).toBeNull();
  });

  it("offers a newer build and swaps the window to it only when the person takes it", async () => {
    const t = harness();
    const window = await running(t);

    t.supervision.emit(adopted("bk2", "bk1"));
    await vi.waitFor(() => expect(t.host.list()).toHaveLength(1));
    expect(t.host.list()[0]).toMatchObject({
      appId: "browser",
      buildKey: "bk2",
      previousBuildKey: "bk1",
      url: "vs-client://browser/bk2/",
    });
    expect(window.swaps).toEqual([]);

    t.launches.push(await readyResult(BUILD2));
    await expect(t.host.apply("browser")).resolves.toBe(true);
    expect(window.swaps).toHaveLength(1);
    expect(window.swaps[0]).toMatchObject({
      buildKey: "bk2",
      entryUrl: "vs-client://browser/bk2/index.html",
    });
    expect(t.host.list()).toEqual([]);
    // The old build is no longer served; the new one is.
    expect(t.host.catalog.lookup("vs-client://browser/bk1/index.html")).toBeNull();
    expect(t.host.catalog.lookup("vs-client://browser/bk2/index.html")).not.toBeNull();
    await expect(t.host.apply("browser")).resolves.toBe(false);
  });

  it("takes a rebuild immediately in development mode, for that client only", async () => {
    const t = harness();
    const window = await running(t);
    t.host.setDevelopmentMode("browser", true);
    expect(new ClientHostState(join(tmp[0]!, "state.json")).isDevelopment("browser")).toBe(true);

    t.launches.push(await readyResult(BUILD2));
    t.supervision.emit(adopted("bk2", "bk1"));
    await vi.waitFor(() => expect(window.swaps).toHaveLength(1));
    expect(window.swaps[0]!.buildKey).toBe("bk2");
    expect(t.host.list()).toEqual([]);
  });

  it("ignores announcements about other clients, builds it already runs, and a refused update", async () => {
    const t = harness();
    await running(t);
    t.supervision.emit({ ...adopted("bk2", "bk1"), source: "clients/other" });
    t.supervision.emit(adopted("bk1", "bk0"));
    t.supervision.emit({ ...adopted("bk2", "bk1"), change: "update-rejected" });
    expect(t.host.list()).toEqual([]);
  });

  it("does not move a window whose update needs a new review: the gate asks first", async () => {
    const t = harness();
    const window = await running(t);
    t.supervision.emit(adopted("bk2", "bk1"));
    await vi.waitFor(() => expect(t.host.list()).toHaveLength(1));
    t.launches.push({
      state: "approval-required",
      approvals: [{ kind: "unit-install-review", approvalId: "ap2" }],
    });

    await t.host.apply("browser");
    expect(t.gate.at(-1)!.status.status).toBe("approval-required");
    expect(window.swaps).toEqual([]);
  });
});

describe("DesktopClientHost principal sessions and trust", () => {
  async function running(t: ReturnType<typeof harness>) {
    t.launches.push(await readyResult(BUILD1));
    await t.host.launch({ default: true });
    return t.windowsMade[0]!;
  }

  it("grants a fresh connection for the exact verified build, only to its own principal", async () => {
    const t = harness();
    await running(t);
    const sessions = t.principals;

    const before = t.grantCalls().length;
    await expect(sessions.connectionGrant(PRINCIPAL)).resolves.toMatch(/^grant-/);
    await expect(sessions.connectionGrant(PRINCIPAL)).resolves.toMatch(/^grant-/);
    const requested = t
      .grantCalls()
      .slice(before)
      .map((c) => c.args[0]);
    expect(requested).toEqual([
      { source: "clients/desktop-browser", buildKey: "bk1", executionDigest: DIGEST(1) },
      { source: "clients/desktop-browser", buildKey: "bk1", executionDigest: DIGEST(1) },
    ]);
    await expect(sessions.connectionGrant("client:chat:web:dev1")).rejects.toThrow(
      /No client launched/
    );
  });

  it("closes a client whose trust was revoked, says why, and relaunches what the server still offers", async () => {
    const t = harness();
    const window = await running(t);
    t.launches.push({
      state: "unavailable",
      reason: "browser requires hub-control, which is no longer granted",
      missing: { capabilities: ["hub-control"] },
    });

    t.host.sessionEnded(
      { callerId: PRINCIPAL, callerKind: "client", instanceId: window.callerId },
      "trust-revoked"
    );
    await vi.waitFor(() => expect(t.gate.at(-1)!.status.status).toBe("unavailable"));

    expect(window.closeCalls).toBe(1);
    expect(t.closedWindows[0]![1]).toBe("trust-revoked");
    expect(t.notices[0]![0]).toBe("Browser was closed");
    expect(t.notices[0]![1]).toMatch(/no longer holds the device powers/);
    // The gate shows the server's reason before the window goes, so the app never has no window.
    const order = t.gate.map((entry) => entry.status.status);
    expect(order[0]).toBe("starting");
    expect(t.gate.at(-1)!.status).toMatchObject({ reason: expect.stringContaining("hub-control") });
    expect(t.host.catalog.lookup("vs-client://browser/bk1/index.html")).toBeNull();
  });

  it("relaunches without an optional capability the server withdrew", async () => {
    const t = harness();
    const window = await running(t);
    t.launches.push(
      await readyResult(BUILD1, { grantedCapabilities: ["device-session", "panel-hosting"] })
    );

    t.host.sessionEnded({ callerId: PRINCIPAL, callerKind: "client" }, "trust-revoked");
    await vi.waitFor(() => expect(t.windowsMade).toHaveLength(2));
    expect(window.closeCalls).toBe(1);
    expect(t.windowsMade[1]!.spec.capabilities).toEqual(["device-session", "panel-hosting"]);
  });

  it("closes a retired client for good", async () => {
    const t = harness();
    const window = await running(t);
    t.host.sessionEnded({ callerId: PRINCIPAL, callerKind: "client" }, "retired");
    await vi.waitFor(() => expect(window.closeCalls).toBe(1));
    expect(t.launches).toEqual([]);
    expect(t.notices[0]![1]).toMatch(/retired/);
  });

  it("does not act on a session that ended for another reason", async () => {
    const t = harness();
    const window = await running(t);
    t.host.sessionEnded({ callerId: PRINCIPAL, callerKind: "client" }, "Token revoked");
    expect(window.closeCalls).toBe(0);
  });

  it("applies the capability set the server vets to a running client at once", async () => {
    const t = harness();
    const window = await running(t);
    t.supervision.emit({
      ...adopted("bk1", "bk1"),
      change: "status",
      client: {
        id: "browser",
        runtime: "web",
        grantedCapabilities: ["device-session", "panel-hosting", "hub-control"],
      },
    });
    expect(window.spec.capabilities).toEqual(["device-session", "panel-hosting", "hub-control"]);
    // Panel hosting is what the window is: losing it is a launch, not a setting.
    t.supervision.emit({
      ...adopted("bk1", "bk1"),
      change: "status",
      client: { id: "browser", runtime: "web", grantedCapabilities: ["device-session"] },
    });
    expect(window.spec.capabilities).toContain("panel-hosting");
  });
});

describe("DesktopClientHost intents", () => {
  it("hands a foreground intent from a client link to a running client, held until it subscribes", async () => {
    const t = harness();
    t.launches.push(await readyResult(BUILD1));
    await t.host.launch({ default: true });
    const window = t.windowsMade[0]!;

    t.launches.push(
      await readyResult(BUILD1, {
        intent: { name: "open-panel", params: { panel: "panels/chat" } },
      })
    );
    await expect(
      t.host.openLink("vibestudio://c/browser/open-panel?panel=panels%2Fchat")
    ).resolves.toBe(true);
    expect(t.calls.filter((c) => c.method === "launch").at(-1)!.args[0]).toMatchObject({
      select: { id: "browser", intent: "open-panel", params: { panel: "panels/chat" } },
    });
    // No second window: the running client is focused and receives the intent.
    expect(t.windowsMade).toHaveLength(1);
    expect(window.shown).toBeGreaterThan(0);

    const received: unknown[] = [];
    t.host.subscribeIntents(window.windowId, (intent) => received.push(intent));
    expect(received).toEqual([{ name: "open-panel", params: { panel: "panels/chat" } }]);
    t.launches.push(
      await readyResult(BUILD1, { intent: { name: "open-panel", params: { panel: "second" } } })
    );
    await t.host.openLink("vibestudio://c/browser/open-panel?panel=second");
    expect(received).toHaveLength(2);
  });

  it("leaves links of other handlers alone and reports a malformed client link", async () => {
    const t = harness();
    await expect(t.host.openLink("vibestudio://panel?v=1&source=x")).resolves.toBe(false);
    await expect(t.host.openLink("vibestudio://c/Bad_ID/open")).resolves.toBe(true);
    expect(t.notices[0]![0]).toBe("Couldn't open that link");
    expect(t.calls.filter((c) => c.method === "launch")).toEqual([]);
  });

  it("opens another window of a running client at its own verified page, and no other", async () => {
    const t = harness();
    t.launches.push(await readyResult(BUILD1, { grantedCapabilities: ["device-session"] }));
    await t.host.launch({ id: "browser" });
    await t.host.openSibling("browser", "vs-client://browser/bk1/index.html");
    expect(t.windows.windowsOf("browser")).toHaveLength(2);
    await expect(
      t.host.openSibling("browser", "vs-client://browser/bk1/evil.html")
    ).rejects.toThrow(/not a verified page/);
    await expect(t.host.openSibling("chat", "vs-client://chat/x/index.html")).rejects.toThrow(
      /not running/
    );
  });

  it("stops a client when its last window closes", async () => {
    const t = harness();
    t.launches.push(await readyResult(BUILD1, { grantedCapabilities: ["device-session"] }));
    await t.host.launch({ id: "browser" });
    await t.host.openSibling("browser", "vs-client://browser/bk1/index.html");
    const [first, second] = t.windowsMade;
    first!.close();
    expect(t.host.runningClient("browser")).not.toBeNull();
    second!.close();
    expect(t.host.runningClient("browser")).toBeNull();
    expect(t.host.catalog.lookup("vs-client://browser/bk1/index.html")).toBeNull();
  });
});
