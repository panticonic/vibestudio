import { describe, expect, it } from "vitest";
import type { ExecutionSourceStateRef } from "@vibestudio/shared/execution/retention";
import {
  buildDiagnosticSchema,
  buildMetadataSchema,
  buildMethods,
  buildResultSchema,
  executionArtifactRefSchema,
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

  it("accepts receiver execution contracts in the sealed workspace RPC catalog", () => {
    expect(
      buildMetadataSchema.safeParse({
        kind: "worker",
        name: "worker:test",
        buildKey: digest,
        sourcePath: "workers/test",
        ev: "ev:test",
        sourceStateHash: digest,
        sourcemap: false,
        workspaceRpcCatalog: [
          {
            className: "TestWorker",
            name: "runTest",
            signature: "runTest(): Promise<void>",
            effect: { kind: "open" },
            execution: { harness: "attested-system-test" },
            inputContractDigest: digest,
          },
        ],
        details: { kind: "generic" },
        builtAt: new Date(0).toISOString(),
      }).success,
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
