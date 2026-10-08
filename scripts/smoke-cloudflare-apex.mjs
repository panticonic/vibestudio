#!/usr/bin/env node
// Production smoke for the apex Vibestudio Worker.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const DEFAULT_ORIGIN = "https://vibestudio.app";
const BACKHAUL_TIMEOUT_MS = 10_000;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[smoke:cloudflare:apex] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const origin = normalizeOrigin(options.origin || DEFAULT_ORIGIN);
  console.log(`[smoke:cloudflare:apex] origin ${origin.origin}`);

  await expectJson(origin, "/healthz", (body) => body?.ok === true, "health");
  console.log("[smoke:cloudflare:apex] health ok");

  const landing = await fetchText(new URL("/", origin));
  if (!landing.response.ok) throw new Error(`/ failed: ${landing.response.status}`);
  if (!landing.response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`/ content-type was ${landing.response.headers.get("content-type")}`);
  }
  if (!landing.text.includes("Vibestudio")) throw new Error("/ did not contain the apex landing");
  console.log("[smoke:cloudflare:apex] landing ok");

  const pair = await fetchText(new URL("/p", origin));
  if (!pair.response.ok) throw new Error(`/p failed: ${pair.response.status}`);
  if (!pair.response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`/p content-type was ${pair.response.headers.get("content-type")}`);
  }
  if (!pair.text.includes("vibestudio://connect/") || !pair.text.includes("location.hash")) {
    throw new Error("/p did not contain the pairing trampoline");
  }
  console.log("[smoke:cloudflare:apex] pair ok");

  await checkWellKnown(origin, options.expectAppLinks);
  console.log("[smoke:cloudflare:apex] well-known ok");

  await checkBackhaul(origin);
  console.log("[smoke:cloudflare:apex] authenticated backhaul ok");
  console.log("[smoke:cloudflare:apex] ok");
}

function parseArgs(argv) {
  const options = { expectAppLinks: false, help: false, origin: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--expect-app-links") {
      options.expectAppLinks = true;
    } else if (arg === "--origin") {
      options.origin = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--origin=")) {
      options.origin = arg.slice("--origin=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm smoke:cloudflare:apex [-- options]

Validate the deployed Vibestudio apex Worker.

Options:
  --origin <url>         Apex origin. Default: ${DEFAULT_ORIGIN}
  --expect-app-links     Fail unless both .well-known app-link documents are live
  --help                 Show this help
`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid --origin: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`--origin must be http(s), got ${url.protocol}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export async function checkBackhaul(origin) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const relayId = `rly_${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  const subscriptionId = `smoke_${randomUUID().replaceAll("-", "")}`;
  const backhaulUrl = () => {
    const timestamp = String(Date.now());
    const signature = sign("sha256", Buffer.from(`${relayId}\n${timestamp}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/backhaul";
    url.search = new URLSearchParams({
      relayId,
      ts: timestamp,
      key: publicKeyDer.toString("base64url"),
      sig: signature,
    }).toString();
    return url;
  };

  let socket;
  let registrationAttempted = false;
  let unregistered = false;
  let primaryError;
  try {
    socket = await openBackhaul(backhaulUrl());
    registrationAttempted = true;
    await exchangeBackhaulFrame(
      socket,
      { t: "register-webhook", subscriptionId },
      "registered",
      subscriptionId
    );
    await exchangeBackhaulFrame(
      socket,
      { t: "unregister-webhook", subscriptionId },
      "unregistered",
      subscriptionId
    );
    unregistered = true;
  } catch (error) {
    primaryError = error;
    if (registrationAttempted && !unregistered) {
      try {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          socket = await openBackhaul(backhaulUrl());
        }
        await exchangeBackhaulFrame(
          socket,
          { t: "unregister-webhook", subscriptionId },
          "unregistered",
          subscriptionId
        );
        unregistered = true;
      } catch (cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `Backhaul probe failed and cleanup of ${subscriptionId} was not acknowledged`,
          { cause: primaryError }
        );
      }
    }
    throw primaryError;
  } finally {
    if (socket) await retireBackhaulSocket(socket);
  }
}

