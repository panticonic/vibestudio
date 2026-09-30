// Use one concrete simulator identity throughout build, install, and launch.
export function bootedIosSimulator(raw, deviceId) {
  const inventory = JSON.parse(raw);
  const booted = Object.entries(inventory.devices ?? {})
    .filter(([runtime]) => runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable !== false && device.state === "Booted");
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
