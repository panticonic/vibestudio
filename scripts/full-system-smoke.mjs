#!/usr/bin/env node
// Orchestrates the real-client smoke ladder for the remote/mobile overhaul:
// multi-user hub scenarios, branded desktop pairing, desktop Playwright e2e,
// and Android emulator/mobile pairing. Each phase streams to the console and
// to test-results forensics.

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { envelopeFromMessage } from "@vibestudio/rpc";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";
import { createServerInvocation, serverEntryArg } from "./cli/lib/server-entry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultResultsRoot = path.join(repoRoot, "test-results", "full-system-smoke");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");

function parseArgs(argv) {
  const options = {
    skipBuild: false,
    skipMultiUser: false,
    skipCliRemote: false,
    skipDesktopPairing: false,
    skipDesktopE2e: false,
    skipAndroid: false,
    androidDevice: null,
    androidAvd: null,
    androidNoBuild: false,
    androidNoInstall: false,
    localSignaling: false,
    requireTurn: false,
    signalUrl: null,
    timeoutMs: 420_000,
    resultsDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--skip-multi-user") options.skipMultiUser = true;
    else if (arg === "--skip-cli-remote") options.skipCliRemote = true;
    else if (arg === "--skip-desktop-pairing") options.skipDesktopPairing = true;
    else if (arg === "--skip-desktop-e2e") options.skipDesktopE2e = true;
    else if (arg === "--skip-android") options.skipAndroid = true;
    else if (arg === "--android-device") options.androidDevice = argv[++i] ?? null;
    else if (arg === "--android-avd") options.androidAvd = argv[++i] ?? null;
    else if (arg === "--android-no-build") options.androidNoBuild = true;
    else if (arg === "--android-no-install") options.androidNoInstall = true;
    else if (arg === "--local-signaling") options.localSignaling = true;
    else if (arg === "--require-turn") options.requireTurn = true;
    else if (arg === "--signal-url") options.signalUrl = argv[++i] ?? "";
    else if (arg === "--timeout-ms") options.timeoutMs = positiveInt(argv[++i], "--timeout-ms");
    else if (arg === "--results-dir") options.resultsDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.localSignaling && options.signalUrl) {
    throw new Error("--local-signaling cannot be combined with --signal-url");
  }
  return options;
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`vibestudio full-system smoke

Usage:
  pnpm smoke:full [options]

Phases:
  build                  pnpm build
  multi-user             two-user hub scenarios against a real loopback hub
  channel-contracts      durable channel invite/presence recovery contracts
  cli-remote             scripts/cli-remote-smoke.mjs
  desktop-pairing        scripts/desktop-pairing-smoke.mjs
  desktop-e2e            pnpm test:e2e
  android-mobile         scripts/cli/mobile-smoke.mjs --platform android

Options:
  --skip-build              Reuse the current dist/ output.
  --skip-multi-user         Skip the multi-user hub scenario ladder.
  --skip-cli-remote         Skip the CLI client remote pair/status smoke.
  --skip-desktop-pairing    Skip the branded Electron WebRTC pairing smoke.
  --skip-desktop-e2e        Skip the Playwright desktop e2e suite.
  --skip-android            Skip Android emulator/mobile smoke.
  --android-device <serial> Target a specific adb serial.
  --android-avd <name>      Boot/use this AVD when no adb device is connected.
  --android-no-build        Reuse an existing internal APK.
  --android-no-install      Do not reinstall the APK before pairing.
  --signal-url <url>        Use a specific existing signaling service.
  --local-signaling         Use local Wrangler signaling for desktop and Android
                            instead of the hosted production service.
  --require-turn            Require TURN for the Android pairing phase. By
                            default it attempts normal host/STUN/TURN ICE.
  --timeout-ms <ms>         Phase timeout passed through to smoke scripts.
  --results-dir <path>      Forensics output directory.
  --help                    Show this message.

The command writes per-phase logs under test-results/full-system-smoke/ and
fails on the first broken phase. Desktop and Android pairing use the deployed
signaling service and the real remote-serve launcher by default. Pass
--local-signaling for an offline Miniflare/coturn run.
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function prefixed(prefix, chunk, stream) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${prefix}] ${line}\n`);
  }
}

