import { describe, expect, it, vi } from "vitest";
import { requestDeviceMediaAccess } from "./deviceMediaAccess.js";

describe("native device media consent", () => {
  it("requests undecided OS permissions in sequence and stops on denial", async () => {
    const preferences = {
      getMediaAccessStatus: vi.fn(() => "not-determined"),
      askForMediaAccess: vi.fn(async (kind: string) => kind === "camera"),
    };
    await expect(
      requestDeviceMediaAccess(["camera", "microphone"], "darwin", preferences as never)
    ).resolves.toBe(false);
    expect(preferences.askForMediaAccess.mock.calls).toEqual([["camera"], ["microphone"]]);
  });
  it("does not reprompt a denied device or consult OS permissions elsewhere", async () => {
    const preferences = { getMediaAccessStatus: vi.fn(() => "denied"), askForMediaAccess: vi.fn() };
    await expect(
      requestDeviceMediaAccess(["camera"], "darwin", preferences as never)
    ).resolves.toBe(false);
    expect(preferences.askForMediaAccess).not.toHaveBeenCalled();
    preferences.getMediaAccessStatus.mockClear();
    await expect(requestDeviceMediaAccess(["camera"], "linux", preferences as never)).resolves.toBe(
      true
    );
    expect(preferences.getMediaAccessStatus).not.toHaveBeenCalled();
  });
  it("leaves screen choice and consent to the system capture APIs", async () => {
    const preferences = { getMediaAccessStatus: vi.fn(), askForMediaAccess: vi.fn() };
    await expect(
      requestDeviceMediaAccess(["screen-capture"], "darwin", preferences as never)
    ).resolves.toBe(true);
    expect(preferences.askForMediaAccess).not.toHaveBeenCalled();
  });
});
