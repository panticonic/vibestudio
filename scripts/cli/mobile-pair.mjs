#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "vibestudio mobile pair",
    logPrefix: "mobile-pair",
    hostEnv: ["VIBESTUDIO_MOBILE_HOST", "VIBESTUDIO_DEV_HOST"],
    portEnv: ["VIBESTUDIO_MOBILE_PORT"],
    devEnv: "VIBESTUDIO_MOBILE_DEV",
    restartCommand: "vibestudio mobile pair",
    usage: [
      "vibestudio mobile pair",
      "vibestudio mobile pair --dev",
      "vibestudio mobile pair --port 3030",
    ],
    startupHint:
      "[mobile-pair] Install the internal APK with: vibestudio mobile install --launch",
    bannerTitle: "Vibestudio Android pairing",
    instructions:
      "Open the QR code with the Android camera. Vibestudio will confirm and save the connection.",
  });
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
