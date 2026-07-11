#!/usr/bin/env node
// Production smoke for the apex Vibestudio Worker.
import process from "node:process";

const DEFAULT_ORIGIN = "https://vibestudio.app";

try {
  await main();
} catch (error) {
  console.error(
    `[smoke:cloudflare:apex] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
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

  const pair = await fetchText(new URL("/pair", origin));
  if (!pair.response.ok) throw new Error(`/pair failed: ${pair.response.status}`);
  if (!pair.response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`/pair content-type was ${pair.response.headers.get("content-type")}`);
  }
  if (!pair.text.includes("vibestudio://connect?") || !pair.text.includes("location.hash")) {
    throw new Error("/pair did not contain the pairing trampoline");
  }
  console.log("[smoke:cloudflare:apex] pair ok");

  await checkWellKnown(origin, options.expectAppLinks);
  console.log("[smoke:cloudflare:apex] well-known ok");
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
  if (!Array.isArray(components) || !components.some((component) => component?.["/"] === "/pair")) {
    throw new Error("AASA does not include /pair");
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
