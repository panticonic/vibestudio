import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  internalDOExecutionArtifacts,
  internalDOExecutionIdentity,
  type InternalDOBundle,
} from "./internalDoLoader.js";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/retention";

function bundle(content = "export class GadWorkspaceDO {};"): InternalDOBundle {
  return {
    bundle: content,
    buildKey: createHash("sha256").update(content).digest("hex"),
  };
}

describe("internalDOExecutionIdentity", () => {
  it("seals exact bundle bytes, class entrypoint, and reviewed authority", () => {
    const gad = internalDOExecutionIdentity(bundle(), "GadWorkspaceDO");
    const evalDo = internalDOExecutionIdentity(bundle(), "EvalDO");
    const workspace = internalDOExecutionIdentity(bundle(), "WorkspaceDO");

    expect(gad).toMatchObject({
      source: "vibestudio/internal",
      unitName: "@vibestudio/internal-do/GadWorkspaceDO",
      stateHash: `state:${bundle().buildKey}`,
      buildKey: bundle().buildKey,
      effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(gad.authorityRequests).toEqual([]);
    expect(evalDo.authorityRequests).toEqual([
      {
        capability: "external.open",
        resource: { kind: "prefix", prefix: "" },
        tier: "gated",
        evidence: "intentional-broad",
      },
    ]);
    expect(workspace.executionDigest).not.toBe(gad.executionDigest);
    expect(evalDo.executionDigest).not.toBe(gad.executionDigest);
    expect(verifyExecutionArtifactRef(gad.artifact)).toEqual(gad.artifact);
    expect(gad.artifact.sourceState).toMatchObject({
      kind: "product-seed",
      state: null,
      contentRoots: [{ repoPath: null, stateHash: `state:${bundle().buildKey}` }],
    });
  });

  it("enumerates every reviewed product-seed entrypoint with one shared bundle key", () => {
    const artifacts = internalDOExecutionArtifacts(bundle());
    expect(artifacts).toHaveLength(5);
    expect(new Set(artifacts.map((artifact) => artifact.buildKey))).toEqual(
      new Set([bundle().buildKey])
    );
    expect(new Set(artifacts.map((artifact) => artifact.executionDigest))).toHaveLength(5);
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
