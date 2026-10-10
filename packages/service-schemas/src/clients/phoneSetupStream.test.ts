import { describe, expect, it } from "vitest";
import { RpcBoundaryError } from "@vibestudio/rpc";
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
  it("preserves aggregate failures, causes, and codes for the waiting caller", async () => {
    const root = new RpcBoundaryError(
      "device owner disconnected",
      "transport",
      "ENOTCONN"
    );
    const cleanup = new RpcBoundaryError("pairing cleanup failed", "application", "EIO");
    const failure = new AggregateError([root, cleanup], "Phone setup failed", { cause: root });
    const response = phoneSetupStream(async () => {
      throw failure;
    });

    const remote = await consumePhoneSetup(response).catch((error: unknown) => error);
    expect(remote).toBeInstanceOf(AggregateError);
    const aggregate = remote as AggregateError;
    expect(aggregate.message).toBe(failure.message);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: root.message, code: "ENOTCONN" });
    expect(aggregate.errors[1]).toMatchObject({ message: cleanup.message, code: "EIO" });
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
  it("preserves retirement failures for a cancelling consumer", async () => {
    const failure = new Error("Native descendants could not retire");
    const response = phoneSetupStream(async (_emit, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw failure;
    });
    await expect(response.body!.cancel()).rejects.toBe(failure);
  });
});
