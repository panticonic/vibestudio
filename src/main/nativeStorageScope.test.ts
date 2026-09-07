import { describe, expect, it } from "vitest";
import { nativeStorageScope, scopedNativePartition } from "./nativeStorageScope";
describe("native storage ownership", () => {
  it("isolates identical server-supplied environment IDs across authenticated hosts and devices", () => {
    const first = nativeStorageScope("iroh", "public-key-a", "device-1");
    const second = nativeStorageScope("iroh", "public-key-b", "device-1");
    const otherUser = nativeStorageScope("iroh", "public-key-a", "device-2");
    expect(new Set([first, second, otherUser]).size).toBe(3);
    expect(scopedNativePartition(first, "persist:browser:shared")).not.toBe(
      scopedNativePartition(second, "persist:browser:shared")
    );
    expect(scopedNativePartition(first, "persist:browser:shared")).not.toBe(
      scopedNativePartition(otherUser, "persist:browser:shared")
    );
    expect(nativeStorageScope("iroh", "public-key-a", "device-1")).toBe(first);
  });
  it("retains separate workspace contexts inside an authenticated host profile", () => {
    const scope = nativeStorageScope("local", "hub", "device");
    expect(scopedNativePartition(scope, "persist:panel:workspace-a:main")).not.toBe(
      scopedNativePartition(scope, "persist:panel:workspace-b:main")
    );
    expect(() => scopedNativePartition("", "persist:context")).toThrow(/authenticated scope/);
  });
});
