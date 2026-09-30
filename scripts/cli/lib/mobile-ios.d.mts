export function bootedIosSimulator(raw: string, deviceId?: string | null): string;
export function iosBuildTarget(
  options: { simulator?: boolean; device?: string | null },
  simulatorId?: string | null
): { sdk: "iphoneos" | "iphonesimulator"; destination: string };
