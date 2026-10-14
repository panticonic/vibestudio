#!/usr/bin/env node
// Run npm with the same credential as every local Vibestudio release script.
import { spawnSync } from "node:child_process";
import { createNpmAuth } from "./lib/npm-auth.mjs";
import { runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";
import { spawnResultFailure } from "./lib/spawn-result-failure.mjs";

let auth;
try {
  await runWithOwnedCleanup(
    () => {
      auth = createNpmAuth({ required: true });
      if (!process.argv[2])
        throw new Error("Usage: pnpm npm:authenticated <npm command> [arguments]");
      const result = spawnSync("npm", process.argv.slice(2), {
        env: auth.environment(),
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
      });
      if (result.stdout) process.stdout.write(auth.redact(result.stdout));
      if (result.stderr) process.stderr.write(auth.redact(result.stderr));
      const failure = spawnResultFailure(result, "npm command");
      if (failure) throw failure;
    },
    () => auth?.close(),
    "npm command and authentication cleanup failed"
  );
} catch (error) {
  console.error(auth ? auth.redact(error.message) : error.message);
  process.exitCode = 1;
}
