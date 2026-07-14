#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { envelopeFromMessage } from "@vibestudio/rpc";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { createServerInvocation, serverEntryArg } from "./cli/lib/server-entry.mjs";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_CLI = readWorkspacePackageName("apps", "remote-cli");

function readWorkspacePackageName(...segments) {
  const pkgPath = path.join(repoRoot, "workspace", ...segments, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name) {
    throw new Error(`Workspace package at ${pkgPath} is missing a package name`);
  }
  return pkg.name;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(filePath, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) {
          await wait(250);
          continue;
        }
        throw error;
      }
      return parseHubReadyPayload(value);
    }
    await wait(500);
  }
  throw new Error(`Server did not write ready file within ${timeoutMs}ms`);
}

async function postJson(url, pathName, body, token) {
  const res = await fetch(`${url}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathName} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function rpc(url, shellToken, method, args = []) {
  const requestUrl = new URL(url);
  const basePath = requestUrl.pathname.replace(/\/+$/, "");
  requestUrl.pathname = `${basePath}/rpc`;
  requestUrl.search = "";
  requestUrl.hash = "";
  const caller = { callerId: "terminal-app-smoke", callerKind: "shell" };
  const res = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${shellToken}`,
    },
    body: JSON.stringify({
      from: caller.callerId,
      target: "main",
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "request",
        requestId: crypto.randomUUID(),
        fromId: caller.callerId,
        method,
        args,
      },
    }),
  });
  const body = await res.json();
  const message = (body?.envelope ?? body)?.message;
  if (!res.ok || message?.error)
    throw new Error(message?.error ?? body?.error ?? `/rpc failed ${res.status}`);
  return message?.result;
}

async function pairShellToken(ready) {
  const url = ready.connectUrl;
  const code = ready.rootInvites?.desktop?.code;
  if (!url) throw new Error("Server ready file did not include a pairing URL");
  if (!code) throw new Error("Server ready file did not include a terminal pairing code");
  const issued = await postJson(url, "/_r/s/auth/complete-pairing", {
    code,
    handle: "terminal-smoke",
    displayName: "Terminal Smoke",
    label: "Terminal app smoke",
    platform: "desktop",
  });
  if (
    typeof issued.deviceId !== "string" ||
    typeof issued.refreshToken !== "string" ||
    typeof issued.shellToken !== "string"
  ) {
    throw new Error("Pairing response did not include complete device and shell credentials");
  }
  const routed = await postJson(
    url,
    "/rpc",
    { method: "hubControl.routeWorkspace", args: [{ workspace: "dev" }] },
    issued.shellToken
  );
  const selected = routed.result;
  if (typeof selected.serverUrl !== "string") {
    throw new Error("Workspace selection response did not include a server URL");
  }
  const refreshed = await postJson(selected.serverUrl, "/_r/s/auth/refresh-shell", {
    deviceId: issued.deviceId,
    refreshToken: issued.refreshToken,
  });
  if (typeof refreshed.shellToken !== "string") {
    throw new Error("Shell refresh response did not include a shell token");
  }
  return { url: selected.serverUrl, shellToken: refreshed.shellToken };
}

