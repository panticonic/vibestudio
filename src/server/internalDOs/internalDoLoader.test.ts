import { describe, expect, it, vi } from "vitest";
import {
  internalDOExecutionArtifacts,
  internalDOExecutionIdentity,
  INTERNAL_DO_CLASSES,
  InternalDOPrograms,
} from "./internalDoLoader.js";
import { verifyExecutionArtifactRef } from "@vibestudio/shared/execution/retention";
import { internalDoProgramsForFixture } from "../../../tests/fixtures/internalDoPrograms.js";

const bundle = internalDoProgramsForFixture;

describe("internalDOExecutionIdentity", () => {
  it("fixture publication restores the existing global after consumer failure", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__VIBESTUDIO_RUNTIME_APP__");
    const failure = new Error("original installed admission failure");
    const read = vi.spyOn(InternalDOPrograms, "readInstalled").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => bundle()).toThrow(failure);
      expect(Object.getOwnPropertyDescriptor(globalThis, "__VIBESTUDIO_RUNTIME_APP__")).toEqual(
        descriptor
      );
    } finally {
      read.mockRestore();
    }
  });

  it("fixture publication cannot replace an active hub snapshot coordinate", () => {
    const key = "VIBESTUDIO_RUNTIME_APP_PATH";
    const prior = process.env[key];
    process.env[key] = "/owned/hub/runtime-app.json";
    try {
      expect(() => bundle()).toThrow(/cannot replace an active hub snapshot/);
      expect(process.env[key]).toBe("/owned/hub/runtime-app.json");
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("seals exact bundle bytes, class entrypoint, and reviewed authority", () => {
    const webhook = internalDOExecutionIdentity(bundle(), "WebhookStoreDO");
    const workspace = internalDOExecutionIdentity(bundle(), "WorkspaceDO");

    expect(webhook).toMatchObject({
      source: "vibestudio/internal",
      unitName: "@panticonic/builtin/webhook.engine",
      stateHash: `state:${bundle().get("WebhookStoreDO").buildKey}`,
      buildKey: bundle().get("WebhookStoreDO").buildKey,
      effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(webhook.authority.requests).toEqual([]);
    expect(workspace.executionDigest).not.toBe(webhook.executionDigest);
    expect(verifyExecutionArtifactRef(webhook.artifact)).toEqual(webhook.artifact);
    expect(webhook.artifact.sourceState).toMatchObject({
      kind: "product-seed",
      state: null,
      contentRoots: [
        { repoPath: null, stateHash: `state:${bundle().get("WebhookStoreDO").buildKey}` },
      ],
    });
  });

  it("enumerates each reviewed product-seed entrypoint of the one runtime application", () => {
    const programs = bundle();
    const artifacts = internalDOExecutionArtifacts(programs);
    expect(artifacts).toHaveLength(INTERNAL_DO_CLASSES.length);
    // One deployed module holds every product class; the class name and its
    // reviewed authority, not separate bytes, distinguish their executions.
    expect(new Set(artifacts.map((artifact) => artifact.buildKey))).toEqual(
      new Set([programs.app().buildKey])
    );
    expect(new Set(artifacts.map((artifact) => artifact.executionDigest))).toHaveLength(
      INTERNAL_DO_CLASSES.length
    );
  });

  it("rejects unreviewed exports and owns a frozen identity capture", () => {
    const programs = bundle();
    const identity = internalDOExecutionIdentity(programs, "WebhookStoreDO");
    expect(internalDOExecutionIdentity(programs, "WebhookStoreDO")).toBe(identity);
    expect(Object.isFrozen(identity.authority)).toBe(true);
    expect(Object.isFrozen(identity.artifact.sourceState)).toBe(true);
    expect(() => internalDOExecutionIdentity(bundle(), "UnreviewedDO")).toThrow(
      /not a reviewed product export/
    );
  });
});
