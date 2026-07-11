#!/usr/bin/env node
// Production smoke for the Cloudflare signaling Worker.
//
// This intentionally does not create RTCPeerConnections. It validates the edge
// deployment itself: health route, ICE-server response, and room WebSocket relay.
import { randomUUID } from "node:crypto";
import process from "node:process";
import WebSocket from "ws";

const DEFAULT_SIGNAL_URL = "wss://signal.vibestudio.app/";

try {
  await main();
} catch (error) {
  console.error(
    `[smoke:cloudflare:signaling] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const signalUrl = normalizeSignalUrl(
    options.signalUrl || process.env["VIBESTUDIO_WEBRTC_SIGNAL_URL"] || DEFAULT_SIGNAL_URL
  );
  const room = options.room || `smoke-${randomUUID()}`;

  console.log(`[smoke:cloudflare:signaling] endpoint ${signalUrl.href}`);
  console.log(`[smoke:cloudflare:signaling] room     ${room}`);

  const health = await fetchJson(routeUrl(signalUrl, "/healthz"));
  if (!health.response.ok || health.body?.ok !== true) {
    throw new Error(`health failed: ${health.response.status} ${JSON.stringify(health.body)}`);
  }
  console.log("[smoke:cloudflare:signaling] health ok");

  const ice = await fetchJson(routeUrl(signalUrl, `/room/${encodeURIComponent(room)}/ice-servers`));
  if (!ice.response.ok) {
    throw new Error(`ice-servers failed: ${ice.response.status} ${JSON.stringify(ice.body)}`);
  }
  const iceServers = Array.isArray(ice.body?.iceServers) ? ice.body.iceServers : [];
  if (iceServers.length === 0) throw new Error("ice-servers response was empty");
  const turnHeader = ice.response.headers.get("x-signaling-turn") ?? "missing";
  const hasTurn = iceServers.some((server) =>
    urlsFor(server).some((url) => url.startsWith("turn:") || url.startsWith("turns:"))
  );
  if (options.expectTurn && (!hasTurn || turnHeader !== "minted")) {
    throw new Error(
      `expected TURN credentials, got x-signaling-turn=${turnHeader} body=${JSON.stringify(ice.body)}`
    );
  }
  console.log(`[smoke:cloudflare:signaling] ice ok (${turnHeader})`);

  const offerer = await openSocket(roleUrl(signalUrl, room, "offerer"));
  try {
    const offer = JSON.stringify({
      t: "description",
      desc: { type: "offer", sdp: `vibestudio-smoke-offer-${Date.now()}` },
    });
    offerer.ws.send(offer);

    const answerer = await openSocket(roleUrl(signalUrl, room, "answerer"));
    try {
      const relayed = await waitForMessage(answerer.ws, (message) => {
        try {
          return JSON.parse(message).t === "description";
        } catch {
          return false;
        }
      });
      if (relayed !== offer) {
        throw new Error(`relayed description mismatch: ${relayed}`);
      }
      console.log("[smoke:cloudflare:signaling] websocket relay ok");
    } finally {
      answerer.close();
    }
  } finally {
    offerer.close();
  }

  console.log("[smoke:cloudflare:signaling] ok");
}

function parseArgs(argv) {
  const options = { expectTurn: false, help: false, room: "", signalUrl: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--expect-turn") {
      options.expectTurn = true;
    } else if (arg === "--room") {
      options.room = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--room=")) {
      options.room = arg.slice("--room=".length);
    } else if (arg === "--signal-url") {
      options.signalUrl = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--signal-url=")) {
      options.signalUrl = arg.slice("--signal-url=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm smoke:cloudflare:signaling [-- options]

Validate a deployed Vibestudio signaling Worker.

Options:
  --signal-url <url>  Signaling origin. Default: ${DEFAULT_SIGNAL_URL}
  --room <room>       Explicit smoke room id. Default: random UUID room
  --expect-turn       Fail unless /ice-servers returns TURN credentials
  --help              Show this help
`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeSignalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid --signal-url: ${raw}`);
  }
  if (!["wss:", "ws:", "https:", "http:"].includes(url.protocol)) {
    throw new Error(`--signal-url must be ws(s) or http(s), got ${url.protocol}`);
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url;
}

function routeUrl(signalUrl, suffix) {
  const url = new URL(signalUrl.href);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = joinPath(url.pathname, suffix);
  url.search = "";
  url.hash = "";
  return url;
}

function roleUrl(signalUrl, room, role) {
  const url = new URL(signalUrl.href);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname = joinPath(url.pathname, `/room/${encodeURIComponent(room)}`);
  url.search = "";
  url.searchParams.set("role", role);
  url.hash = "";
  return url;
}

function joinPath(basePath, suffix) {
  const base = basePath.replace(/\/+$/, "");
  const next = suffix.replace(/^\/+/, "");
  return `/${[base.replace(/^\/+/, ""), next].filter(Boolean).join("/")}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

function urlsFor(server) {
  const urls = server?.urls;
  if (typeof urls === "string") return [urls];
  if (Array.isArray(urls)) return urls.filter((url) => typeof url === "string");
  return [];
}

function openSocket(url) {
  const ws = new WebSocket(url.href);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error(`websocket open timed out: ${url.href}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve({ ws, close: () => ws.close() });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`websocket closed before open (${code} ${reason.toString()}): ${url.href}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for relayed signaling message"));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onMessage = (data) => {
      const message = data.toString();
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`websocket closed before relay (${code} ${reason.toString()})`));
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}
