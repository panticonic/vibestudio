#!/usr/bin/env node
// `vibestudio` bin for the published server package and for a linked source
// checkout. Pins VIBESTUDIO_APP_ROOT to the package root so every artifact
// lookup has one exact source, then runs the bundled CLI. The CLI never infers
// this identity from the user's shell working directory.
//
// Distribution updates are the package manager's job — apt/dnf/pacman on Linux,
// Homebrew on macOS, `npm install -g @panticonic/vibestudio-server@latest` for a
// host no native package covers — so this launcher only launches.
import { spawn } from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
if (!env["VIBESTUDIO_APP_ROOT"]) env["VIBESTUDIO_APP_ROOT"] = packageRoot;
env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = path.join(packageRoot, "dist");

const cli = path.join(packageRoot, "dist", "cli", "client.mjs");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

const signalHandlers = [];
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  process.on(signal, handler);
  signalHandlers.push([signal, handler]);
}

child.once("error", (error) => {
  console.error(`vibestudio: could not start the CLI: ${error.message}`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
