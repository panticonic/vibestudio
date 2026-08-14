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

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import developmentBaseConfig from "../src/dev/developmentBaseConfig.cjs";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function collectUserlandDependencyFindings(appRoot, userlandRoot) {
  const { discoverPackageGraph } = await import("../src/server/buildV2/packageGraph.js");
  const { auditWorkspaceDependencies } = await import("../src/server/buildV2/dependencyAudit.js");

  const workspaceRoot = path.resolve(userlandRoot);
  // The same roots a real build resolves `workspace:*` through. Omitting them
  // hides every peer that arrives via a host package — which is most of what
  // an app's closure is made of.
  const appNodeModules = [path.join(path.resolve(appRoot), "node_modules")];
  return auditWorkspaceDependencies(discoverPackageGraph(workspaceRoot), workspaceRoot, appNodeModules);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const userlandRoot = developmentBaseConfig.requireDevelopmentBaseCheckout(defaultAppRoot);
  const findings = await collectUserlandDependencyFindings(defaultAppRoot, userlandRoot);
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
    process.exit(1);
  }
  console.log("Userland dependency ownership OK.");
}
