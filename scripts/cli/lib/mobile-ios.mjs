// Use one concrete simulator identity throughout build, install, and launch.
export function availableIosSimulators(raw) {
  const inventory = JSON.parse(raw);
  return Object.entries(inventory.devices ?? {})
    .filter(([runtime]) => runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable !== false);
}

export function bootedIosSimulator(raw, deviceId) {
  const booted = availableIosSimulators(raw).filter((device) => device.state === "Booted");
  if (deviceId) {
    if (!booted.some((device) => device.udid === deviceId)) {
      throw new Error(`The selected iOS simulator ${deviceId} is not available and booted.`);
    }
    return deviceId;
  }
  if (booted.length !== 1) {
    throw new Error(
      booted.length === 0
        ? "Boot one iPhone simulator in Xcode before running mobile install --platform ios --simulator."
        : "Multiple iOS simulators are booted. Select one with --device <udid>, or leave only the intended simulator booted."
    );
  }
  if (!booted[0].udid) throw new Error("The booted iOS simulator has no UDID.");
  return booted[0].udid;
}

// The selected platform determines both the SDK and the built-product directory.
// A simulator's explicit UDID is still a simulator, not a physical device.
export function iosBuildTarget({ simulator, device }, simulatorId) {
  return simulator
    ? { sdk: "iphonesimulator", destination: `platform=iOS Simulator,id=${simulatorId}` }
    : { sdk: "iphoneos", destination: device ? `id=${device}` : "generic/platform=iOS" };
}

export function coreDeviceIosPhones(raw) {
  return (JSON.parse(raw).result?.devices ?? [])
    .filter(
      (device) =>
        device.properties?.hardware?.platform === "iOS" &&
        device.properties.hardware.reality === "physical"
    )
    .map((device) => ({
      platform: "ios",
      deviceId: device.properties.hardware.udid,
      name: device.properties.state.name,
      state: device.properties.connection.state,
      kind: "physical",
      ready:
        device.properties.connection.state === "connected" &&
        device.properties.connection.pairingState === "paired",
      installedApps: [],
      compatibleAppInstalled: false,
    }));
}
