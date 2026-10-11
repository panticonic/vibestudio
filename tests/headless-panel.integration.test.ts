import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { chromium } from "playwright";
import {
  createRpcClient,
  decodeRpcJson,
  deserializeRpcFailure,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcMethod,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import {
  requestRpcWebSocketAdmission,
  rpcWebSocketAdmissionUrl,
} from "@vibestudio/rpc/protocol/rpcWebSocketAdmission";
import { webSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import {
  developmentTemplateSetEnv,
  resolveDevelopmentTemplateSet,
} from "../src/dev/developmentTemplateSet.js";
import { afterEach, describe, expect, it } from "vitest";
import { attemptCleanup, ownChild } from "./setup/ownedChild.js";

interface ReadyPayload {
  gatewayUrl: string;
  rootInvite: { code: string } | null;
  workspaces: Array<{ name: string; workspaceId: string }>;
}

interface ShellCredential {
  shellToken: string;
  callerId: string;
}

interface BrowserPanelHandle {
  id: string;
  title: string;
  kind: "browser" | "workspace";
  runtimeEntityId: string;
}

interface CdpEndpoint {
  wsEndpoint: string;
  token: string;
}

const RUN_HEADLESS_PANEL_INTEGRATION =
  process.env["VIBESTUDIO_RUN_HEADLESS_PANEL_INTEGRATION"] === "1";
const serverPath = path.resolve(process.cwd(), "dist", "server.mjs");
const headlessHostEntry = findHeadlessHostEntry();
const maybeDescribe =
  RUN_HEADLESS_PANEL_INTEGRATION && fs.existsSync(serverPath) && headlessHostEntry
    ? describe
    : describe.skip;

type HeadlessServerProcess = ChildProcessByStdio<null, Readable, Readable>;
let tempRoot: string | null = null;
let serverOwner: ReturnType<typeof ownChild> | null = null;
let fixtureServer: http.Server | null = null;
let shellConnection: RpcWsConnection | null = null;
let workerConnection: RpcWsConnection | null = null;
let cdpClient: CdpClient | null = null;
const hubControlRpcMethods = createRpcMethods("hubControl", hubControlMethods);

afterEach(async () => {
  await attemptCleanup([
    async () => {
      await cdpClient?.close();
      cdpClient = null;
    },
    async () => {
      await workerConnection?.close();
      workerConnection = null;
    },
    async () => {
      await shellConnection?.close();
      shellConnection = null;
    },
    async () => {
      if (!fixtureServer) return;
      const server = fixtureServer;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      fixtureServer = null;
    },
    async () => {
      await serverOwner?.retire();
      serverOwner = null;
    },
  ]);
  // Failed retirement preserves scratch and exact resource references.
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
}, 20_000);

maybeDescribe("headless browser panel integration", () => {
  it("opens a browser panel from a worker principal and drives it through the real headless host", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-headless-panel-"));
    const readyFile = path.join(tempRoot, "ready.json");
    const fixture = await startFixtureServer();
    const developmentTemplates = await resolveDevelopmentTemplateSet({
      repoRoot: process.cwd(),
      checkpointRoot: path.join(tempRoot, "template-checkpoints"),
    });
    const playwrightChromiumPath = chromium.executablePath();

    const child = spawn(
      process.execPath,
      [
        serverPath,
        "--bootstrap-workspace",
        "headless-panel-integration",
        "--ready-file",
        readyFile,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "development",
          HOME: tempRoot,
          XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
          VIBESTUDIO_HEADLESS_HOST_AUTOSPAWN: "1",
          VIBESTUDIO_HEADLESS_HOST_ENTRY: headlessHostEntry!,
          ...(fs.existsSync(playwrightChromiumPath)
            ? { VIBESTUDIO_CHROMIUM_PATH: playwrightChromiumPath }
            : {}),
          VIBESTUDIO_HEADLESS_IDLE_EXIT_MS: "1000",
          ...(developmentTemplates ? developmentTemplateSetEnv(developmentTemplates) : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    serverOwner = ownChild(child);

    let serverOutput = "";
    const appendServerOutput = (chunk: Buffer | string): void => {
      serverOutput += String(chunk);
      if (serverOutput.length > 100_000) serverOutput = serverOutput.slice(-100_000);
    };
    child.stdout.on("data", appendServerOutput);
    child.stderr.on("data", (chunk) => {
      appendServerOutput(chunk);
    });

    const ready = await waitForReadyFile(readyFile, child, () => serverOutput);
    const shell = await issueShellToken(ready);
    await approveStartupInstallReviews(ready, shell.shellToken);
    shellConnection = await connectRpcWebSocket({
      gatewayUrl: ready.gatewayUrl,
      token: shell.shellToken,
      selfId: shell.callerId,
      callerKind: "shell",
      clientLabel: "Vitest Shell",
    });
    await shellConnection.rpc.call("main", mainRpcMethods["shellPresence.heartbeat"], []);

    const worker = await rpc(ready, shell.shellToken, mainRpcMethods["runtime.createEntity"], [
      {
        kind: "worker",
        execution: { surface: "code", source: "workers/agent-worker" },
        key: `headless-panel-integration-${Date.now().toString(36)}`,
      },
    ]);
    const grant = await rpc(ready, shell.shellToken, mainRpcMethods["auth.grantConnection"], [
      worker.id,
    ]);
    workerConnection = await connectRpcWebSocket({
      gatewayUrl: ready.gatewayUrl,
      token: grant.token,
      selfId: worker.id,
      callerKind: "worker",
      clientLabel: "Vitest Worker Sandbox",
    });

    const panel = await openBrowserPanelFromWorker(workerConnection, `${fixture.baseUrl}/first`);
    expect(panel.kind).toBe("browser");

    const ensured = await workerConnection.rpc.call(
      "main",
      mainRpcMethods["panelRuntime.ensureSlot"],
      [panel.id]
    );
    if (ensured.status === "unavailable") {
      const hostLogs = await shellConnection.rpc.call("main", mainRpcMethods["serverLog.query"], [
        { contains: "HeadlessHost", limit: 100 },
      ]);
      throw new Error(
        `Headless host was unavailable after bounded startup: ${JSON.stringify(hostLogs)}\n${serverOutput}`
      );
    }

    await waitForPanelReady(
      workerConnection,
      panel.id,
      panel.runtimeEntityId,
      `${fixture.baseUrl}/first`,
      serverOutput
    );

    await shellConnection.rpc.call("main", mainRpcMethods["shellPresence.heartbeat"], []);
    const endpoint = await callWithCapabilityApprovals(
      ready,
      shell.shellToken,
      new Set(["panel.inspect", "context.boundary"]),
      () =>
        workerConnection!.rpc.call("main", mainRpcMethods["panelCdp.getCdpEndpoint"], [panel.id])
    );

    if (!endpoint.token) throw new Error("Headless host returned no CDP inspection token");
    cdpClient = await CdpClient.connect({ ...endpoint, token: endpoint.token });
    await cdpClient.send("Runtime.enable");
    await cdpClient.send("Page.enable");

    await expect(
      waitForEval(cdpClient, "document.title", "Initial Headless Integration")
    ).resolves.toBe("Initial Headless Integration");
    await expect(
      cdpClient.evaluate("document.querySelector('[data-testid=\"marker\"]')?.textContent")
    ).resolves.toBe("first");
    await expect(
      cdpClient.evaluate(
        "(() => { window.__vibestudioIntegration = 42; return window.__vibestudioIntegration; })()"
      )
    ).resolves.toBe(42);

    const clickTarget = (await cdpClient.evaluate(`(() => {
      const rect = document.querySelector('[data-testid="automation-button"]')?.getBoundingClientRect();
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
    expect(clickTarget).toBeTruthy();
    await cdpClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clickTarget!.x,
      y: clickTarget!.y,
    });
    await cdpClient.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickTarget!.x,
      y: clickTarget!.y,
      button: "left",
      clickCount: 1,
    });
    await cdpClient.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickTarget!.x,
      y: clickTarget!.y,
      button: "left",
      clickCount: 1,
    });
    await expect(
      waitForEval(
        cdpClient,
        "document.querySelector('[data-testid=\"automation-status\"]')?.textContent",
        "Automation click delivered"
      )
    ).resolves.toBe("Automation click delivered");

    const screenshot = await cdpClient.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    expect(Buffer.byteLength(screenshot.data, "base64")).toBeGreaterThan(500);

    const hostScreenshot = await workerConnection.rpc.call(
      "main",
      mainRpcMethods["panelCdp.screenshot"],
      [panel.id, { format: "png" }]
    );
    expect(Buffer.byteLength(hostScreenshot.data, "base64")).toBeGreaterThan(500);
    expect(hostScreenshot.mimeType).toBe("image/png");
    expect(hostScreenshot.width).toBeGreaterThan(0);
    expect(hostScreenshot.height).toBeGreaterThan(0);

    await cdpClient.send("Page.navigate", { url: `${fixture.baseUrl}/second` });
    await expect(
      waitForEval(cdpClient, "document.title", "Next Headless Integration")
    ).resolves.toBe("Next Headless Integration");
    await expect(cdpClient.evaluate("location.pathname")).resolves.toBe("/second");

    await cdpClient.evaluate("console.error('headless-panel-integration-error')");
    await expect(
      waitFor(async () => {
        const history = await workerConnection!.rpc.call(
          "main",
          mainRpcMethods["panelCdp.consoleHistory"],
          [panel.id, { errorLimit: 10 }]
        );
        return history.errors.some((entry) =>
          entry.message.includes("headless-panel-integration-error")
        );
      }, true)
    ).resolves.toBe(true);

    const leaseSnapshot = await workerConnection.rpc.call(
      "main",
      mainRpcMethods["panelRuntime.getSnapshot"],
      []
    );
    const lease = leaseSnapshot.leases.find((entry) => entry.slotId === panel.id);
    if (!lease) throw new Error("Expected panel runtime lease");
    expect(lease.supportsCdp).toBe(true);
    expect(lease.hostConnectionId).toMatch(/^headless-/);
  }, 360_000);
});

async function approveStartupInstallReviews(
  ready: ReadyPayload,
  shellToken: string
): Promise<void> {
  const deadline = Date.now() + 180_000;
  const resolved = new Set<string>();
  for (;;) {
    const pending = await rpc(ready, shellToken, mainRpcMethods["shellApproval.listPending"], []);
    const reviews = pending.filter((approval) => approval.kind === "unit-install-review");
    let resolvedThisPass = false;
    for (const approval of reviews) {
      if (resolved.has(approval.approvalId)) continue;
      await rpc(ready, shellToken, mainRpcMethods["shellApproval.resolveInstallReview"], [
        approval.approvalId,
        defaultAcceptance(approval.mode, approval.parts),
      ]);
      resolved.add(approval.approvalId);
      resolvedThisPass = true;
    }
    const state = await rpc(
      ready,
      shellToken,
      mainRpcMethods["shellApproval.getWorkspaceCreationReviewState"],
      []
    );
    if (reviews.length === 0 && (state.status === "resolved" || state.status === "not-required")) {
      return;
    }
    // A landing RPC can legitimately consume most of the cold-start budget.
    // Always take one authoritative post-landing snapshot before enforcing the
    // deadline; the pre-resolution pending list is stale by construction.
    if (resolvedThisPass) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `Workspace startup install reviews did not settle: ${JSON.stringify({
          state,
          pendingReviewIds: reviews.map((review) => review.approvalId),
          resolvedReviewIds: [...resolved],
        })}`
      );
    }
    await delay(100);
  }
}

function findHeadlessHostEntry(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "dist", "headless-host", "main.js"),
    path.resolve(process.cwd(), "apps", "headless-host", "dist", "main.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function startFixtureServer(): Promise<{ baseUrl: string }> {
  fixtureServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isSecond = url.pathname === "/second";
    const title = isSecond ? "Next Headless Integration" : "Initial Headless Integration";
    const marker = isSecond ? "second" : "first";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <div data-testid="marker">${marker}</div>
      <button
        data-testid="automation-button"
        onclick="document.querySelector('[data-testid=&quot;automation-status&quot;]').textContent = 'Automation click delivered'"
      >Automation probe</button>
      <div data-testid="automation-status"></div>
    </main>
  </body>
</html>`);
  });
  await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitForReadyFile(
  readyFile: string,
  child: HeadlessServerProcess,
  getStderr: () => string
): Promise<ReadyPayload> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as ReadyPayload;
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: ${child.exitCode}\n${getStderr()}`);
    }
    await delay(250);
  }
  throw new Error(`server did not write ready file\n${getStderr()}`);
}

async function issueShellToken(ready: ReadyPayload): Promise<ShellCredential> {
  const code = ready.rootInvite?.code;
  if (!code) throw new Error("fresh hub did not advertise a root invite");
  const pairedResponse = await fetch(`${ready.gatewayUrl}/_r/s/auth/complete-pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      label: "Vitest headless panel integration",
      platform: "test",
    }),
  });
  const paired = (await pairedResponse.json()) as {
    deviceId?: unknown;
    refreshToken?: unknown;
    shellToken?: unknown;
    error?: unknown;
  };
  if (
    !pairedResponse.ok ||
    typeof paired.deviceId !== "string" ||
    typeof paired.refreshToken !== "string" ||
    typeof paired.shellToken !== "string"
  ) {
    throw new Error(
      `failed to pair root device (${pairedResponse.status}): ${JSON.stringify(paired)}`
    );
  }
  const workspaces = await rpc(ready, paired.shellToken, hubControlRpcMethods.listWorkspaces, []);
  const workspace = workspaces[0];
  if (!workspace?.workspaceId) throw new Error("hub exposed no exact workspace identity");
  const route = await rpc(ready, paired.shellToken, hubControlRpcMethods.routeWorkspace, [
    { workspaceId: workspace.workspaceId },
  ]);
  if (typeof route.serverUrl !== "string") throw new Error("workspace route had no server URL");
  ready.gatewayUrl = route.serverUrl;
  const refreshResponse = await fetch(`${route.serverUrl}/_r/s/auth/refresh-shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: paired.deviceId, refreshToken: paired.refreshToken }),
  });
  const body = (await refreshResponse.json()) as {
    shellToken?: unknown;
    callerId?: unknown;
    error?: unknown;
  };
  if (
    !refreshResponse.ok ||
    typeof body.shellToken !== "string" ||
    typeof body.callerId !== "string"
  ) {
    throw new Error(
      `failed to refresh child shell (${refreshResponse.status}): ${JSON.stringify(body)}`
    );
  }
  return { shellToken: body.shellToken, callerId: body.callerId };
}

async function rpc<Args extends unknown[], Result>(
  ready: ReadyPayload,
  shellToken: string,
  method: RpcMethod<Args, Result>,
  args: NoInfer<Args>
): Promise<Result> {
  return method.invoke(args, async (parsedArgs) => {
    const response = await fetch(`${ready.gatewayUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shellToken}`,
      },
      body: JSON.stringify(
        envelopeFromMessage({
          selfId: "headless-panel-integration",
          from: "headless-panel-integration",
          target: "main",
          callerKind: "shell",
          message: {
            type: "request",
            requestId: randomUUID(),
            fromId: "headless-panel-integration",
            method: method.name,
            args: parsedArgs,
          },
        })
      ),
    });
    if (!response.ok) {
      throw new Error(`RPC ${method.name} failed with status ${response.status}`);
    }
    const responseEnvelope = decodeRpcJson(await response.text()) as RpcEnvelope;
    const responseMessage = responseEnvelope.message;
    if (responseMessage.type !== "response") {
      throw new Error(`RPC ${method.name} returned a non-response message`);
    }
    if ("error" in responseMessage) throw deserializeRpcFailure(responseMessage.error);
    return responseMessage.result;
  });
}

async function callWithCapabilityApprovals<T>(
  ready: ReadyPayload,
  shellToken: string,
  allowedCapabilities: ReadonlySet<string>,
  invoke: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt <= allowedCapabilities.size; attempt += 1) {
    try {
      return await invoke();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("approval-required")) throw error;
    }
    const pending = await rpc(ready, shellToken, mainRpcMethods["shellApproval.listPending"], []);
    const approval = pending.find(
      (entry) =>
        entry.kind === "capability" &&
        typeof entry.capability === "string" &&
        allowedCapabilities.has(entry.capability)
    );
    if (!approval) {
      throw new Error(
        `Capability call required approval but no expected card was pending: ${JSON.stringify(pending)}`
      );
    }
    const decision = "allowedDecisions" in approval ? approval.allowedDecisions?.[0] : undefined;
    if (!decision) {
      throw new Error(
        `Expected capability card exposed no grant decision: ${JSON.stringify(approval)}`
      );
    }
    await rpc(ready, shellToken, mainRpcMethods["shellApproval.resolve"], [
      approval.approvalId,
      decision,
    ]);
  }
  throw new Error(
    "Capability call still required approval after every expected grant was resolved"
  );
}

interface RpcWsConnection {
  rpc: RpcClient;
  auth: {
    callerId: string;
    callerKind: string;
    connectionId?: string;
  };
  close(): Promise<void>;
}

async function waitForPanelReady(
  connection: RpcWsConnection,
  panelId: string,
  runtimeEntityId: string,
  expectedUrl: string,
  serverOutput: string
): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const runtime = await connection.rpc.call("main", mainRpcMethods["panelRuntime.observeSlot"], [
      panelId,
    ]);
    const exactAttempt =
      runtime.attempt?.runtimeEntityId === runtimeEntityId ? runtime.attempt : null;
    if (
      exactAttempt?.phase === "ready" &&
      runtime.route.reachable &&
      runtime.route.view?.loading === false &&
      runtime.route.view.url === expectedUrl
    ) {
      return;
    }
    if (exactAttempt?.phase === "failed") {
      const leases = await connection.rpc.call(
        "main",
        mainRpcMethods["panelRuntime.getSnapshot"],
        []
      );
      const hostLogs = await shellConnection!.rpc.call("main", mainRpcMethods["serverLog.query"], [
        { contains: "HeadlessHost", limit: 100 },
      ]);
      throw new Error(
        `Expected headless host to load panel: ${JSON.stringify(runtime)}\nLeases: ${JSON.stringify(leases)}\nHeadless host logs: ${JSON.stringify(hostLogs)}\n${serverOutput}`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Headless panel did not become ready: ${JSON.stringify(runtime)}\n${serverOutput}`
      );
    }
    await delay(100);
  }
}