async function openBackhaul(url) {
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error(`backhaul connect timed out after ${BACKHAUL_TIMEOUT_MS}ms`)),
        BACKHAUL_TIMEOUT_MS
      );
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = (error) => finish(error);
      const onClose = (code, reason) =>
        finish(new Error(`backhaul closed before connection was ready: ${code} ${String(reason)}`));
      const onUnexpectedResponse = (_request, response) =>
        finish(new Error(`backhaul upgrade failed: HTTP ${response.statusCode}`));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
    return socket;
  } catch (error) {
    await retireBackhaulSocket(socket);
    throw error;
  }
}

async function exchangeBackhaulFrame(socket, outbound, expected, subscriptionId) {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error(`backhaul is not open for ${outbound.t}`);
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error(`backhaul ${outbound.t} timed out after ${BACKHAUL_TIMEOUT_MS}ms`)),
      BACKHAUL_TIMEOUT_MS
    );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        finish(new Error("backhaul returned a non-JSON frame"));
        return;
      }
      if (frame.id !== subscriptionId) return;
      if (frame.t === expected && frame.kind === "webhook") {
        finish();
        return;
      }
      if (frame.t === "register-rejected" || frame.t === "unregister-rejected") {
        finish(new Error(`backhaul ${frame.t}: ${String(frame.reason ?? "unknown")}`));
      }
    };
    const onError = (error) => finish(error);
    const onClose = (code, reason) =>
      finish(new Error(`backhaul closed before ${expected} ack: ${code} ${String(reason)}`));
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.send(JSON.stringify(outbound), (error) => {
      if (error) finish(error);
    });
  });
}

async function retireBackhaulSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.terminate();
  await closed;
}

async function checkWellKnown(origin, expectAppLinks) {
  const apple = await fetchJson(new URL("/.well-known/apple-app-site-association", origin));
  const android = await fetchJson(new URL("/.well-known/assetlinks.json", origin));

  if (!expectAppLinks && apple.response.status === 503 && android.response.status === 503) {
    console.log("[smoke:cloudflare:apex] app-link metadata not configured yet (503 accepted)");
    return;
  }
  if (!expectAppLinks && (apple.response.status === 503 || android.response.status === 503)) {
    throw new Error(
      `app-link metadata is partially configured: AASA=${apple.response.status} assetlinks=${android.response.status}`
    );
  }

  if (!apple.response.ok)
    throw new Error(`AASA failed: ${apple.response.status} ${JSON.stringify(apple.body)}`);
  if (!android.response.ok)
    throw new Error(
      `assetlinks failed: ${android.response.status} ${JSON.stringify(android.body)}`
    );
  expectWellKnownHeaders(apple.response, "AASA");
  expectWellKnownHeaders(android.response, "assetlinks");

  const components = apple.body?.applinks?.details?.[0]?.components;
  if (!Array.isArray(components) || !components.some((component) => component?.["/"] === "/p")) {
    throw new Error("AASA does not include /p");
  }
  if (!Array.isArray(android.body) || android.body.length === 0) {
    throw new Error("assetlinks is empty");
  }
}

function expectWellKnownHeaders(response, label) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${label} content-type was ${response.headers.get("content-type")}`);
  }
  if (!response.headers.get("cache-control")?.includes("max-age=3600")) {
    throw new Error(`${label} cache-control was ${response.headers.get("cache-control")}`);
  }
}

async function expectJson(origin, path, predicate, label) {
  const { response, body } = await fetchJson(new URL(path, origin));
  if (!response.ok || !predicate(body)) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

async function fetchJson(url) {
  const { response, text } = await fetchText(url);
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { response, text };
}
