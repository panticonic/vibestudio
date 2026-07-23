import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { internalDOExecutionIdentity, type InternalDOBundle } from "./internalDoLoader.js";

function bundle(content = "export class GadWorkspaceDO {};"): InternalDOBundle {
  return {
    bundle: content,
    buildKey: createHash("sha256").update(content).digest("hex"),
  };
}

describe("internalDOExecutionIdentity", () => {
  it("seals exact bundle bytes, class entrypoint, and reviewed authority", () => {
    const gad = internalDOExecutionIdentity(bundle(), "GadWorkspaceDO");
    const workspace = internalDOExecutionIdentity(bundle(), "WorkspaceDO");

    expect(gad).toMatchObject({
      source: "vibestudio/internal",
      unitName: "@vibestudio/internal-do/GadWorkspaceDO",
      stateHash: bundle().buildKey,
      buildKey: bundle().buildKey,
      effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      authorityEvalCeilings: [],
    });
    expect(gad.authorityRequests).toEqual([]);
    expect(workspace.executionDigest).not.toBe(gad.executionDigest);
  });

  it("rejects mismatched bytes and unreviewed internal exports", () => {
    expect(() =>
      internalDOExecutionIdentity({ bundle: "changed", buildKey: bundle().buildKey }, "WorkspaceDO")
    ).toThrow(/does not match its exact bytes/);
    expect(() => internalDOExecutionIdentity(bundle(), "UnreviewedDO")).toThrow(
      /not a reviewed product export/
    );
  });
});
