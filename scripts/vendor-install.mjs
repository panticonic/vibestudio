#!/usr/bin/env node
// postinstall for the published @vibez1/server and @vibez1/app packages.
//
// The host's @vibez1/* packages ship under vendor/ rather than node_modules
// because a partial node_modules in the published tarball perturbs npm's reify
// ordering — it runs dependency postinstall scripts (e.g. electron's binary
// download) against an incomplete dependency tree. By the time this postinstall
// runs, the regular dependency tree is complete, so we copy the vendored
// packages into node_modules/@vibez1, where the runtime build system resolves
// the @vibez1 API surface (getExistingAppNodeModulesRoots → builder nodePaths).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(pkgRoot, "vendor", "@vibez1");
if (!fs.existsSync(src)) process.exit(0); // dev checkout / nothing to vendor

const dest = path.join(pkgRoot, "node_modules", "@vibez1");
fs.mkdirSync(dest, { recursive: true });

let count = 0;
for (const entry of fs.readdirSync(src)) {
  const target = path.join(dest, entry);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(src, entry), target, { recursive: true });
  count++;
}
console.log(`[vibez1] installed ${count} vendored @vibez1 package(s) into node_modules`);
