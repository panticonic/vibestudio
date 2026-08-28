#!/usr/bin/env node

/**
 * Answer the dependency-ownership question for every userland unit without
 * building any of them.
 *
 * Build V2 already refuses a unit whose closure asks for something nobody
 * owns, but only when that unit is built — for an app, that can mean the
 * refusal first appears on a device, minutes and one RPC hop away from the
 * manifest that caused it. The graph knows the answer at commit time, so ask
 * it there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import developmentBaseConfig from "../src/dev/developmentBaseConfig.cjs";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const RUNTIME_DEPENDENCY_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];

// Exact pins are exceptional because they prevent a workspace from reusing a
// compatible dependency already shipped with the app. Add a narrowly scoped
// `relative/package.json:section:package` entry here only with a concrete
// interoperability or integrity reason.
const EXACT_PIN_EXCEPTIONS = new Map([
  [
    "packages/pi-ai/package.json:dependencies:@earendil-works/pi-ai",
    "the package applies a source patch to exactly 0.82.0",
  ],
  ...[
    "@notifee/react-native",
    "@react-native-community/netinfo",
    "@react-native-async-storage/async-storage",
    "@react-native-clipboard/clipboard",
    "@react-native-firebase/app",
    "@react-native-firebase/messaging",
    "react",
    "react-native",
    "react-native-gesture-handler",
    "react-native-get-random-values",
    "react-native-haptic-feedback",
    "react-native-keychain",
    "react-native-reanimated",
    "react-native-safe-area-context",
    "react-native-screens",
    "react-native-svg",
    "react-native-tcp-socket",
    "react-native-webrtc",
    "react-native-webview",
  ].map((name) => [
    `apps/mobile/package.json:dependencies:${name}`,
    "must match the React Native runtime or native module compiled into the APK",
  ]),
]);

export function collectExactUserlandDependencyPins(userlandRoot) {
  const root = path.resolve(userlandRoot);
  const findings = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
      const relative = path.relative(root, target).split(path.sep).join("/");
      for (const section of DEPENDENCY_SECTIONS) {
        const dependencies = manifest[section];
        if (!dependencies || typeof dependencies !== "object") continue;
        for (const [name, specifier] of Object.entries(dependencies)) {
          if (typeof specifier !== "string" || !EXACT_SEMVER.test(specifier)) continue;
          const key = `${relative}:${section}:${name}`;
          if (EXACT_PIN_EXCEPTIONS.has(key)) continue;
          findings.push({ relative, section, name, specifier });
        }
      }
    }
  };
  visit(root);
  return findings;
}

function packageNameFromPatchSelector(selector) {
  const separator = selector.lastIndexOf("@");
  return separator > 0 ? selector.slice(0, separator) : selector;
}

/**
 * Find shared runtime ranges for which the Host's published dependency range
 * is broader than Base accepts. A merely overlapping range is not sufficient:
 * a fresh npm install may legally choose the lower Host version and make reuse
 * depend on install date. The Host range must be a subset of every Base range.
 *
 * Patched dependencies are excluded because their bytes deliberately require
 * Base's isolated content-addressed environment; they are never reuse candidates.
 */
export function collectHostReuseRangeFindings(appRoot, userlandRoot) {
  const hostRoot = path.resolve(appRoot);
  const root = path.resolve(userlandRoot);
  const hostManifest = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));
  const hostDependencies = hostManifest.dependencies ?? {};
  const declarations = [];
  const patchedNames = new Set();

  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
      const relative = path.relative(root, target).split(path.sep).join("/");
      const patches = manifest.vibestudio?.dependencyResolution?.patches;
      if (patches && typeof patches === "object") {
        for (const selector of Object.keys(patches)) {
          patchedNames.add(packageNameFromPatchSelector(selector));
        }
      }
      for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
        for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
          if (typeof specifier !== "string" || specifier.startsWith("workspace:")) continue;
          declarations.push({ relative, section, name, specifier });
        }
      }
    }
  };
  visit(root);

  const findings = [];
  for (const declaration of declarations) {
    const hostSpecifier = hostDependencies[declaration.name];
    if (
      typeof hostSpecifier !== "string" ||
      patchedNames.has(declaration.name) ||
      !semver.validRange(hostSpecifier) ||
      !semver.validRange(declaration.specifier) ||
      semver.subset(hostSpecifier, declaration.specifier, { includePrerelease: true })
    ) {
      continue;
    }
    findings.push({ ...declaration, hostSpecifier });
  }
  return findings;
}

export async function collectUserlandDependencyFindings(appRoot, userlandRoot) {
  const { discoverPackageGraph } = await import("../src/server/buildV2/packageGraph.js");
  const { auditWorkspaceDependencies } = await import("../src/server/buildV2/dependencyAudit.js");

  const workspaceRoot = path.resolve(userlandRoot);
  // The same roots a real build resolves `workspace:*` through. Omitting them
  // hides every peer that arrives via a host package — which is most of what
  // an app's closure is made of.
  const appNodeModules = [path.join(path.resolve(appRoot), "node_modules")];
  return auditWorkspaceDependencies(
    discoverPackageGraph(workspaceRoot),
    workspaceRoot,
    appNodeModules
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const userlandRoot = developmentBaseConfig.requireDevelopmentBaseCheckout(defaultAppRoot);
  const findings = await collectUserlandDependencyFindings(defaultAppRoot, userlandRoot);
  const exactPins = collectExactUserlandDependencyPins(userlandRoot);
  const reuseRanges = collectHostReuseRangeFindings(defaultAppRoot, userlandRoot);
  if (findings.length > 0 || exactPins.length > 0 || reuseRanges.length > 0) {
    if (exactPins.length > 0) {
      console.error(`Userland has ${exactPins.length} undocumented exact dependency pin(s):\n`);
      for (const finding of exactPins) {
        console.error(
          `  ${finding.relative} ${finding.section}.${finding.name} = ${finding.specifier}`
        );
      }
      console.error(
        "\nUse a compatible semver range unless exact identity is demonstrably required.\n"
      );
    }
    if (reuseRanges.length > 0) {
      console.error(
        `Userland has ${reuseRanges.length} runtime declaration(s) that a fresh Host install cannot reliably reuse:\n`
      );
      for (const finding of reuseRanges) {
        console.error(
          `  ${finding.relative} ${finding.section}.${finding.name} = ${finding.specifier}; ` +
            `Host publishes ${finding.hostSpecifier}`
        );
      }
      console.error(
        "\nNarrow the Host range so every version it may install is accepted by Base.\n"
      );
    }
  }
  if (findings.length > 0) {
    console.error(`Userland dependency ownership is unsatisfied in ${findings.length} unit(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.unitPath}`);
      console.error(`    ${finding.message}\n`);
    }
    console.error(
      "Each unit either owns what its closure resolves or declares it as a peer for the\n" +
        "realm that loads it. See skills/workspace-dev/DEPENDENCIES.md in the Base checkout."
    );
  }
  if (findings.length > 0 || exactPins.length > 0 || reuseRanges.length > 0) process.exit(1);
  console.log("Userland dependency ownership and Host reuse ranges OK.");
}
