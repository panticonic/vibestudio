#!/usr/bin/env node
// `vibestudio-server` bin for the npm-published packages. Pins VIBESTUDIO_APP_ROOT
// to the installed package root so every artifact lookup has one exact source,
// then runs the bundled headless server. The server itself never infers this
// identity from the user's shell working directory.
import { spawn } from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
if (!env["VIBESTUDIO_APP_ROOT"]) env["VIBESTUDIO_APP_ROOT"] = packageRoot;

const server = path.join(packageRoot, "dist", "server.mjs");
const child = spawn(process.execPath, [server, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

const signalHandlers = [];
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  signalHandlers.push([signal, handler]);
  process.on(signal, handler);
}
child.on("exit", (code, signal) => {
  for (const [forwardedSignal, handler] of signalHandlers) {
    process.off(forwardedSignal, handler);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
