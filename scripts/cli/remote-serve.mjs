#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "vibez1 remote serve",
    logPrefix: "pair",
    portEnv: ["VIBEZ1_PAIR_PORT", "VIBEZ1_MOBILE_PORT"],
    devEnv: "VIBEZ1_MOBILE_DEV",
    usage: ["vibez1 remote serve", "vibez1 remote serve --dev", "vibez1 remote serve --port 3030"],
    startupHint:
      "[pair] Scan with the Vibez1 mobile app or paste the pairing code in Connection Settings.",
    bannerTitle: "Pair a Vibez1 device",
    deepLinkLabel: "Pair URL",
    instructions: "Scan with the mobile app, or paste the code in Connection Settings.",
  });
} catch (error) {
  console.error(`[pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
