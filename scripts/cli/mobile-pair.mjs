#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "vibez1 mobile pair",
    logPrefix: "mobile-pair",
    hostEnv: ["VIBEZ1_MOBILE_HOST", "VIBEZ1_DEV_HOST"],
    portEnv: ["VIBEZ1_MOBILE_PORT"],
    devEnv: "VIBEZ1_MOBILE_DEV",
    restartCommand: "vibez1 mobile pair",
    usage: [
      "vibez1 mobile pair",
      "vibez1 mobile pair --dev",
      "vibez1 mobile pair --port 3030",
    ],
    startupHint:
      "[mobile-pair] Install the internal APK with: vibez1 mobile install --launch",
    bannerTitle: "Vibez1 Android pairing",
    instructions:
      "Open the QR code with the Android camera. Vibez1 will confirm and save the connection.",
  });
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
