#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function iosMarketingVersion(version) {
  if (!semver.valid(version)) throw new Error(`Invalid application SemVer: ${version}`);
  return `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}`;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = iosMarketingVersion(pkg.version);
  const output = path.join(root, "apps/mobile/ios/Vibestudio.Version.xcconfig");
  const content =
    "// Generated from package.json by scripts/generate-mobile-version.mjs.\n" +
    `MARKETING_VERSION = ${version}\n`;
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== content) {
      throw new Error("iOS application version is stale; run pnpm generate:mobile-version");
    }
    console.log(`iOS application version matches ${pkg.version}.`);
  } else {
    fs.writeFileSync(output, content);
    console.log(`Generated iOS application version ${version}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
