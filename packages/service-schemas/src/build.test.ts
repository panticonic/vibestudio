import { describe, expect, it } from "vitest";
import type { ExecutionSourceStateRef } from "@vibestudio/shared/execution/retention";
import {
  buildDiagnosticSchema,
  buildMetadataDetailsSchema,
  buildMetadataSchema,
  buildMethods,
  buildResultSchema,
  executionArtifactRefSchema,
  workspaceRpcMethodDocSchema,
} from "./build.js";

const digest = "0".repeat(64);
const semanticState = { kind: "event" as const, eventId: "event:test" };

interface TestSourceState {
  kind: "workspace" | "product-seed";
  workspaceId: string;
  effectiveVersion: string;
  state: ExecutionSourceStateRef | null;
  contentRoots: Array<{ repoPath: string | null; stateHash: string }>;
  sourceClosureDigest: string;
}

function sourceState(kind: "workspace" | "product-seed"): TestSourceState {
  const state: ExecutionSourceStateRef | null = kind === "workspace" ? semanticState : null;
  return {
    kind,
    workspaceId: "workspace:test",
    effectiveVersion: digest,
    state,
    contentRoots: [
      {
        repoPath: kind === "workspace" ? "packages/test" : null,
        stateHash: `state:${digest}`,
      },
    ],
    sourceClosureDigest: digest,
  };
}

function artifact(source: TestSourceState) {
  return {
    version: 1,
    sourceState: source,
    recipeDigest: digest,
    buildKey: digest,
    artifactDigest: digest,
    executionDigest: digest,
  };
}

describe("execution artifact ref wire schema", () => {
  it("requires semantic state for workspace-derived artifacts", () => {
    expect(executionArtifactRefSchema.safeParse(artifact(sourceState("workspace"))).success).toBe(
      true
    );
    expect(
      executionArtifactRefSchema.safeParse(artifact({ ...sourceState("workspace"), state: null }))
        .success
    ).toBe(false);
  });

  it("accepts a canonical bootstrap snapshot as exact workspace source state", () => {
    expect(
      executionArtifactRefSchema.safeParse(
        artifact({
          ...sourceState("workspace"),
          state: {
            kind: "bootstrap-snapshot",
            snapshotHash: `state:${digest}`,
          },
        })
      ).success
    ).toBe(true);
    expect(
      executionArtifactRefSchema.safeParse(
        artifact({
          ...sourceState("workspace"),
          state: {
            kind: "bootstrap-snapshot",
            snapshotHash: "not-a-state",
          },
        })
      ).success
    ).toBe(false);
  });

  it("reserves null semantic state for repository-free product seeds", () => {
    expect(
      executionArtifactRefSchema.safeParse(artifact(sourceState("product-seed"))).success
    ).toBe(true);
    expect(
      executionArtifactRefSchema.safeParse(
        artifact({
          ...sourceState("product-seed"),
          contentRoots: [{ repoPath: "packages/seed", stateHash: `state:${digest}` }],
        })
      ).success
    ).toBe(false);
  });
});