async function openBrowserPanelFromWorker(
  connection: RpcWsConnection,
  url: string
): Promise<BrowserPanelHandle> {
  await shellConnection?.rpc.call("main", mainRpcMethods["shellPresence.heartbeat"], []);
  const runId = `headless-panel-open-${randomUUID()}`;
  await connection.rpc.call("main", mainRpcMethods["eval.start"], [
    {
      runId,
      source: {
        kind: "inline",
        code: `const panel = await createPanelSlot(${JSON.stringify(url)}); const observation = await panel.observe(); return { id: panel.id, title: panel.title, kind: panel.kind, runtimeEntityId: observation.runtimeEntityId };`,
      },
      authority: {
        approvals: "prompt",
        requests: [
          {
            capability: "workspace.runtime-state.manage",
            resource: { kind: "prefix", prefix: "" },
          },
          {
            capability: "context.boundary",
            resource: { kind: "prefix", prefix: "context/" },
          },
        ],
      },
      timeoutMs: 90_000,
    },
  ]);

  const deadline = Date.now() + 90_000;
  let lastSnapshot: unknown = null;
  while (Date.now() < deadline) {
    const snapshot = await connection.rpc.call("main", mainRpcMethods["eval.get"], [{ runId }]);
    lastSnapshot = snapshot;
    if (
      snapshot.activity &&
      (snapshot.activity as { kind?: string }).kind === "authority-pending"
    ) {
      await shellConnection?.rpc.call("main", mainRpcMethods["shellPresence.heartbeat"], []);
      const pending = await shellConnection?.rpc.call(
        "main",
        mainRpcMethods["shellApproval.listPending"],
        []
      );
      const approval = pending?.find(
        (entry) =>
          entry.kind === "capability" &&
          (entry.capability === "workspace.runtime-state.manage" ||
            entry.capability === "context.boundary")
      );
      const decision =
        approval && "allowedDecisions" in approval ? approval.allowedDecisions?.[0] : undefined;
      if (approval && decision) {
        await shellConnection?.rpc.call("main", mainRpcMethods["shellApproval.resolve"], [
          approval.approvalId,
          decision,
        ]);
      }
    }
    if (snapshot.status === "done") {
      if (!snapshot.result?.success) {
        throw new Error(`Worker panel open failed: ${snapshot.result?.error ?? "unknown error"}`);
      }
      return snapshot.result.returnValue as BrowserPanelHandle;
    }
    if (snapshot.status === "cancelled" || snapshot.status === "approval-route-lost") {
      throw new Error(`Worker panel open ended in ${snapshot.status}`);
    }
    await delay(50);
  }
  const pending = await shellConnection?.rpc.call(
    "main",
    mainRpcMethods["shellApproval.listPending"],
    []
  );
  throw new Error(
    `Worker panel open did not settle: snapshot=${JSON.stringify(lastSnapshot)} pending=${JSON.stringify(pending)}`
  );
}

