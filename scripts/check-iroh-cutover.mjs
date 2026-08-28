#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOTS = ["src", "packages", "apps", "extensions", "skills", "scripts", "tests", "docs"];
const TOP_LEVEL = ["README.md", "HOST_BUILD_SYSTEM.md", "package.json", "tsconfig.json"];
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);
const IGNORED = new Set(["node_modules", "dist", "release", ".git"]);
const EXCLUDED_FILES = new Set([
  "scripts/check-iroh-cutover.mjs",
  "docs/iroh-remote-transport-plan.md",
  "docs/measurements/mobile-physical-baseline-2026-08-10.md",
  "apps/mobile/android/gradle/verification-metadata.xml",
  "packages/typecheck/src/lib/typescript-libs.ts",
]);

const retired = [
  ["web", "rtc"].join(""),
  ["node", "-", "datachannel"].join(""),
  ["react", "-", "native", "-", "webrtc"].join(""),
  ["mobile", "-", "webrtc"].join(""),
  ["apps", "/", "signaling"].join(""),
  ["VIBESTUDIO", "_", "WEBRTC"].join(""),
  ["VIBESTUDIO", "_", "ROUTED", "_", "ROOM"].join(""),
  ["webrtc", ":"].join(""),
];

const forbiddenPaths = [
  ["apps", "signaling"],
  ["packages", "mobile-webrtc"],
  ["src", "node", "webrtc"],
  ["src", "cli", "webrtcClient.ts"],
  ["src", "main", "webrtcServerClient.ts"],
  ["src", "server", "webrtcIngress.ts"],
  ["src", "server", "webrtcSessionShim.ts"],
];

function filesUnder(root, relative, output) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) filesUnder(root, child, output);
    else if (EXTENSIONS.has(path.extname(entry.name))) output.push(child.split(path.sep).join("/"));
  }
}

export function inspectIrohCutover(root = process.cwd()) {
  const failures = [];
  for (const coordinates of forbiddenPaths) {
    const relative = coordinates.join("/");
    if (fs.existsSync(path.join(root, ...coordinates)))
      failures.push(`${relative}: retired path exists`);
  }
  const files = [...TOP_LEVEL];
  for (const relative of ROOTS) filesUnder(root, relative, files);
  for (const relative of files) {
    if (EXCLUDED_FILES.has(relative)) continue;
    const filename = path.join(root, relative);
    if (!fs.existsSync(filename)) continue;
    const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      for (const term of retired) {
        if (lower.includes(term.toLowerCase())) failures.push(`${relative}:${index + 1}: ${term}`);
      }
    }
  }
  return [...new Set(failures)].sort();
}

export function assertIrohCutover(root = process.cwd()) {
  const failures = inspectIrohCutover(root);
  if (failures.length > 0)
    throw new Error(
      `Retired remote transport survived:\n${failures.map((item) => `- ${item}`).join("\n")}`
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertIrohCutover();
    const userlandRoot = process.env.VIBESTUDIO_USERLAND_ROOT;
    if (userlandRoot && path.resolve(userlandRoot) !== process.cwd()) {
      assertIrohCutover(path.resolve(userlandRoot));
    }
    console.log("[iroh-cutover] retired transport is absent from host and selected userland");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
