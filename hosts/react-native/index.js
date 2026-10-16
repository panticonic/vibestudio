// Shipped React Native host entry.
//
// This is the mobile host runtime (docs/client-hosts-and-clients-plan.md 4.1,
// 5.3). It is not a product UI: it owns the device (credential, the one
// physical connection per reach, pairing, push, the verified artifact cache)
// and runs each client in its own React Native instance. The runtime starts
// here, when the process loads this bundle, before any activity or scene and
// whichever client the OS is about to show. The component registered below is
// only the host's own screen: pairing, the launch review and messages.

// Must precede any @vibestudio/rpc import: installs a TextDecoder polyfill that
// Hermes lacks (the Iroh control-frame codec needs it).
import "@vibestudio/mobile-iroh/polyfills";
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { AppRegistry } from "react-native";
import { name as appName } from "./app.json";
import { version as hostVersion } from "./package.json";
import { installSubtleDigest } from "./src/host/sha256";
import { startMobileHost } from "./src/host/nativeBindings";
import { createHostScreen } from "./src/HostScreen";

// The launch pipeline verifies artifacts with `crypto.subtle.digest`.
installSubtleDigest();

function smokePhase(phase) {
  console.log(`[VibestudioMobileSmoke] phase=${phase}`);
}

const runtime = startMobileHost({ hostVersion, smokePhase });
runtime.start().catch((error) => {
  console.error(
    `[VibestudioMobileHost] the host runtime failed to start: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`
  );
  throw error;
});

AppRegistry.registerComponent(appName, () => createHostScreen(runtime));