async function connectRpcWebSocket(options: {
  gatewayUrl: string;
  token: string;
  selfId: string;
  callerKind: "shell" | "worker";
  clientLabel: string;
}): Promise<RpcWsConnection> {
  const wsUrl = new URL(`${options.gatewayUrl.replace(/\/$/, "")}/rpc`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const admission = await requestRpcWebSocketAdmission(rpcWebSocketAdmissionUrl(wsUrl.href), {
    credential: options.token,
    clientLabel: options.clientLabel,
    clientPlatform: "desktop",
  });
  if (!admission.ok) {
    throw new Error(`RPC WebSocket admission failed: ${admission.message}`);
  }
  const ws = new WebSocket(wsUrl, [webSocketAuthProtocol("rpc", admission.grant)]);
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const transport: EnvelopeRpcTransport = {
    async send(envelope) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("RPC WebSocket is not connected");
      ws.send(JSON.stringify({ type: "ws:rpc", envelope, message: envelope.message }));
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    status: () => (ws.readyState === WebSocket.OPEN ? "connected" : "disconnected"),
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
  const lifetime = new AbortController();
  const rpcClient = createRpcClient({
    lifetime: lifetime.signal,
    selfId: options.selfId,
    callerKind: options.callerKind,
    transport,
  });

  const retireRpc = async (): Promise<void> => {
    lifetime.abort(new Error("Test RPC owner retired"));
  };

  let auth: RpcWsConnection["auth"];
  try {
    auth = await new Promise<RpcWsConnection["auth"]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("RPC WebSocket auth timeout")), 10_000);
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      ws.once("error", fail);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "ws:auth",
            contractVersion: RPC_CONTRACT_VERSION,
            token: admission.grant,
            clientLabel: options.clientLabel,
            clientPlatform: "desktop",
          } satisfies WsClientMessage)
        );
      });
      ws.on("message", function onMessage(data) {
        const message = parseJson<WsServerMessage>(data);
        if (!message) return;
        if (message.type === "ws:auth-result") {
          ws.off("message", onMessage);
          ws.off("error", fail);
          clearTimeout(timeout);
          if (!message.success) {
            reject(new Error(`RPC WebSocket auth failed: ${message.error ?? "unknown error"}`));
            return;
          }
          resolve({
            callerId: message.callerId ?? options.selfId,
            callerKind: message.callerKind ?? options.callerKind,
            ...(message.connectionId ? { connectionId: message.connectionId } : {}),
          });
        }
      });
    });
  } catch (original) {
    try {
      await attemptCleanup([retireRpc, () => closeWebSocket(ws)]);
    } catch (cleanup) {
      throw new AggregateError([original, cleanup], "RPC authentication and cleanup failed", {
        cause: original,
      });
    }
    throw original;
  }

  ws.on("message", (data) => {
    const message = parseJson<WsServerMessage>(data);
    if (!message) return;
    let envelope: RpcEnvelope | null = null;
    if (message.type === "ws:rpc") {
      envelope = message.envelope;
    } else if (message.type === "ws:routed") {
      envelope = message.envelope;
    }
    if (envelope) {
      for (const listener of listeners) listener(envelope);
    }
  });

  return {
    rpc: rpcClient,
    auth,
    close: async () => attemptCleanup([retireRpc, () => closeWebSocket(ws)]),
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => this.rejectPending(new Error("CDP WebSocket closed")));
    ws.on("error", (error) =>
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
    );
  }

  static async connect(endpoint: CdpEndpoint): Promise<CdpClient> {
    const ws = new WebSocket(endpoint.wsEndpoint, [
      webSocketAuthProtocol("inspection", endpoint.token),
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("CDP auth timeout")), 10_000);
        const fail = (error: unknown) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        ws.once("error", fail);
        ws.once("open", () => {
          ws.off("error", fail);
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (original) {
      try {
        await closeWebSocket(ws);
      } catch (cleanup) {
        throw new AggregateError([original, cleanup], "CDP authentication and cleanup failed", {
          cause: original,
        });
      }
      throw original;
    }
    return new CdpClient(ws);
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not open"));
    }
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws.send(JSON.stringify(message), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          `Evaluation failed: ${expression}`
      );
    }
    return result.result?.value;
  }

  async close(): Promise<void> {
    this.rejectPending(new Error("CDP client closed"));
    await closeWebSocket(this.ws);
  }

  private handleMessage(data: WebSocket.RawData): void {
    const message = parseJson<{
      id?: number;
      result?: unknown;
      error?: { message?: string; data?: string };
    }>(data);
    if (!message || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const cdpMessage = message.error.message ?? "CDP command failed";
      if (message.error.data) {
        try {
          const data = JSON.parse(message.error.data) as {
            protocol?: unknown;
            failure?: unknown;
          };
          if (data.protocol === "vibestudio.rpc-failure.v1") {
            try {
              pending.reject(deserializeRpcFailure(data.failure));
            } catch (failure) {
              pending.reject(
                new AggregateError(
                  [failure, new Error(cdpMessage)],
                  "CDP failure metadata could not be restored",
                  { cause: failure }
                )
              );
            }
            return;
          }
        } catch {
          // CDP's data field is arbitrary text unless it carries our tagged RPC graph.
        }
      }
      pending.reject(new Error(cdpMessage));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function waitForEval(
  client: CdpClient,
  expression: string,
  expected: unknown,
  timeoutMs = 20_000
): Promise<unknown> {
  return waitFor(async () => client.evaluate(expression), expected, timeoutMs);
}

async function waitFor<T>(
  producer: () => Promise<T> | T,
  expected: T,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      lastValue = value;
      if (value === expected || (expected === undefined && value !== undefined)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  throw new Error(`Timed out waiting for ${String(expected)}; last value: ${String(lastValue)}`);
}

function parseJson<T>(data: WebSocket.RawData): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const closed = () => {
      ws.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      ws.off("close", closed);
      reject(error);
    };
    ws.once("close", closed);
    ws.once("error", failed);
    try {
      if (ws.readyState !== WebSocket.CLOSING) ws.close(1000, "test cleanup");
    } catch (error) {
      ws.off("close", closed);
      ws.off("error", failed);
      reject(error);
    }
  });
}