function runPhase(phase, command, args, options = {}) {
  const logFile = path.join(options.resultsDir, `${phase}.log`);
  const startedAt = Date.now();
  console.log(`[full-smoke] phase=${phase} start`);
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`# ${phase}\n$ ${command} ${args.join(" ")}\n\n`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stdout?.on("data", (chunk) => {
      log.write(chunk);
      prefixed(phase, chunk, process.stdout);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-8_000);
      log.write(chunk);
      prefixed(phase, chunk, process.stderr);
    });
    child.on("error", (error) => {
      log.end();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      log.write(`\n# exit code=${code} signal=${signal ?? ""} elapsedMs=${elapsedMs}\n`);
      log.end();
      if (code === 0) {
        console.log(`[full-smoke] phase=${phase} ok elapsedMs=${elapsedMs}`);
        resolve();
      } else {
        reject(
          new Error(
            `${phase} failed with code ${code}${signal ? ` signal ${signal}` : ""}. ` +
              `Log: ${logFile}${stderrTail ? `\n${stderrTail}` : ""}`
          )
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Multi-user hub scenarios (WP10 §5). Runs a REAL hub on loopback HTTP with a
// fresh temp state dir: root bootstrap, hub policy checks, two routed child
// sessions, shared panel/approval/provenance checks, and live presence.
// ---------------------------------------------------------------------------

async function readJsonFileWhenReady(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`hub exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const text = await fsp.readFile(file, "utf8");
      try {
        return parseHubReadyPayload(JSON.parse(text));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for hub ready file: ${file}`);
}

async function findFreeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a signaling port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForSignaling(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`local signaling exited before readiness (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Local Cloudflare runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for local signaling");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // non-JSON error body — leave payload null
  }
  return { status: response.status, payload };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** An `EACCES` refusal: HTTP 403 and/or a payload carrying the code. */
function isAccessDenied({ status, payload }) {
  const code = payload?.code ?? "";
  const text = payload?.error ?? "";
  return status === 403 || code === "EACCES" || /EACCES/.test(String(text));
}

async function runMultiUserPhase(options, resultsDir) {
  const phase = "multi-user";
  const logFile = path.join(resultsDir, `${phase}.log`);
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const appendLog = (value) => {
    if (!log.destroyed && !log.writableEnded) log.write(value);
  };
  const say = (line) => {
    appendLog(`${line}\n`);
    console.log(`[${phase}] ${line}`);
  };
  const startedAt = Date.now();
  console.log(`[full-smoke] phase=${phase} start`);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-multiuser-smoke-"));
  const home = path.join(tempRoot, "home");
  const readyFile = path.join(tempRoot, "hub-ready.json");
  await fsp.mkdir(path.join(home, ".config"), { recursive: true });

  const env = { ...process.env };
  // A fresh identity: nothing from the operator's real state dir leaks in.
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.NODE_ENV = env.NODE_ENV ?? "development";
  delete env.VIBESTUDIO_PROCESS_ROLE;
  delete env.VIBESTUDIO_IDENTITY_DB_PATH;
  delete env.VIBESTUDIO_ADMIN_TOKEN;

  let signaling = null;
  try {
    if (!fs.existsSync(wranglerBin)) {
      throw new Error("Wrangler is not installed; run pnpm install before the full smoke");
    }
    const signalingPort = await findFreeLoopbackPort();
    signaling = spawn(
      wranglerBin,
      [
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(signalingPort),
        "--local",
        "--persist-to",
        path.join(tempRoot, "signaling-state"),
        "--var",
        "ENVIRONMENT:test",
      ],
      { cwd: signalingDir, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    signaling.stdout?.on("data", (chunk) => appendLog(`[signaling] ${chunk}`));
    signaling.stderr?.on("data", (chunk) => appendLog(`[signaling] ${chunk}`));
    await waitForSignaling(signalingPort, signaling, Math.min(options.timeoutMs, 60_000));
    env.VIBESTUDIO_WEBRTC_SIGNAL_URL = `ws://127.0.0.1:${signalingPort}`;
  } catch (error) {
    await stopChild(signaling);
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    log.end();
    throw error;
  }

  const invocation = createServerInvocation([
    serverEntryArg(),
    "--app-root",
    repoRoot,
    "--ready-file",
    readyFile,
  ]);
  const hub = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub.stdout?.on("data", (chunk) => appendLog(chunk));
  hub.stderr?.on("data", (chunk) => appendLog(chunk));

  const results = [];
  const sockets = [];
  const step = async (name, fn) => {
    try {
      await fn();
      say(`ok    ${name}`);
      results.push({ name, status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(`FAIL  ${name}: ${message}`);
      results.push({ name, status: "fail", detail: message });
    }
  };

  try {
    const ready = await readJsonFileWhenReady(readyFile, hub, Math.min(options.timeoutMs, 120_000));
    expect(ready.mode === "hub", `expected a hub ready file, got mode=${ready.mode}`);
    const rootInviteCode = ready.rootInvites?.desktop?.code;
    expect(
      typeof rootInviteCode === "string" && rootInviteCode,
      "fresh hub must advertise a complete root invite"
    );
    const base = `http://127.0.0.1:${ready.gatewayPort}`;
    const auth = (route, body) => postJson(`${base}/_r/s/auth/${route}`, body);
    const rpc = (token, method, ...args) => postJson(`${base}/rpc`, { method, args }, token);
    const routeWorkspace = async (credential, name) => {
      const response = await rpc(credential.shellToken, "hubControl.routeWorkspace", {
        workspace: name,
      });
      return {
        ...response,
        payload: response.payload?.result ?? response.payload,
      };
    };
    const refreshWorkspace = async (serverUrl, credential) => {
      const refreshed = await postJson(`${serverUrl}/_r/s/auth/refresh-shell`, {
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
      });
      expect(
        refreshed.status === 200 && refreshed.payload?.shellToken,
        `child refresh failed: ${JSON.stringify(refreshed.payload)}`
      );
      return {
        serverUrl,
        shellToken: refreshed.payload.shellToken,
        callerId: refreshed.payload.callerId,
      };
    };
    const childRpc = async (session, method, ...args) => {
      const callerId = session.callerId || "shell:smoke";
      const requestId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const response = await postJson(
        `${session.serverUrl}/rpc`,
        {
          from: callerId,
          target: "main",
          delivery: { caller: { callerId, callerKind: "shell" } },
          provenance: [{ callerId, callerKind: "shell" }],
          message: { type: "request", requestId, fromId: callerId, method, args },
        },
        session.shellToken
      );
      const envelope = response.payload?.envelope ?? response.payload;
      const message = envelope?.message;
      if (response.status !== 200 || message?.error) {
        throw new Error(
          message?.error ??
            response.payload?.error ??
            `child RPC ${method} failed with HTTP ${response.status}`
        );
      }
      return message?.result;
    };
    const openChildSocket = async (session, label) => {
      const url = new URL(session.serverUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc`;
      const socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`WebSocket auth timed out for ${label}`)),
          10_000
        );
        const fail = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        socket.once("error", fail);
        socket.once("open", () =>
          socket.send(
            JSON.stringify({
              type: "ws:auth",
              contractVersion: RPC_CONTRACT_VERSION,
              token: session.shellToken,
              clientLabel: label,
              clientPlatform: "test",
            })
          )
        );
        socket.on("message", function onMessage(chunk) {
          const message = JSON.parse(String(chunk));
          if (message?.type !== "ws:auth-result") return;
          socket.off("message", onMessage);
          socket.off("error", fail);
          clearTimeout(timer);
          if (!message.success) reject(new Error(message.error ?? "WebSocket auth failed"));
          else resolve();
        });
      });
      sockets.push(socket);
      return socket;
    };
    const childWsRpc = (socket, callerId, callerKind, method, ...args) => {
      const requestId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const envelope = envelopeFromMessage({
        from: callerId,
        target: "main",
        callerKind,
        message: { type: "request", requestId, fromId: callerId, method, args },
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off("message", onMessage);
          reject(new Error(`WebSocket RPC ${method} timed out`));
        }, 15_000);
        const onMessage = (chunk) => {
          const frame = JSON.parse(String(chunk));
          const response = frame?.envelope?.message ?? frame?.message;
          if (response?.type !== "response" || response.requestId !== requestId) return;
          clearTimeout(timer);
          socket.off("message", onMessage);
          if (response.error) reject(new Error(response.error));
          else resolve(response.result);
        };
        socket.on("message", onMessage);
        socket.send(JSON.stringify({ type: "ws:rpc", envelope, message: envelope.message }));
      });
    };
    say(`hub ready at ${base}`);

    // Shared scenario state.
    let alice = null;
    let bob = null;
    let bobSecondDevice = null;
    let visibleWorkspace = null;
    let bobWorkspace = null;
    let aliceChild = null;
    let bobChild = null;
    let bobSecondChild = null;

    // WP10 §5.5 — identity invariants: root bootstrap issues the FIRST device
    // as the root user; the subject is host-stamped from the device credential.
    await step("root-bootstrap: first pairing becomes root", async () => {
      const { status, payload } = await auth("complete-pairing", {
        code: rootInviteCode,
        handle: "alice",
        displayName: "Alice",
        label: "smoke-alice-desktop",
      });
      expect(
        status === 200 && payload?.shellToken,
        `root bootstrap pairing failed: HTTP ${status} ${JSON.stringify(payload)}`
      );
      alice = {
        userId: payload.userId,
        shellToken: payload.shellToken,
        deviceId: payload.deviceId,
        refreshToken: payload.refreshToken,
      };
      const profile = await rpc(alice.shellToken, "hubControl.getProfile", {});
      expect(
        profile.payload?.result?.role === "root",
        `first user must be root, got ${JSON.stringify(profile.payload)}`
      );
    });

    await step("workspace catalog: root creates an isolated invitee workspace", async () => {
      const rootView = await rpc(alice.shellToken, "hubControl.listWorkspaces");
      visibleWorkspace = rootView.payload?.result?.[0]?.name;
      expect(typeof visibleWorkspace === "string", "root must see the bootstrap workspace");
      bobWorkspace = "bob-space";
      const created = await rpc(alice.shellToken, "hubControl.createWorkspace", {
        workspace: bobWorkspace,
      });
      expect(
        created.status === 200 && created.payload?.result?.name === bobWorkspace,
        `hubControl.createWorkspace failed: ${JSON.stringify(created.payload)}`
      );
    });

    // WP9 §3 — invite gating: root/admin invites users; the invite code is
    // bound to the invited user, so the redeeming device is issued AS them.
    await step("invite-user: root grants an explicit workspace and invites Bob", async () => {
      const invite = await rpc(alice.shellToken, "hubControl.inviteUser", {
        handle: "bob",
        displayName: "Bob",
        workspaces: [bobWorkspace],
      });
      const pairingCode = invite.payload?.result?.pairing?.code;
      expect(
        invite.status === 200 && pairingCode,
        `hubControl.inviteUser failed: ${JSON.stringify(invite.payload)}`
      );
      const paired = await auth("complete-pairing", {
        code: pairingCode,
        label: "smoke-bob-phone",
      });
      expect(
        paired.status === 200 && paired.payload?.shellToken,
        `bob pairing failed: HTTP ${paired.status}`
      );
      expect(
        paired.payload.userId === invite.payload.result.user.userId,
        "bob's device must be issued as the invited user"
      );
      bob = {
        userId: paired.payload.userId,
        shellToken: paired.payload.shellToken,
        deviceId: paired.payload.deviceId,
        refreshToken: paired.payload.refreshToken,
      };
    });

    await step("invite-user: a member is refused (role gate, live)", async () => {
      const denied = await rpc(bob.shellToken, "hubControl.inviteUser", {
        handle: "carol",
        workspaces: [bobWorkspace],
      });
      expect(
        isAccessDenied(denied),
        `member invite must be EACCES, got HTTP ${denied.status} ${JSON.stringify(denied.payload)}`
      );
    });

    await step("pair-device: a member pairs their OWN second device", async () => {
      const code = await rpc(bob.shellToken, "hubControl.pairDevice", {
        workspace: bobWorkspace,
      });
      const pairingCode = code.payload?.result?.pairing?.code;
      expect(
        code.status === 200 && pairingCode,
        `hubControl.pairDevice failed: ${JSON.stringify(code.payload)}`
      );
      const paired = await auth("complete-pairing", {
        code: pairingCode,
        label: "smoke-bob-laptop",
      });
      expect(
        paired.status === 200 && paired.payload.userId === bob.userId,
        "the second device must belong to the same user"
      );
      bobSecondDevice = {
        userId: paired.payload.userId,
        shellToken: paired.payload.shellToken,
        deviceId: paired.payload.deviceId,
        refreshToken: paired.payload.refreshToken,
      };
    });

    // WP10 §5.2 — cross-workspace membership entry gate: the hub omits
    // non-member workspaces from workspace.list, and workspace.route refuses
    // a non-member with EACCES before any child is spawned.
    await step("membership: hub omits non-member workspaces from list", async () => {
      const memberView = await rpc(bob.shellToken, "hubControl.listWorkspaces");
      const bobNames = (memberView.payload?.result ?? []).map((entry) => entry.name);
      expect(
        bobNames.includes(bobWorkspace),
        `member must see the explicitly granted workspace, got ${JSON.stringify(bobNames)}`
      );
      expect(
        !bobNames.includes(visibleWorkspace),
        `non-member must not see "${visibleWorkspace}", got ${JSON.stringify(bobNames)}`
      );
    });

    await step("membership: route refuses a non-member with EACCES (no child spawn)", async () => {
      const denied = await rpc(bob.shellToken, "hubControl.routeWorkspace", {
        workspace: visibleWorkspace,
      });
      expect(
        isAccessDenied(denied),
        `non-member route must be EACCES, got HTTP ${denied.status} ${JSON.stringify(denied.payload)}`
      );
    });

    await step("membership: addMember is role-gated", async () => {
      const denied = await rpc(bob.shellToken, "hubControl.addWorkspaceMember", {
        handle: "bob",
        workspace: visibleWorkspace,
      });
      expect(isAccessDenied(denied), `member addMember must be EACCES, got HTTP ${denied.status}`);
    });

    // WP10 §5.5 — identity invariants: a client-asserted userId never lets a
    // caller act as someone else; attribution keys on the host-stamped subject.
    await step("identity: client-asserted userId is refused for writes", async () => {
      const denied = await rpc(bob.shellToken, "hubControl.updateProfile", {
        userId: alice.userId,
        displayName: "intruder",
      });
      expect(
        isAccessDenied(denied),
        `cross-user profile write must be EACCES, got HTTP ${denied.status}`
      );
      const self = await rpc(bob.shellToken, "hubControl.getProfile", {});
      expect(
        self.payload?.result?.handle === "bob",
        "subject must resolve to the device's own user"
      );
    });

    await step(
      "membership: root grants the shared workspace and both users route to one child",
      async () => {
        const added = await rpc(alice.shellToken, "hubControl.addWorkspaceMember", {
          handle: "bob",
          workspace: visibleWorkspace,
        });
        expect(
          added.status === 200,
          `hubControl.addWorkspaceMember failed: ${JSON.stringify(added.payload)}`
        );
        const aliceRoute = await routeWorkspace(alice, visibleWorkspace);
        const bobRoute = await routeWorkspace(bob, visibleWorkspace);
        const bobSecondRoute = await routeWorkspace(bobSecondDevice, visibleWorkspace);
        expect(
          aliceRoute.status === 200 && bobRoute.status === 200 && bobSecondRoute.status === 200,
          "both members and both Bob devices must route"
        );
        expect(
          aliceRoute.payload.serverUrl === bobRoute.payload.serverUrl,
          "both users must enter the same child"
        );
        aliceChild = await refreshWorkspace(aliceRoute.payload.serverUrl, alice);
        bobChild = await refreshWorkspace(bobRoute.payload.serverUrl, bob);
        bobSecondChild = await refreshWorkspace(bobSecondRoute.payload.serverUrl, bobSecondDevice);
      }
    );

    await step("two-users-one-workspace: panel forest and approval queue are shared", async () => {
      const alicePending = await childRpc(aliceChild, "shellApproval.listPending");
      const bobPending = await childRpc(bobChild, "shellApproval.listPending");
      const aliceIds = alicePending.map((entry) => entry.approvalId).sort();
      const bobIds = bobPending.map((entry) => entry.approvalId).sort();
      expect(
        JSON.stringify(aliceIds) === JSON.stringify(bobIds),
        "members must inspect the same approval queue"
      );
      const created = await childRpc(aliceChild, "panelTree.create", "panels/chat", {
        name: "Shared smoke panel",
        focus: false,
      });
      const bobSnapshot = await childRpc(bobChild, "panelTree.getTreeSnapshot");
      const flatten = (panels) =>
        panels.flatMap((panel) => [panel, ...flatten(panel.children ?? [])]);
      const allPanels = (bobSnapshot.forest ?? []).flatMap((group) => group.rootPanels ?? []);
      expect(
        flatten(allPanels).some((panel) => panel.id === created.id),
        "Bob must see Alice's panel"
      );
    });

    await step(
      "provenance: Bob's shared approval resolution is durable and attributed",
      async () => {
        const worker = await childRpc(aliceChild, "runtime.createEntity", {
          kind: "worker",
          source: "workers/agent-worker",
          key: `multi-user-provenance-${Date.now().toString(36)}`,
        });
        const grant = await childRpc(aliceChild, "auth.grantConnection", worker.id);
        const workerSession = {
          serverUrl: aliceChild.serverUrl,
          shellToken: grant.token,
          callerId: worker.id,
        };
        const workerSocket = await openChildSocket(workerSession, "provenance-worker");
        const openRequest = childWsRpc(
          workerSocket,
          worker.id,
          "worker",
          "externalOpen.openExternal",
          "https://example.com/full-system-smoke"
        );
        const deadline = Date.now() + 10_000;
        let approval = null;
        while (!approval && Date.now() < deadline) {
          const pending = await childRpc(bobChild, "shellApproval.listPending");
          approval = pending.find(
            (entry) => entry.kind === "capability" && entry.capability === "external-browser-open"
          );
          if (!approval) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(approval?.approvalId, "worker request must expose a capability approval");
        await childRpc(bobChild, "shellApproval.resolve", approval.approvalId, "version");
        await openRequest;
        const after = await childRpc(aliceChild, "shellApproval.listPending");
        expect(
          !after.some((entry) => entry.approvalId === approval.approvalId),
          "one resolution must settle the shared queue"
        );
        const records = await childRpc(aliceChild, "governance.list", {
          filter: { recordKind: "approval" },
          limit: 100,
        });
        const record = records.find((entry) => entry.approvalId === approval.approvalId);
        expect(
          record?.resolvedBy?.userId === bob.userId,
          `governance must attribute Bob: ${JSON.stringify(record)}`
        );
      }
    );

    await step("workspace and hub presence aggregate physical endpoints", async () => {
      await openChildSocket(aliceChild, "alice-desktop");
      await openChildSocket(bobChild, "bob-phone");
      await openChildSocket(bobSecondChild, "bob-laptop");
      const deadline = Date.now() + 10_000;
      let presence = [];
      let hubPresence = null;
      while (Date.now() < deadline) {
        presence = await childRpc(aliceChild, "workspacePresence.list");
        const hubResponse = await rpc(alice.shellToken, "hubControl.listUserPresence", {
          userId: bob.userId,
        });
        hubPresence = hubResponse.payload?.result;
        const alicePresence = presence.find((entry) => entry.userId === alice.userId);
        const bobPresence = presence.find((entry) => entry.userId === bob.userId);
        const bobWorkspacePresence = hubPresence?.workspaces?.find(
          (entry) => entry.workspace === visibleWorkspace
        );
        if (
          alicePresence?.online &&
          alicePresence.endpoints === 1 &&
          bobPresence?.online &&
          bobPresence.endpoints === 2 &&
          bobWorkspacePresence?.endpoints === 2
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `presence did not converge: workspace=${JSON.stringify(presence)} hub=${JSON.stringify(hubPresence)}`
      );
    });

    await step("membership removal closes the removed user's live child sessions", async () => {
      const removed = await rpc(alice.shellToken, "hubControl.removeWorkspaceMember", {
        handle: "bob",
        workspace: visibleWorkspace,
      });
      expect(
        removed.status === 200 && removed.payload?.result?.removed,
        `removeMember failed: ${JSON.stringify(removed.payload)}`
      );
      expect(
        removed.payload.result.closedSessions >= 1,
        "removeMember must close Bob's live child sessions"
      );
      let refused = false;
      try {
        await childRpc(bobChild, "panelTree.getTreeSnapshot");
      } catch {
        refused = true;
      }
      expect(refused, "removed member must lose child access immediately");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(`FAIL  harness: ${message}`);
    results.push({ name: "harness", status: "fail", detail: message });
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await stopChild(hub);
    await stopChild(signaling);
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "ok");
  say(`summary: ${passed.length} ok, ${failed.length} failed`);
  await fsp.writeFile(
    path.join(resultsDir, "multi-user-scenarios.json"),
    JSON.stringify(results, null, 2)
  );
  log.end();
  const elapsedMs = Date.now() - startedAt;
  if (failed.length > 0) {
    throw new Error(`${phase} failed: ${failed.map((r) => r.name).join("; ")}. Log: ${logFile}`);
  }
  console.log(`[full-smoke] phase=${phase} ok elapsedMs=${elapsedMs}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const resultsDir =
    options.resultsDir ?? path.join(defaultResultsRoot, `${timestamp()}-${process.pid}`);
  await ensureDir(resultsDir);
  await fsp.writeFile(
    path.join(resultsDir, "environment.json"),
    JSON.stringify(
      {
        cwd: repoRoot,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        hostname: os.hostname(),
        options,
      },
      null,
      2
    )
  );

  console.log(`[full-smoke] results=${resultsDir}`);

  if (!options.skipBuild) {
    await runPhase("build", "pnpm", ["build"], { resultsDir });
  }
  if (!options.skipMultiUser) {
    await runMultiUserPhase(options, resultsDir);
    await runPhase(
      "channel-contracts",
      "pnpm",
      [
        "--dir",
        "workspace",
        "exec",
        "vitest",
        "run",
        "--root",
        "..",
        "--config",
        "vitest.userland.config.ts",
        "workspace/workers/pubsub-channel/channel-do.test.ts",
      ],
      { resultsDir }
    );
  }
  if (!options.skipCliRemote) {
    const args = [
      path.join(repoRoot, "scripts", "cli-remote-smoke.mjs"),
      "--timeout-ms",
      String(options.timeoutMs),
    ];
    if (options.localSignaling) args.push("--local-signaling");
    if (options.signalUrl) args.push("--signal-url", options.signalUrl);
    await runPhase("cli-remote", process.execPath, args, { resultsDir });
  }
  if (!options.skipDesktopPairing) {
    const args = [
      path.join(repoRoot, "scripts", "desktop-pairing-smoke.mjs"),
      "--timeout-ms",
      String(options.timeoutMs),
    ];
    if (options.localSignaling) args.push("--local-signaling");
    if (options.signalUrl) args.push("--signal-url", options.signalUrl);
    await runPhase("desktop-pairing", process.execPath, args, { resultsDir });
  }
  if (!options.skipDesktopE2e) {
    await runPhase("desktop-e2e", "pnpm", ["test:e2e"], { resultsDir });
  }
  if (!options.skipAndroid) {
    const args = [
      path.join(repoRoot, "scripts", "cli", "mobile-smoke.mjs"),
      "--platform",
      "android",
      "--timeout-ms",
      String(options.timeoutMs),
      "--pairing-timeout-ms",
      String(Math.max(180_000, Math.floor(options.timeoutMs / 2))),
    ];
    if (options.androidDevice) args.push("--device", options.androidDevice);
    if (options.androidAvd) args.push("--avd", options.androidAvd);
    if (options.androidNoBuild) args.push("--no-build");
    if (options.androidNoInstall) args.push("--no-install");
    if (options.localSignaling) args.push("--local-signaling");
    if (options.requireTurn) args.push("--require-turn");
    if (options.signalUrl) args.push("--signal-url", options.signalUrl);
    await runPhase("android-mobile", process.execPath, args, { resultsDir });
  }

  console.log(`[full-smoke] ok results=${resultsDir}`);
}

main().catch((error) => {
  console.error(`[full-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