function rpcWsUrl(rawUrl) {
  const url = new URL(rawUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/rpc`;
  url.search = "";
  url.hash = "";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function createShellEventClient(url, shellToken) {
  const events = [
    "host-target-launch:session-changed",
    "apps:status",
    "apps:available",
    "workspace:unit-log",
  ];
  const waiters = new Set();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const waiter of [...waiters]) waiter();
  };
  let requestIndex = 0;
  const ws = new WebSocket(rpcWsUrl(url));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out connecting terminal smoke event stream")),
      15_000
    );
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "ws:auth",
          contractVersion: RPC_CONTRACT_VERSION,
          token: shellToken,
          clientLabel: "Terminal app smoke",
          clientPlatform: "headless",
        })
      );
    });
    ws.once("error", reject);
    ws.on("message", (chunk) => {
      let message;
      try {
        message = JSON.parse(String(chunk));
      } catch {
        return;
      }
      if (message?.type === "ws:auth-result") {
        if (message.success !== true) {
          clearTimeout(timeout);
          reject(new Error(message.error || "Terminal smoke event stream auth failed"));
          return;
        }
        for (const event of events) {
          requestIndex += 1;
          const envelope = envelopeFromMessage({
            from: "terminal-smoke",
            target: "main",
            callerKind: "shell",
            message: {
              type: "request",
              requestId: `terminal-smoke-subscribe-${requestIndex}`,
              fromId: "terminal-smoke",
              method: "events.subscribe",
              args: [event],
            },
          });
          ws.send(
            JSON.stringify({
              type: "ws:rpc",
              envelope,
              message: envelope.message,
            })
          );
        }
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (message?.type === "ws:event") {
        const eventName =
          typeof message.event === "string" && message.event.startsWith("event:")
            ? message.event.slice("event:".length)
            : message.event;
        if (events.includes(eventName)) notify();
      }
    });
  });
  return {
    checkpoint() {
      return revision;
    },
    wait(timeoutMs, afterRevision = revision) {
      if (revision !== afterRevision) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(false);
        }, timeoutMs);
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(true);
        };
        waiters.add(done);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 2000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close();
      });
    },
  };
}

async function waitForRunning(url, shellToken, events) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const before = events.checkpoint();
    const units = await rpc(url, shellToken, "workspace.units.list");
    const remoteCli = units.find((unit) => unit.name === REMOTE_CLI);
    if (remoteCli?.status === "running") return remoteCli;
    if (remoteCli?.status === "error") {
      const logs = await rpc(url, shellToken, "workspace.units.logs", [REMOTE_CLI, { limit: 80 }]);
      throw new Error(
        `${REMOTE_CLI} errored: ${remoteCli.lastError}\n${JSON.stringify(logs, null, 2)}`
      );
    }
    await events.wait(Math.min(1_000, Math.max(1, deadline - Date.now())), before);
  }
  throw new Error(`${REMOTE_CLI} did not reach running status`);
}

async function launchTerminalWithGate(url, shellToken, events) {
  // A pristine isolated HOME has no shared external-dependency cache. Building
  // the approved native extensions before the terminal app can legitimately
  // take several minutes on a cold registry/network path.
  const deadline = Date.now() + 600_000;
  let session = await rpc(url, shellToken, "workspace.hostTargets.beginLaunch", ["terminal"]);
  while (Date.now() < deadline) {
    const before = events.checkpoint();
    if (session.status === "ready") {
      return { launch: session.launch, approvalsResolved: session.approvalsResolved };
    }
    if (session.status === "unavailable") {
      const pending = await rpc(url, shellToken, "shellApproval.listPending").catch(() => []);
      const pendingSummary = Array.isArray(pending)
        ? pending.map((approval) => ({
            id: approval.approvalId,
            kind: approval.kind,
            trigger: approval.trigger,
            units: Array.isArray(approval.units)
              ? approval.units.map((unit) => ({
                  name: unit.unitName,
                  kind: unit.unitKind,
                  target: unit.target,
                }))
              : undefined,
          }))
        : pending;
      throw new Error(
        `${session.message}${session.detail ? `: ${session.detail}` : ""}` +
          `\nPending approvals: ${JSON.stringify(pendingSummary, null, 2)}`
      );
    }
    if (session.status === "preparing" || session.status === "starting") {
      const observed = await events.wait(
        Math.min(1_000, Math.max(1, deadline - Date.now())),
        before
      );
      const refreshed = await rpc(url, shellToken, "workspace.hostTargets.beginLaunch", [
        "terminal",
      ]);
      if (refreshed) {
        session = refreshed;
        continue;
      }
      if (observed) continue;
      throw new Error(`${session.message}${session.detail ? `: ${session.detail}` : ""}`);
    }
    if (session.status !== "approval-required" || !Array.isArray(session.approvals)) {
      throw new Error(`Unexpected terminal launch session: ${JSON.stringify(session)}`);
    }
    session = await rpc(url, shellToken, "workspace.hostTargets.resolveLaunchSessionApproval", [
      session.sessionId,
      "once",
    ]);
  }
  throw new Error(`Terminal launch gate did not settle: ${JSON.stringify(session)}`);
}

async function waitForLogLine(url, shellToken, events, needle) {
  let lastLogs = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const before = events.checkpoint();
    const units = await rpc(url, shellToken, "workspace.units.list");
    const remoteCli = units.find((unit) => unit.name === REMOTE_CLI);
    lastLogs = await rpc(url, shellToken, "workspace.units.logs", [REMOTE_CLI, { limit: 200 }]);
    if (lastLogs.some((row) => String(row.message).includes(needle))) {
      return lastLogs;
    }
    if (remoteCli?.status === "error") {
      throw new Error(
        `${REMOTE_CLI} errored before logging ${needle}:\n${JSON.stringify(lastLogs, null, 2)}`
      );
    }
    await events.wait(Math.min(1_000, Math.max(1, deadline - Date.now())), before);
  }
  throw new Error(
    `${REMOTE_CLI} ran but did not log ${needle}:\n${JSON.stringify(lastLogs, null, 2)}`
  );
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-terminal-smoke-"));
  const readyFile = path.join(tempRoot, "hub-ready.json");
  const serverHome = path.join(tempRoot, "server-home");
  const serverConfig = path.join(tempRoot, "server-xdg-config");
  fs.mkdirSync(serverHome, { recursive: true });
  fs.mkdirSync(serverConfig, { recursive: true });
  let events = null;
  let child = null;
  try {
    const serverInvocation = createServerInvocation([
      serverEntryArg(),
      "--app-root",
      repoRoot,
      "--ephemeral",
      "--ready-file",
      readyFile,
    ]);
    child = spawn(serverInvocation.command, serverInvocation.args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
        HOME: serverHome,
        XDG_CONFIG_HOME: serverConfig,
        APPDATA: path.join(tempRoot, "server-appdata"),
        npm_config_cache:
          process.env.npm_config_cache ??
          path.join(repoRoot, "node_modules", ".cache", "terminal-smoke-npm"),
      },
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    const ready = await waitForReady(readyFile);
    const { url, shellToken } = await pairShellToken(ready);
    events = await createShellEventClient(url, shellToken);

    const gate = await launchTerminalWithGate(url, shellToken, events);
    const running = await waitForRunning(url, shellToken, events);
    await waitForLogLine(url, shellToken, events, `Connected as ${REMOTE_CLI}`);
    await waitForLogLine(url, shellToken, events, "Workspace units:");
    console.log(
      `[terminal-smoke] ${REMOTE_CLI} ${running.status} build=${String(running.activeBundleKey).slice(0, 12)} approvals=${gate.approvalsResolved}`
    );
  } finally {
    await events?.close();
    if (child) await stopServer(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
