import { describe, expect, it } from "vitest";
import { consumePhoneSetup, phoneSetupStream } from "./phoneSetupStream";
const result = {
  providerId: "desktop",
  platform: "android" as const,
  workspace: "System",
  attachedDeviceId: "serial",
  installStatus: "installed" as const,
  compatibleAppInstalled: true as const,
  pairingStatus: "paired" as const,
  workspaceStatus: "opening" as const,
  pairedDevice: { deviceId: "phone", label: "Phone", createdAt: 1 },
};
describe("phone setup progress", () => {
  it("delivers phases before completion and preserves the incomplete workspace state", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const messages: string[] = [];
    const response = phoneSetupStream(async (emit) => {
      emit({ type: "progress", phase: "installing", message: "Installing" });
      await waiting;
      emit({ type: "paired", result });
    });
    const consumed = consumePhoneSetup(response, (event) => {
      messages.push(event.type);
      if (event.type === "progress") finish();
    });
    expect(await consumed).toMatchObject({ pairingStatus: "paired", workspaceStatus: "opening" });
    expect(messages).toEqual(["progress", "paired"]);
  });
  it("fails on interrupted or failed operations instead of claiming success", async () => {
    await expect(
      consumePhoneSetup(
        phoneSetupStream(async (emit) => {
          emit({ type: "progress", phase: "pairing", message: "Pairing" });
        })
      )
    ).rejects.toThrow("interrupted");
    await expect(
      consumePhoneSetup(
        phoneSetupStream(async () => {
          throw new Error("Install failed");
        })
      )
    ).rejects.toThrow("Install failed");
  });
  it("aborts the operation when the consumer closes", async () => {
    let signal!: AbortSignal;
    const response = phoneSetupStream(async (_emit, operationSignal) => {
      signal = operationSignal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    });
    await response.body!.cancel();
    expect(signal.aborted).toBe(true);
  });
});
