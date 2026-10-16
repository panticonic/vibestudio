import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * Mint one device invite from a running instance through its own CLI.
 * `acquire` registers the child with the caller's owned process lifetime.
 */
export function mintDevicePairingLink(repoRoot, instanceId, ttlMs, acquire) {
  return new Promise((resolve, reject) => {
    const child = acquire(() =>
      spawn(
        process.execPath,
        [
          path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          "src/dev/runCli.ts",
          "--instance",
          instanceId,
          "remote",
          "pair-device",
          "--ttl-ms",
          String(ttlMs),
          "--json",
        ],
        {
          cwd: repoRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        }
      )
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Could not mint a device invite for ${instanceId}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        const deepLink = JSON.parse(line)?.pairing?.deepLink;
        if (typeof deepLink !== "string") throw new Error("no deep link in the invite");
        resolve(deepLink);
      } catch (error) {
        reject(new Error(`Device invite was not readable: ${error.message}: ${line.slice(0, 200)}`));
      }
    });
  });
}
