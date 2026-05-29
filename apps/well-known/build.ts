/**
 * Build the static `.well-known/` payload served by the Cloudflare Pages
 * site at `apps/well-known/`. This output is reachable at every host the
 * Pages project is bound to — currently the production apex `snugenv.com`
 * and the dedicated OAuth-callback sub-host `auth.snugenv.com` (the latter
 * is what `applinks:` / `assetlinks.json` actually anchor on; see
 * `apps/mobile/ios/NatStack/NatStack.entitlements` and
 * `apps/mobile/android/app/src/main/AndroidManifest.xml`).
 *
 * Two files are emitted (both are static JSON):
 *   - `/.well-known/apple-app-site-association` (NO `.json` extension; per
 *     Apple's spec) — must be served as `application/json`. Wrangled via
 *     the generated `_headers` file below.
 *   - `/.well-known/assetlinks.json` — Android App Links verification.
 *
 * Run `pnpm --filter @natstack/well-known build:site` to regenerate.
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

const rawConfig = JSON.parse(
  readFileSync(path.join(rootDir, "config.json"), "utf8"),
) as Record<string, unknown>;
const strictPlaceholderCheck =
  process.env.ALLOW_PLACEHOLDER_WELLKNOWN !== "1" &&
  (process.env.CI === "true" || process.env.NODE_ENV === "production" || process.env.STRICT_WELLKNOWN === "1");

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
  const teamId = process.env.NATSTACK_APPLE_TEAM_ID?.trim() || fileConfig.apple.teamId;
  const bundleId = process.env.NATSTACK_IOS_BUNDLE_ID?.trim() || fileConfig.apple.bundleId;
  const packageName =
    process.env.NATSTACK_ANDROID_PACKAGE_NAME?.trim() || fileConfig.android.packageName;
  const fingerprints =
    parseFingerprintEnv(process.env.NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS) ??
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
  if (!isPlaceholder(config.apple.teamId) && !/^[A-Z0-9]{10}$/.test(config.apple.teamId)) {
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
  if (config.android.sha256CertFingerprints.length === 0) {
    throw new Error("At least one Android SHA256 cert fingerprint is required.");
  }
  for (const fingerprint of config.android.sha256CertFingerprints) {
    if (isPlaceholder(fingerprint)) continue;
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
      throw new Error(
        `Invalid Android SHA256 cert fingerprint for well-known payload: ${fingerprint}`
      );
    }
  }
}

function isPlaceholder(value: string): boolean {
  return /^TODO_/.test(value);
}

function applyReplacements(
  template: string,
  replacements: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });
}

const appleTemplate = readFileSync(
  path.join(srcDir, "apple-app-site-association.template.json"),
  "utf8",
);
const assetlinksTemplate = readFileSync(
  path.join(srcDir, "assetlinks.template.json"),
  "utf8",
);

const appleOutput = applyReplacements(appleTemplate, {
  teamId: config.apple.teamId,
  bundleId: config.apple.bundleId,
});

const assetlinksOutput = applyReplacements(assetlinksTemplate, {
  packageName: config.android.packageName,
  sha256CertFingerprints: JSON.stringify(
    config.android.sha256CertFingerprints,
  ),
});

// Refuse to ship placeholder values to production. The build script is
// run in CI; failing here keeps a misconfigured AASA from being deployed
// (which would silently break universal-link verification on every
// installed device for ~24h until Apple's CDN re-fetches).
const PLACEHOLDER_PATTERNS = [/TODO_TEAM_ID/, /TODO_SHA256_FROM_KEYSTORE/];
for (const text of [appleOutput, assetlinksOutput]) {
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(text) && strictPlaceholderCheck) {
      throw new Error(
        `Refusing to build well-known payload: placeholder ${pat.source} still present in apps/well-known/config.json. ` +
          `Fill in the real Apple Team ID and Android signing-cert SHA256 fingerprint. ` +
          `Set ALLOW_PLACEHOLDER_WELLKNOWN=1 to override.`,
      );
    } else if (pat.test(text)) {
      console.warn(
        `[well-known] Placeholder ${pat.source} is still present; generated files are suitable for local/dev only.`,
      );
    }
  }
}

mkdirSync(wellKnownDir, { recursive: true });

writeFileSync(
  path.join(wellKnownDir, "apple-app-site-association"),
  appleOutput,
  "utf8",
);
writeFileSync(
  path.join(wellKnownDir, "assetlinks.json"),
  assetlinksOutput,
  "utf8",
);

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
`;
writeFileSync(path.join(distDir, "_headers"), headers, "utf8");

// Tiny landing page so a GET to `/` doesn't 404 in browser sanity checks.
writeFileSync(
  path.join(distDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>snugenv</title><p>NatStack universal-link verification host.</p>`,
  "utf8",
);
