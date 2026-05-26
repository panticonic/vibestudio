#!/usr/bin/env node
// Compatibility wrapper. The maintained implementation is mobile:pair --dev.

import { runPairServer } from "./pair-server.mjs";

runPairServer(
  {
    logPrefix: "dev-mobile-server",
    hostEnv: ["NATSTACK_DEV_HOST"],
    portEnv: ["NATSTACK_DEV_PORT", "NATSTACK_MOBILE_PORT"],
    restartCommand: "pnpm dev:mobile-server",
    bannerTitle: "NatStack mobile dev server",
    deepLinkLabel: "Deep link",
    instructions:
      "Point the phone camera at the QR code above, tap the notification, and NatStack will save the connection.",
    startupHint:
      "Compatibility alias for `pnpm mobile:pair:dev`; prefer the maintained command in new docs.",
  },
  ["--dev", ...process.argv.slice(2)],
);
