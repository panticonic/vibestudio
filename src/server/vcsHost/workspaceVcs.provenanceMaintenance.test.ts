/**
 * Focused tests for the scheduler-facing provenance maintenance seam
 * (C6/C10): `pruneProvenanceSoftState` wires the hourly scheduler against the
 * DO's `pruneProvenanceSoftState` @rpc, which lands in a LATER wave. Until it
 * does, a "method not found" from the DO is tolerated so the scheduler stays
 * green, while any genuine failure still surfaces. Driven directly against a
 * stub gad caller.
 */

import { describe, expect, it, vi } from "vitest";
import { WorkspaceVcs } from "./workspaceVcs.js";

function fakeThis(
  call: (method: string, input: unknown) => Promise<unknown>,
  attached = true
): object {
  const gad = { call };
  return { attached, gad: () => gad };
}

describe("WorkspaceVcs.pruneProvenanceSoftState", () => {
  it("calls the DO's pruneProvenanceSoftState @rpc", async () => {
    const call = vi.fn(async () => ({}));
    await WorkspaceVcs.prototype.pruneProvenanceSoftState.call(fakeThis(call));
    expect(call).toHaveBeenCalledWith("pruneProvenanceSoftState", {});
  });

  it("tolerates the DO method not having landed yet (404 / Unknown method)", async () => {
    const call = vi.fn(async () => {
      throw new Error(
        'DO dispatch failed (404): {"error":"Unknown method: pruneProvenanceSoftState"}'
      );
    });
    await expect(
      WorkspaceVcs.prototype.pruneProvenanceSoftState.call(fakeThis(call))
    ).resolves.toBeUndefined();
  });

  it("propagates any other DO failure", async () => {
    const call = vi.fn(async () => {
      throw new Error("gad store unreachable");
    });
    await expect(
      WorkspaceVcs.prototype.pruneProvenanceSoftState.call(fakeThis(call))
    ).rejects.toThrow("gad store unreachable");
  });

  it("is a no-op when the store is not attached", async () => {
    const call = vi.fn(async () => ({}));
    await WorkspaceVcs.prototype.pruneProvenanceSoftState.call(fakeThis(call, false));
    expect(call).not.toHaveBeenCalled();
  });
});