describe("build method effects", () => {
  it("carries the sealed service authority identity through build metadata RPC", () => {
    const metadata = {
      kind: "worker",
      name: "@workspace-workers/test",
      buildKey: digest,
      sourcePath: "workers/test",
      ev: "ev:test",
      sourceStateHash: `state:${digest}`,
      sourcemap: false,
      serviceAuthorityDigest: digest,
      details: { kind: "generic" },
      builtAt: new Date(0).toISOString(),
    };
    expect(buildMethods.getBuildMetadata.returns.parse(metadata)).toEqual(metadata);
    for (const serviceAuthorityDigest of ["", "not-a-digest", "A".repeat(64)]) {
      expect(buildMetadataSchema.safeParse({ ...metadata, serviceAuthorityDigest }).success).toBe(
        false
      );
    }
  });

  it("preserves publication schema diagnostics on the public wire", () => {
    expect(
      buildDiagnosticSchema.parse({
        source: "schema",
        severity: "error",
        file: "workers/board/index.ts",
        line: 0,
        column: 0,
        message: "BoardDO fixture migration diverged from its fresh schema",
      })
    ).toMatchObject({ source: "schema", severity: "error" });
  });

  it("carries bounded structured repairs on the public diagnostic wire", () => {
    const protocolRepair = {
      code: "application-protocol-declaration",
      remove: {
        file: "workers/board/package.json",
        field: 'vibestudio.durable.classes[className="BoardDO"].rpcSchema',
      },
      declareAt: { file: "meta/vibestudio.yml", field: "services[].protocols" },
      docsId: "runtime:workerRuntime.workers.resolveService",
    };
    const requestRepair = {
      code: "missing-authority-request",
      file: "panels/board/package.json",
      field: "vibestudio.authority.requests",
      request: {
        capability: "workspace-service:board",
        resource: { kind: "exact", key: "do:workers/board:BoardDO:main" },
        tier: "gated",
        evidence: "exact",
      },
      docsId: "workspace:board",
    };
    for (const repair of [protocolRepair, requestRepair]) {
      const parsed = buildDiagnosticSchema.parse({
        source: repair.code === "missing-authority-request" ? "authority" : "schema",
        severity: "error",
        file: "workers/board/package.json",
        line: 1,
        column: 1,
        message: "declaration failure",
        repair,
      });
      expect(parsed.repair).toEqual(repair);
    }
    // Strictness: an unknown repair code is rejected, not silently carried.
    expect(
      buildDiagnosticSchema.safeParse({
        source: "schema",
        severity: "error",
        file: "x",
        line: 0,
        column: 0,
        message: "m",
        repair: { code: "made-up-repair" },
      }).success
    ).toBe(false);
  });

  it("treats workspace compilation as read-only and external acquisition as write", () => {
    expect(buildMethods.getBuild.access).toEqual({ sensitivity: "read" });
    expect(buildMethods.getBuildReport.access).toEqual({ sensitivity: "read" });
    expect(buildMethods.getBuildNpm.access).toEqual({ sensitivity: "write" });
  });

  it("accepts executable module provenance emitted by BuildV2 metadata", () => {
    expect(
      buildMetadataSchema.safeParse({
        kind: "worker",
        name: "worker:test",
        buildKey: digest,
        sourcePath: "workers/test",
        ev: "ev:test",
        sourceStateHash: digest,
        sourcemap: false,
        executableModules: [
          {
            moduleId: "src/index.ts",
            contentDigest: digest,
            package: { kind: "first-party" },
            format: "ts",
            source: "src/index.ts",
          },
        ],
        details: { kind: "generic" },
        builtAt: new Date(0).toISOString(),
      }).success
    ).toBe(true);
  });

  it("preserves optional authority fields on the build wire", () => {
    const metadata = {
      kind: "worker" as const,
      name: "worker:test",
      buildKey: digest,
      sourcePath: "workers/test",
      ev: "ev:test",
      sourceStateHash: digest,
      sourcemap: false,
      authority: { requests: [], provides: [] },
      details: { kind: "generic" as const },
      builtAt: new Date(0).toISOString(),
    };

    expect(buildMetadataSchema.parse(metadata).authority).toEqual(metadata.authority);
  });

  it("preserves the complete producer workspace RPC contract in build metadata", () => {
    const method = {
      website: { kind: "eligible" as const, rationale: "An explicitly exposed receiver method." },
      className: "TestWorker",
      name: "runTest",
      signature: "runTest(input: Input): Promise<Output>",
      argsSchema: { type: "object", properties: { id: { type: "string" } } },
      returnsSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      argumentNames: ["input"],
      effect: { kind: "open" as const },
      access: { tier: "open" as const, sensitivity: "read" as const, crossWorkspace: true },
      execution: { harness: "attested-system-test" as const },
      inputContractDigest: digest,
    };
    expect(workspaceRpcMethodDocSchema.parse(method)).toEqual(method);
    expect(workspaceRpcMethodDocSchema.safeParse({ ...method, unownedField: true }).success).toBe(
      false
    );
    expect(
      buildMetadataSchema.safeParse({
        kind: "worker",
        name: "worker:test",
        buildKey: digest,
        sourcePath: "workers/test",
        ev: "ev:test",
        sourceStateHash: digest,
        sourcemap: false,
        workspaceRpcCatalog: [method],
        details: { kind: "generic" },
        builtAt: new Date(0).toISOString(),
      }).success
    ).toBe(true);
  });

  it("accepts the complete artifact manifest emitted by the build store", () => {
    expect(
      buildResultSchema.safeParse({
        dir: "/tmp/build",
        buildKey: digest,
        sourceStateHash: `state:${digest}`,
        metadata: {
          kind: "panel",
          name: "@workspace-panels/test",
          buildKey: digest,
          sourcePath: "panels/test",
          ev: "ev:test",
          sourceStateHash: `state:${digest}`,
          sourcemap: false,
          details: { kind: "generic" },
          builtAt: new Date(0).toISOString(),
        },
        artifacts: [
          {
            path: "shared.css",
            role: "shared-style",
            contentType: "text/css",
            encoding: "utf8",
            byteLength: 7,
            content: "body {}",
          },
        ],
      }).success
    ).toBe(true);
  });
});

