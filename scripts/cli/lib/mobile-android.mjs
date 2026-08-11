const supportedAndroidAbis = new Set(["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]);

function parseAdbDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 2);
      return { serial, state, line };
    });
}

export function resolveAdbInstallTarget(stdout, requestedDevice) {
  const devices = parseAdbDevices(stdout);
  if (requestedDevice) {
    const match = devices.find((entry) => entry.serial === requestedDevice);
    if (!match) {
      throw new Error(
        `adb does not see device "${requestedDevice}".\n\n${stdout.trim() || "No adb output"}`
      );
    }
    if (match.state !== "device") {
      throw new Error(
        `adb sees "${requestedDevice}" but it is "${match.state}". Unlock the phone and accept the USB debugging prompt.`
      );
    }
    return match.serial;
  }

  const ready = devices.filter((entry) => entry.state === "device");
  if (ready.length === 1) return ready[0].serial;

  if (ready.length > 1) {
    throw new Error(
      "adb sees multiple install targets. Re-run with --device <serial>.\n\n" + stdout.trim()
    );
  }

  if (devices.length > 0) {
    throw new Error(
      "adb sees a device, but it is not ready. Unlock the phone and accept the USB debugging prompt.\n\n" +
        stdout.trim()
    );
  }

  throw new Error(
    "adb does not see any Android device or emulator.\n\n" +
      "Check that the phone is plugged in, Developer options are enabled, USB debugging is on, " +
      "the phone is unlocked, and the USB debugging authorization prompt has been accepted."
  );
}

export function parseAndroidDeviceAbi(stdout) {
  const abi = stdout.trim();
  if (!supportedAndroidAbis.has(abi)) {
    throw new Error(
      `Android device reported unsupported primary ABI "${abi || "(empty)"}"; expected one of ${[
        ...supportedAndroidAbis,
      ].join(", ")}`
    );
  }
  return abi;
}
