#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  await runPairServer({
    commandName: "vibestudio mobile pair",
    logPrefix: "mobile-pair",
    portEnv: ["VIBESTUDIO_MOBILE_PORT"],
    devEnv: "VIBESTUDIO_MOBILE_DEV",
    usage: [
      "vibestudio mobile pair",
      "vibestudio mobile pair --dev",
      "vibestudio mobile pair --port 3030",
    ],
    startupHint: "[mobile-pair] Install Vibestudio on your phone before pairing.",
    bannerTitle: "Vibestudio mobile pairing",
    instructions:
      "Scan the QR code in Vibestudio or open the pairing link on your phone. Vibestudio will confirm and save the connection.",
  });
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