describe("BuildV2 metadata details", () => {
  const details = [
    {
      kind: "extension",
      runtimeDepsKey: digest,
      runtimeAbi: "extension-runtime.v1",
      providerContracts: { "vibestudio.example.v1": { methods: ["read"] } },
      methodAuthority: {
        openMethod: {
          website: { kind: "eligible", rationale: "Explicitly available to callers." },
          effect: { kind: "open" },
        },
        capabilityMethod: {
          website: { kind: "closed", reason: "Receiver-owned capability operation." },
          effect: {
            kind: "userland-capability",
            capability: "workspace.read",
            resource: { kind: "receiver" },
          },
          userlandCapability: {
            canonicalCapability: "userland:extensions/test/workspace.read#digest",
            definitionDigest: digest,
            resourceType: "workspace-file",
            grantScopes: ["task"],
            title: "Read a workspace file",
            action: "read",
          },
        },
      },
      dependencyMode: "external",
      externalDeps: { example: "1.0.0" },
      dependencyOverrides: {},
      dependencyPatches: [
        {
          selector: "example@1",
          packageName: "example",
          version: "1.0.0",
          owner: "extensions/test",
          roots: ["extensions/test"],
          content: "patch",
          digest,
        },
      ],
      classifiedDeps: [
        {
          name: "example",
          version: "1.0.0",
          external: true,
          format: "esm",
          reasons: ["runtime dependency"],
          explanation: "Loaded by the extension host.",
        },
      ],
      smokeTest: { mode: "child-process", passed: true },
    },
    {
      kind: "app",
      target: "react-native",
      platform: "ios",
      integrity: null,
      rnHostAbi: "rn-host.v1",
      provider: {
        name: "provider",
        activeEv: digest,
        activeBuildKey: digest,
        contractVersion: "1",
      },
    },
    { kind: "library", format: "async-cjs", requiredModules: ["node:fs"] },
    {
      kind: "website-bundle",
      entryArtifact: "website/index.js",
      declaration: { title: "Example" },
    },
    { kind: "test", suite: "system", runtime: "workerd", selectedFiles: ["test.ts"] },
    { kind: "generic" },
  ] as const;

  it("accepts every producer metadata variant and rejects unknown variants and fields", () => {
    for (const detail of details) {
      expect(buildMetadataDetailsSchema.parse(detail)).toEqual(detail);
    }
    expect(buildMetadataDetailsSchema.safeParse({ kind: "future-kind" }).success).toBe(false);
    expect(buildMetadataDetailsSchema.safeParse({ ...details[2], unowned: true }).success).toBe(
      false
    );
    expect(
      buildMetadataDetailsSchema.safeParse({
        ...details[2],
        format: "made-up-format",
      }).success
    ).toBe(false);
  });
});
