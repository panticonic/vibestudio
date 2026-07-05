#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "vibestudio remote serve",
    logPrefix: "pair",
    portEnv: ["VIBESTUDIO_PAIR_PORT", "VIBESTUDIO_MOBILE_PORT"],
    devEnv: "VIBESTUDIO_MOBILE_DEV",
    usage: ["vibestudio remote serve", "vibestudio remote serve --dev", "vibestudio remote serve --port 3030"],
    startupHint:
      "[pair] Scan with the Vibestudio mobile app or paste the pairing code in Connection Settings.",
    bannerTitle: "Pair a Vibestudio device",
    deepLinkLabel: "Pair URL",
    instructions: "Scan with the mobile app, or paste the code in Connection Settings.",
  });
} catch (error) {
  console.error(`[pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
