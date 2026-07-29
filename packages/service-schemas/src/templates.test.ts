import { describe, expect, it } from "vitest";
import {
  templateAuthoringInspectionSchema,
  templateInspectionSchema,
  templateLocatorSchema,
  templateOperationSchema,
  templatesMethods,
  templateStatusRowSchema,
} from "./templates.js";

const blocker = {
  state: "waiting-for-credential" as const,
  code: "GitCredentialSelectionRequired",
  message: "Connect an account to continue",
  nextAction: "connect-credential" as const,
  credential: {
    name: "github-main",
    remoteUrl: "https://example.test/private.git",
    provider: "github",
  },
};

describe("template recovery contracts", () => {
  it("uses operationId consistently for resume and cancel", () => {
    expect(
      templatesMethods.resume.args.parse([
        { operationId: "pull-1", onBuildFailure: "retain-context" },
      ])
    ).toEqual([{ operationId: "pull-1", onBuildFailure: "retain-context" }]);
    expect(() => templatesMethods.resume.args.parse([{ commandId: "pull-1" }])).toThrow();
    expect(templatesMethods.cancel.args.parse([{ operationId: "pull-1" }])).toEqual([
      { operationId: "pull-1" },
    ]);
  });

  it("returns only resumable operation states", () => {
    const operation = {
      operationId: "pull-1",
      kind: "pull",
      contextId: "template-composer-operation-1",
      fingerprint: `v1-sha256:${"a".repeat(64)}`,
    };
    expect(
      templatesMethods.operations.returns.parse([
        { ...operation, state: "pending" },
        { ...operation, operationId: "pull-2", state: "reviewing" },
      ])
    ).toHaveLength(2);
    expect(() =>
      templatesMethods.operations.returns.parse([{ ...operation, state: "applied" }])
    ).toThrow();
  });

  it("carries an actionable durable blocker through status", () => {
    expect(
      templateStatusRowSchema.parse({
        nodeId: "t-base",
        alias: "base",
        url: "git+https://example.test/private.git",
        ref: "refs/tags/v1",
        commit: "1".repeat(40),
        direct: true,
        state: "waiting-for-credential",
        ownedParts: 1,
        pendingReviews: 1,
        verification: "deferred",
        suggestions: [],
        blocker,
        error: blocker.message,
      })
    ).toMatchObject({ state: "waiting-for-credential", blocker });
  });

  it("returns the same blocker from an idempotent mutation retry", () => {
    expect(
      templateOperationSchema.parse({
        operationId: "add:private",
        state: "waiting-for-credential",
        blocker,
        addedParts: [],
        orphanedParts: [],
      })
    ).toMatchObject({ state: "waiting-for-credential", blocker });
  });

  it("does not expose host-internal approval references", () => {
    expect(() =>
      templateOperationSchema.parse({
        operationId: "add:private",
        state: "pending",
        cardRef: "internal-approval-record",
        addedParts: [],
        orphanedParts: [],
      })
    ).toThrow();
  });
});

describe("template authoring contracts", () => {
  const plan = {
    request: {
      name: "Demo",
      description: "A focused demo",
      parts: ["extensions/demo"],
    },
    mainEventId: "event:main",
    selectableParts: ["extensions/demo", "packages/shared"],
    requestedParts: ["extensions/demo"],
    includedParts: ["extensions/demo", "packages/shared"],
    requiredParts: ["packages/shared"],
    inheritedParts: [],
    parents: [],
    manifest: "systemEpoch: 57\n",
    manifestDigest: `v1-sha256:${"a".repeat(64)}`,
    fingerprint: `v1-sha256:${"b".repeat(64)}`,
  };

  it("binds publication to the complete inspected authoring receipt", () => {
    expect(templateAuthoringInspectionSchema.parse(plan)).toEqual(plan);
    expect(
      templatesMethods.publishAuthoring.args.safeParse([
        {
          commandId: "publish-demo",
          plan,
          version: "1.0.0",
          destination: { provider: "github", name: "template-demo", private: true },
        },
      ]).success
    ).toBe(true);
    expect(
      templatesMethods.publishAuthoring.args.safeParse([
        {
          commandId: "publish-demo",
          fingerprint: plan.fingerprint,
          version: "1.0.0",
          destination: { name: "template-demo" },
        },
      ]).success
    ).toBe(false);
  });
});

describe("exact template selection contracts", () => {
  const pin = {
    url: "git+https://example.test/private.git",
    credential: "github-main",
    ref: "refs/heads/main",
    commit: "1".repeat(40),
    snapshot: `v1-sha256:${"a".repeat(64)}`,
  };

  it("carries a logical credential from direct discovery into the exact inspected pin", () => {
    expect(
      templateLocatorSchema.parse({
        url: "git+https://example.test/private.git",
        credential: "github-main",
      })
    ).toEqual({
      url: "git+https://example.test/private.git",
      credential: "github-main",
    });
    expect(
      templateInspectionSchema.parse({
        pin,
        fingerprint: `v1-sha256:${"b".repeat(64)}`,
        roots: [],
        templates: [],
        addedParts: [],
        retainedParts: [],
        orphanedParts: [],
        conflicts: [],
        excludedSuggestions: [],
      }).pin
    ).toEqual(pin);
  });

  it("requires add to consume an exact inspected pin and rejects the old locator path", () => {
    expect(
      templatesMethods.add.args.safeParse([
        {
          commandId: "add-private",
          pin,
        },
      ]).success
    ).toBe(true);
    expect(
      templatesMethods.add.args.safeParse([
        {
          commandId: "add-private",
          locator: { url: pin.url, credential: pin.credential },
        },
      ]).success
    ).toBe(false);
  });
});
