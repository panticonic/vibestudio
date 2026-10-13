import { describe, expect, it, vi } from "vitest";
import { HostTargetStaging } from "./hostTargetStaging.js";

describe("HostTargetStaging", () => {
  it("stages a pre-demanded target once for concurrent callers", async () => {
    const demanded = new Set(["react-native"]);
    let finish!: () => void;
    const stage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const staging = new HostTargetStaging(demanded, stage);

    const first = staging.ensure("react-native");
    const second = staging.ensure("react-native");
    await Promise.resolve();

    expect(demanded.has("react-native")).toBe(true);
    expect(stage).toHaveBeenCalledOnce();
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await staging.ensure("react-native");
    expect(stage).toHaveBeenCalledOnce();
  });

  it("propagates staging failure and clears the demand for a later attempt", async () => {
    const demanded = new Set<"react-native">();
    const failure = new Error("declaration reconciliation failed");
    const stage = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const staging = new HostTargetStaging(demanded, stage);

    await expect(staging.ensure("react-native")).rejects.toBe(failure);
    expect(demanded.has("react-native")).toBe(false);
    await expect(staging.ensure("react-native")).resolves.toBeUndefined();
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it("preserves an initial demand when staging fails", async () => {
    const demanded = new Set(["react-native"]);
    const failure = new Error("declaration reconciliation failed");
    const staging = new HostTargetStaging(demanded, () => Promise.reject(failure));

    await expect(staging.ensure("react-native")).rejects.toBe(failure);
    expect(demanded.has("react-native")).toBe(true);
  });
});
