import * as path from "node:path";
import { retireOnAbort } from "./owned-entry.mjs";

/**
 * Mint one device invite from a running instance through its own CLI.
 * The CLI child belongs to the caller's `ownership` and is retired if `signal` aborts.
 */
export async function mintDevicePairingLink(repoRoot, instanceId, ttlMs, ownership, signal) {
  const owned = ownership.spawn(
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
      kill: "immediate",
      label: "pair-device",
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const { child } = owned;
  if (signal) retireOnAbort(ownership, signal, owned);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await owned.join();
  if (code !== 0) {
    throw new Error(`Could not mint a device invite for ${instanceId}: ${stderr || stdout}`);
  }
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const deepLink = JSON.parse(line)?.pairing?.deepLink;
    if (typeof deepLink !== "string") throw new Error("no deep link in the invite");
    return deepLink;
  } catch (error) {
    throw new Error(`Device invite was not readable: ${error.message}: ${line.slice(0, 200)}`);
  }
}
