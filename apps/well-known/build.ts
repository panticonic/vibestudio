/**
 * Build the static `.well-known/` payload served by the Cloudflare Pages
 * site at `apps/well-known/`. This output is reachable at every host the
 * Pages project is bound to — currently the production host `vibestudio.app`,
 * which is what `applinks:` / `assetlinks.json` anchor on; see the generated
 * iOS entitlements and `apps/mobile/android/app/src/main/AndroidManifest.xml`.
 *
 * Two files are emitted (both are static JSON):
 *   - `/.well-known/apple-app-site-association` (NO `.json` extension; per
 *     Apple's spec) — must be served as `application/json`. Wrangled via
 *     the generated `_headers` file below.
 *   - `/.well-known/assetlinks.json` — Android App Links verification.
 *
 * Run `pnpm --filter @vibestudio/well-known build:site` to regenerate.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Config {
  apple: {
    teamId: string;
    bundleId: string;
  };
  android: {
    packageName: string;
    sha256CertFingerprints: string[];
  };
}

const rootDir = __dirname;
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const wellKnownDir = path.join(distDir, ".well-known");

const rawConfig = JSON.parse(readFileSync(path.join(rootDir, "config.json"), "utf8")) as Record<
  string,
  unknown
>;
const strictPlaceholderCheck =
  process.env.ALLOW_PLACEHOLDER_WELLKNOWN !== "1" &&
  (process.env.CI === "true" ||
    process.env.NODE_ENV === "production" ||
    process.env.STRICT_WELLKNOWN === "1");

// Strip `_comment_*` keys (used in config.json to document TODOs without
// polluting the JSON Schema with optional fields).
function stripComments(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k.startsWith("_comment_")) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return obj;
}

const config = resolveConfig(stripComments(rawConfig) as Config);

function resolveConfig(fileConfig: Config): Config {
  const teamId = process.env.VIBESTUDIO_APPLE_TEAM_ID?.trim() || fileConfig.apple.teamId;
  const bundleId = process.env.VIBESTUDIO_IOS_BUNDLE_ID?.trim() || fileConfig.apple.bundleId;
  const packageName =
    process.env.VIBESTUDIO_ANDROID_PACKAGE_NAME?.trim() || fileConfig.android.packageName;
  const fingerprints =
    parseFingerprintEnv(process.env.VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS) ??
    fileConfig.android.sha256CertFingerprints;

  validateConfig({
    apple: { teamId, bundleId },
    android: { packageName, sha256CertFingerprints: fingerprints },
  });

  return {
    apple: { teamId, bundleId },
    android: { packageName, sha256CertFingerprints: fingerprints },
  };
}

function parseFingerprintEnv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function validateConfig(config: Config): void {
  if (config.apple.teamId && !/^[A-Z0-9]{10}$/.test(config.apple.teamId)) {
    throw new Error(
      "Invalid Apple Team ID for well-known payload. Expected a 10-character alphanumeric Team ID."
    );
  }
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(config.apple.bundleId)) {
    throw new Error("Invalid iOS bundle identifier for well-known payload.");
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(config.android.packageName)) {
    throw new Error("Invalid Android package name for well-known payload.");
  }
  if (config.android.sha256CertFingerprints.length === 0 && strictPlaceholderCheck) {
    throw new Error("At least one Android SHA256 cert fingerprint is required for production.");
  }
  for (const fingerprint of config.android.sha256CertFingerprints) {
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
      throw new Error(
        `Invalid Android SHA256 cert fingerprint for well-known payload: ${fingerprint}`
      );
    }
  }
}

function applyReplacements(template: string, replacements: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });
}

const appleTemplate = readFileSync(
  path.join(srcDir, "apple-app-site-association.template.json"),
  "utf8"
);
const assetlinksTemplate = readFileSync(path.join(srcDir, "assetlinks.template.json"), "utf8");

const appleOutput = applyReplacements(appleTemplate, {
  appIds: config.apple.teamId
    ? JSON.stringify([`${config.apple.teamId}.${config.apple.bundleId}`])
    : "[]",
});

const assetlinksOutput = applyReplacements(assetlinksTemplate, {
  packageName: config.android.packageName,
  sha256CertFingerprints: JSON.stringify(config.android.sha256CertFingerprints),
});

if (strictPlaceholderCheck && !config.apple.teamId) {
  throw new Error("VIBESTUDIO_APPLE_TEAM_ID is required for production well-known builds.");
}

mkdirSync(wellKnownDir, { recursive: true });

writeFileSync(path.join(wellKnownDir, "apple-app-site-association"), appleOutput, "utf8");
writeFileSync(path.join(wellKnownDir, "assetlinks.json"), assetlinksOutput, "utf8");

// Cloudflare Pages `_headers` file — applies per-path response headers.
// AASA must be `application/json` (Apple rejects `text/plain`/octet-stream
// silently). assetlinks.json gets the same treatment for consistency. A
// short `Cache-Control` lets us push corrections without waiting on
// Apple's 24h re-fetch cadence too long.
const headers = `# Generated by apps/well-known/build.ts -- do not edit by hand.
/.well-known/apple-app-site-association
  Content-Type: application/json
  Cache-Control: public, max-age=3600
  X-Content-Type-Options: nosniff

/.well-known/assetlinks.json
  Content-Type: application/json
  Cache-Control: public, max-age=3600
  X-Content-Type-Options: nosniff

/pair
  Content-Type: text/html; charset=utf-8
  Cache-Control: public, max-age=300
  X-Content-Type-Options: nosniff

/panel
  Content-Type: text/html; charset=utf-8
  Cache-Control: public, max-age=300
  X-Content-Type-Options: nosniff
`;
writeFileSync(path.join(distDir, "_headers"), headers, "utf8");

// Tiny landing page so a GET to `/` doesn't 404 in browser sanity checks.
writeFileSync(
  path.join(distDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>vibestudio</title><p>Vibestudio universal-link verification host.</p>`,
  "utf8"
);

writeFileSync(
  path.join(distDir, "pair"),
  `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair Vibestudio</title>
<style>
body{font:16px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:32px;line-height:1.45;color:#111;background:#fff}
main{max-width:680px;margin:0 auto}
button,a.button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border:1px solid #111;border-radius:6px;background:#111;color:#fff;text-decoration:none;font-weight:600}
code{overflow-wrap:anywhere}
.muted{color:#555}
</style>
<main>
  <h1>Pair Vibestudio</h1>
  <p id="status">Preparing pairing link.</p>
  <p><button id="open" type="button">Open in Vibestudio</button></p>
  <p class="muted" id="install">If Vibestudio is not installed, build or install the mobile shell, then return to this page and open the link.</p>
  <p><code id="link"></code></p>
</main>
<script>
(() => {
  const fragment = location.hash ? location.hash.slice(1) : "";
  const status = document.getElementById("status");
  const link = document.getElementById("link");
  const open = document.getElementById("open");
  if (!fragment) {
    status.textContent = "This pair URL is missing its private fragment. Scan a fresh QR from Vibestudio.";
    open.disabled = true;
    return;
  }
  const scheme = "vibestudio://connect?" + fragment;
  link.textContent = scheme;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const openLink = () => {
    if (isAndroid) {
      location.href = "intent://connect?" + fragment + "#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end";
      return;
    }
    location.href = scheme;
  };
  if (isAndroid) {
    status.textContent = "Opening Vibestudio. If it does not open, install the Android shell and retry.";
    setTimeout(openLink, 50);
  } else if (isIos) {
    status.textContent = "Tap Open in Vibestudio. If it is not installed, build the iOS shell on your Mac first.";
  } else {
    status.textContent = "Open this link on a phone with Vibestudio installed.";
  }
  open.addEventListener("click", openLink);
})();
</script>`,
  "utf8"
);

writeFileSync(
  path.join(distDir, "panel"),
  `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open Vibestudio panel</title>
<style>
body{font:16px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:32px;line-height:1.45;color:#111;background:#fff}
main{max-width:680px;margin:0 auto}
button{min-height:40px;padding:0 14px;border:1px solid #111;border-radius:6px;background:#111;color:#fff;font-weight:600}
code{overflow-wrap:anywhere}.muted{color:#555}
</style>
<main>
  <h1>Open Vibestudio panel</h1>
  <p id="status">Preparing panel link.</p>
  <p><button id="open" type="button">Open in Vibestudio</button></p>
  <p class="muted">Panel links can contain workspace state arguments. Only open links from a source you trust.</p>
  <p><code id="link"></code></p>
</main>
<script>
(() => {
  const fragment = location.hash ? location.hash.slice(1) : "";
  const status = document.getElementById("status");
  const link = document.getElementById("link");
  const open = document.getElementById("open");
  if (!fragment) {
    status.textContent = "This panel URL is missing its location fragment.";
    open.disabled = true;
    return;
  }
  const scheme = "vibestudio://panel?" + fragment;
  link.textContent = scheme;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const openLink = () => {
    location.href = isAndroid
      ? "intent://panel?" + fragment + "#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end"
      : scheme;
  };
  status.textContent = "Open this logical panel location in Vibestudio.";
  open.addEventListener("click", openLink);
})();
</script>`,
  "utf8"
);
