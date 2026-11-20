import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requireInstalledDeploymentPackage } from "./owned-deployment-target.mjs";

test("deployment preflight rejects an installed server whose Iroh binding cannot load", async (t) => {
  const appRoot = await mkdtemp(path.join(tmpdir(), "deployment-package-"));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const cli = path.join(appRoot, "scripts", "cli");
  const binding = path.join(appRoot, "node_modules", "@number0", "iroh");
  await mkdir(cli, { recursive: true });
  await mkdir(binding, { recursive: true });
  await writeFile(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "@panticonic/vibestudio-server" })
  );
  await writeFile(path.join(cli, "remote-serve.mjs"), "");
  await writeFile(path.join(binding, "index.js"), 'require("./missing-native-binding.node");');

  await assert.rejects(
    requireInstalledDeploymentPackage(appRoot),
    /the installed Vibestudio server could not load its Iroh native binding/i
  );
});
