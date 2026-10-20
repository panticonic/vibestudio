#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagValue } from "./lib/args.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultOutput = path.join(repoRoot, "hosts", "ios", "Generated", "Vibestudio.entitlements");

function parseArgs(argv) {
  const options = {
    output: process.env.VIBESTUDIO_IOS_ENTITLEMENTS ?? defaultOutput,
    configuration: process.env.CONFIGURATION ?? "Debug",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") {
      options.output = path.resolve(flagValue(argv, ++i, arg));
    } else if (arg === "--configuration") {
      options.configuration = flagValue(argv, ++i, arg);
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function help() {
  console.log(`vibestudio iOS entitlements generator

Usage:
  node scripts/cli/ios-entitlements.mjs [--output <path>] [--configuration Debug|Release]

Environment:
  VIBESTUDIO_IOS_APS_ENV=development|production      Add APNs entitlement.
  VIBESTUDIO_IOS_PAIR_HOST=vibestudio.app             Add applinks/webcredentials domains.
  VIBESTUDIO_IOS_ASSOCIATED_DOMAINS=domain[,domain]   Add exact associated-domain entries.
  VIBESTUDIO_IOS_APP_GROUP=1                          Add the App Group shared with the widget and share extension.
`);
}

function plistString(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderEntitlements({ configuration }) {
  const debug = configuration.toLowerCase() !== "release";
  const domains = associatedDomains({ debug });
  const apsEnvironment = process.env.VIBESTUDIO_IOS_APS_ENV;
  if (apsEnvironment && apsEnvironment !== "development" && apsEnvironment !== "production") {
    throw new Error("VIBESTUDIO_IOS_APS_ENV must be development or production");
  }
  const apsBlock = apsEnvironment
    ? `\n\t<key>aps-environment</key>\n\t<string>${plistString(apsEnvironment)}</string>`
    : "";
  const domainBlock = domains.length
    ? `\n\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n${domains.map((domain) => `\t\t<string>${plistString(domain)}</string>`).join("\n")}\n\t</array>`
    : "";
  // Opt-in, like the other gated capabilities (it needs the App Groups
  // capability registered for the identifier). The app shares one App Group
  // with its widget and share extension (launch snapshot, shared-content inbox). Xcode expands the build setting, so a
  // locally overridden bundle id keeps app and extensions on the same group.
  const appGroupBlock = process.env.VIBESTUDIO_IOS_APP_GROUP
    ? "\n\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>group.$(VIBESTUDIO_IOS_BUNDLE_ID)</string>\n\t</array>"
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${domainBlock}${apsBlock}${appGroupBlock}
</dict>
</plist>
`;
}

function associatedDomains({ debug }) {
  const explicit = process.env.VIBESTUDIO_IOS_ASSOCIATED_DOMAINS;
  if (explicit && explicit.trim()) {
    return explicit
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (debug && entry.startsWith("applinks:") ? `${entry}?mode=developer` : entry));
  }
  const pairHost = process.env.VIBESTUDIO_IOS_PAIR_HOST?.trim();
  if (!pairHost) return [];
  return [`applinks:${pairHost}${debug ? "?mode=developer" : ""}`, `webcredentials:${pairHost}`];
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  help();
  process.exit(0);
}

await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, renderEntitlements(options), "utf8");
console.log(`[ios-entitlements] wrote ${path.relative(repoRoot, options.output)}`);
