#!/usr/bin/env node
// postinstall for the published @panticonic/vibestudio-server and
// @panticonic/vibestudio packages.
//
// The host's @vibestudio/* packages ship under vendor/ rather than node_modules
// because a partial node_modules in the published tarball perturbs npm's reify
// ordering — it runs dependency postinstall scripts (e.g. electron's binary
// download) against an incomplete dependency tree. By the time this postinstall
// runs, the regular dependency tree is complete, so we copy the vendored
// packages into node_modules/@vibestudio, where the runtime build system resolves
// the @vibestudio API surface (getExistingAppNodeModulesRoots → builder nodePaths).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowsWorkerdMetadata } from "./workerd-windows-metadata.mjs";
import { stageNodeRuntime } from "./node-runtime-artifacts.mjs";

const pkgRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
prepareWindowsWorkerdMetadata({ cwd: pkgRoot });
const src = path.join(pkgRoot, "vendor");
if (!fs.existsSync(src)) process.exit(0); // dev checkout / nothing to vendor

const runtime = await stageNodeRuntime(pkgRoot);
console.log(`[vibestudio] installed verified Node runtime: ${runtime.executable}`);

const dest = path.join(pkgRoot, "node_modules");
fs.mkdirSync(dest, { recursive: true });

let count = 0;
const entries = fs.readdirSync(src).flatMap((entry) => entry.startsWith("@")
  ? fs.readdirSync(path.join(src, entry)).map((name) => path.join(entry, name))
  : [entry]);
for (const entry of entries) {
  const target = path.join(dest, entry);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(src, entry), target, { recursive: true });
  count++;
}
console.log(`[vibestudio] installed ${count} vendored runtime package(s) into node_modules`);
