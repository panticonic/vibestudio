#!/usr/bin/env node
// Start a dev server bound to the LAN so a phone on the same Wi-Fi can reach
// it, then print a `natstack://connect?url=…&code=…` deep link as a QR code
// that the mobile client picks up via its URL-scheme intent filter.
//
// Usage:
//   pnpm dev:mobile-server
//   NATSTACK_DEV_HOST=<ip> pnpm dev:mobile-server    # override auto-detected IP
//   NATSTACK_DEV_HOST=tailscale pnpm dev:mobile-server  # prefer tailscale IP

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickMobileHost, printConnectBanner } from "./mobile-connect-utils.mjs";

function main() {
  const host = pickMobileHost(process.env.NATSTACK_DEV_HOST, { defaultPreference: "lan" });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  console.log(`[dev-mobile-server] Binding server to ${host.address}`);
  console.log("[dev-mobile-server] Override with NATSTACK_DEV_HOST=<ip|tailscale>\n");

  const child = spawn(
    process.execPath,
    ["dist/server.mjs", "--host", host.address, "--serve-panels", "--init", "--ephemeral", "--print-credentials"],
    {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, NODE_ENV: "development", NATSTACK_HOST: host.address },
    },
  );

  let gatewayUrl = null;
  let pairingCode = null;
  let bannerPrinted = false;
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      const gMatch = line.match(/Gateway:\s+(\S+)/);
      if (gMatch) gatewayUrl = gMatch[1];
      const pMatch = line.match(/(?:NATSTACK_PAIRING_CODE=|Pairing code:\s+)([A-Za-z0-9_-]+)/);
      if (pMatch) pairingCode = pMatch[1];

      if (!bannerPrinted && gatewayUrl && pairingCode) {
        bannerPrinted = true;
        printConnectBanner({
          title: "NatStack mobile dev server",
          gatewayUrl,
          pairingCode,
          instructions: "Point the Pixel camera at the QR code above, tap the notification, and the app will auto-connect.",
        });
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  const forward = (sig) => {
    process.on(sig, () => {
      child.kill(sig);
    });
  };
  forward("SIGINT");
  forward("SIGTERM");
}

main();
