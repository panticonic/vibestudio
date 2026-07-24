import { describe, expect, it } from "vitest";
import { OnboardingHostTopologySnapshotSchema } from "./onboardingStatus.js";

describe("OnboardingHostTopologySnapshotSchema", () => {
  const valid = {
    devices: {
      availability: "available",
      pairedDeviceCount: 1,
      thisDevicePaired: true,
    },
    remote: {
      availability: "available",
      route: "local",
      workspaceCount: 2,
    },
  } as const;

  it("accepts only the bounded redacted projection", () => {
    expect(OnboardingHostTopologySnapshotSchema.parse(valid)).toEqual(valid);
    expect(() =>
      OnboardingHostTopologySnapshotSchema.parse({
        ...valid,
        devices: { ...valid.devices, deviceId: "dev-secret" },
      })
    ).toThrow();
    expect(() =>
      OnboardingHostTopologySnapshotSchema.parse({
        ...valid,
        remote: { ...valid.remote, pairUrl: "https://vibestudio.app/pair#secret" },
      })
    ).toThrow();
  });
});
