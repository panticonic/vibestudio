export function bootedIosSimulator(raw: string, deviceId?: string | null): string;
export function iosBuildTarget(
  options: { simulator?: boolean; device?: string | null },
  simulatorId?: string | null
): { sdk: "iphoneos" | "iphonesimulator"; destination: string };
export function availableIosSimulators(raw: string): Array<{
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}>;
export function coreDeviceIosPhones(raw: string): Array<{
  platform: "ios";
  deviceId: string;
  name: string;
  state: string;
  kind: "physical";
  ready: boolean;
  installedApps: never[];
  compatibleAppInstalled: boolean;
}>;
export function coreDeviceIosApps(
  raw: string,
  bundleId: string
): Array<{
  packageId: string;
  versionName?: string;
}>;
