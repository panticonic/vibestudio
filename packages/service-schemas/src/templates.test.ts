import { describe, expect, it } from "vitest";
import {
  templateAddRequestSchema,
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
  it("represents an uninitialized registry cache without an exception payload", () => {
    expect(templatesMethods.catalog.returns.parse(null)).toBeNull();
  });

  it("uses operationId consistently for resume and cancel", () => {
    expect(templatesMethods.resume.args.parse([{ operationId: "pull-1" }])).toEqual([
      { operationId: "pull-1" },
    ]);
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
      initiator: "user" as const,
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

  it("carries migration facets on a retained repair operation", () => {
    expect(
      templatesMethods.operations.returns.parse([
        {
          operationId: "pull-base",
          kind: "pull",
          contextId: "template-composer-operation-base",
          initiator: "host-release",
          target: { alias: "base", ref: "refs/tags/v2" },
          state: "repairing",
          fingerprint: `v1-sha256:${"a".repeat(64)}`,
          migration: {
            facets: ["system"],
            notes: [
              {
                path: "migrations/system/current-contract.md",
                title: "Current contract",
                degradedOk: false,
              },
            ],
          },
          repair: {
            contextId: "template-composer-operation-base",
            failures: [],
          },
        },
      ])[0]
    ).toMatchObject({
      initiator: "host-release",
      target: { alias: "base", ref: "refs/tags/v2" },
      migration: { facets: ["system"] },
    });
  });

  it("accepts an exact host-shipped target on the ordinary pull method", () => {
    const pin = {
      url: "git+https://example.test/base.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    expect(
      templatesMethods.pull.args.parse([{ commandId: "host-release", alias: "base", pin }])
    ).toEqual([{ commandId: "host-release", alias: "base", pin }]);
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
        contributedParts: 1,
        pendingReviews: 1,
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
        initiator: "user",
        state: "waiting-for-credential",
        blocker,
        affectedParts: [],
      })
    ).toMatchObject({ state: "waiting-for-credential", blocker });
  });

  it("returns a retained context and structured failures for agentic repair", () => {
    expect(
      templateOperationSchema.parse({
        operationId: "add:news",
        initiator: "user",
        state: "error",
        affectedParts: ["panels/news"],
        blocker: {
          state: "error",
          code: "TemplateBuildFailed",
          message: "panels/news: type error",
          nextAction: "details",
        },
        repair: {
          contextId: "template-operation-news",
          failures: [{ unit: "panels/news", message: "type error" }],
        },
      }).repair
    ).toEqual({
      contextId: "template-operation-news",
      failures: [{ unit: "panels/news", message: "type error" }],
    });
  });

  it("returns the exact protected-main event needed to repair a stale operation", () => {
    expect(
      templateOperationSchema.parse({
        operationId: "pull:news",
        initiator: "user",
        state: "error",
        affectedParts: ["panels/news"],
        blocker: {
          state: "error",
          code: "TemplateMainAdvanced",
          message: "Protected main advanced",
          nextAction: "details",
        },
        repair: {
          contextId: "template-operation-news",
          mainEventId: "event:new-main",
          failures: [
            {
              unit: "workspace-main",
              message: "Merge protected main and resume",
            },
          ],
        },
      }).repair
    ).toEqual({
      contextId: "template-operation-news",
      mainEventId: "event:new-main",
      failures: [
        {
          unit: "workspace-main",
          message: "Merge protected main and resume",
        },
      ],
    });
  });

  it("does not expose host-internal approval references", () => {
    expect(() =>
      templateOperationSchema.parse({
        operationId: "add:private",
        initiator: "user",
        state: "pending",
        cardRef: "internal-approval-record",
        affectedParts: [],
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
    dependencyParts: [],
    overlapParts: [],
    manifest: "systemEpoch: 57\n",
    manifestDigest: `v1-sha256:${"a".repeat(64)}`,
    fingerprint: `v1-sha256:${"b".repeat(64)}`,
  };

  it("binds publication to semantic intent and the reviewed fingerprint", () => {
    expect(templateAuthoringInspectionSchema.parse(plan)).toEqual(plan);
    expect(
      templatesMethods.publishAuthoring.args.safeParse([
        {
          commandId: "publish-demo",
          intent: plan.request,
          expectedFingerprint: plan.fingerprint,
          version: "1.0.0",
          destination: { provider: "github", owner: "acme", name: "template-demo" },
          creation: { private: true },
        },
      ]).success
    ).toBe(true);
    expect(
      templatesMethods.publishAuthoring.args.safeParse([
        {
          commandId: "publish-demo",
          intent: plan.request,
          expectedFingerprint: plan.fingerprint,
          version: "1.0.0",
          destination: { name: "template-demo" },
        },
      ]).success
    ).toBe(false);
  });

  it("accepts URL dependencies and rejects agent-supplied exact coordinates", () => {
    expect(
      templatesMethods.inspectAuthoring.args.safeParse([
        {
          name: "Child",
          description: "A child template",
          parts: ["extensions/child"],
          dependencies: [{ url: "git+https://example.test/base.git" }],
        },
      ]).success
    ).toBe(true);
    expect(
      templatesMethods.inspectAuthoring.args.safeParse([
        {
          name: "Child",
          description: "A child template",
          parts: ["extensions/child"],
          dependencies: [
            {
              url: "git+https://example.test/base.git",
              ref: "refs/tags/v1",
              commit: "c".repeat(40),
              snapshot: `v1-sha256:${"d".repeat(64)}`,
            },
          ],
        },
      ]).success
    ).toBe(false);
  });

  it("binds registry suggestions to complete publication and catalog receipts", () => {
    const publication = {
      operationId: "publish-demo",
      destination: { provider: "github", owner: "acme", name: "template-demo" },
      created: true,
      remoteUrl: "https://example.test/acme/template-demo.git",
      webUrl: "https://example.test/acme/template-demo",
      templateUrl: "git+https://example.test/acme/template-demo.git",
      ref: "refs/tags/v1.0.0",
      commit: "c".repeat(40),
      snapshot: `v1-sha256:${"d".repeat(64)}`,
      parts: ["extensions/demo"],
    };
    const catalog = {
      version: 1 as const,
      revision: "2026-08-09.1",
      systemEpoch: 57,
      entries: [],
      coordinates: {
        url: "git+https://example.test/template-registry.git",
        ref: "refs/heads/main",
        commit: "e".repeat(40),
        snapshot: `v1-sha256:${"f".repeat(64)}`,
      },
      source: "verified" as const,
      stale: false,
      verifiedAt: "2026-08-09T12:00:00.000Z",
    };
    const request = {
      commandId: "suggest-demo-v1",
      catalog,
      publication,
      entry: {
        id: "demo",
        name: "Demo",
        description: "A focused demo",
        tags: ["demo"],
        recommended: false,
      },
      revision: "2026-08-09.2",
    };
    expect(templatesMethods.suggestRegistryEntry.args.safeParse([request]).success).toBe(true);
    expect(
      templatesMethods.suggestRegistryEntry.args.safeParse([
        { ...request, publication: { commit: publication.commit } },
      ]).success
    ).toBe(false);
    expect(
      templatesMethods.suggestRegistryEntry.args.safeParse([
        { ...request, catalog: { ...catalog, coordinates: undefined } },
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
        affectedParts: [],
        excludedSuggestions: [],
      }).pin
    ).toEqual(pin);
  });

  it("lets add resolve one source inside the canonical install transaction", () => {
    expect(
      templatesMethods.add.args.safeParse([
        {
          commandId: "add-private",
          source: { url: pin.url, credential: pin.credential },
        },
      ]).success
    ).toBe(true);
    expect(
      templatesMethods.add.args.safeParse([
        {
          commandId: "add-private",
          pin,
        },
      ]).success
    ).toBe(false);
  });

  it("accepts catalog choices with optional reviewed registry coordinates", () => {
    expect(templateAddRequestSchema.parse({ catalogId: "github", refreshCatalog: true })).toEqual({
      catalogId: "github",
      refreshCatalog: true,
    });
    expect(
      templatesMethods.add.args.safeParse([
        {
          commandId: "add-github",
          source: { catalogId: "github", registryCommit: "1".repeat(40) },
        },
      ]).success
    ).toBe(false);
    expect(
      templateAddRequestSchema.parse({
        catalogId: "github",
        registryCommit: "1".repeat(40),
        registrySnapshot: `v1-sha256:${"2".repeat(64)}`,
      })
    ).toEqual({
      catalogId: "github",
      registryCommit: "1".repeat(40),
      registrySnapshot: `v1-sha256:${"2".repeat(64)}`,
    });
  });
});
