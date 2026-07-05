#!/usr/bin/env node
// postinstall for the published @vibestudio/server and @vibestudio/app packages.
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

const pkgRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(pkgRoot, "vendor", "@vibestudio");
if (!fs.existsSync(src)) process.exit(0); // dev checkout / nothing to vendor

const dest = path.join(pkgRoot, "node_modules", "@vibestudio");
fs.mkdirSync(dest, { recursive: true });

let count = 0;
for (const entry of fs.readdirSync(src)) {
  const target = path.join(dest, entry);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(src, entry), target, { recursive: true });
  count++;
}
console.log(`[vibestudio] installed ${count} vendored @vibestudio package(s) into node_modules`);
