import { describe, expect, it } from "vitest";
import type { BuildResultWire } from "@vibestudio/service-schemas/build";
import { verifyReleaseBuildBatch, stageReleaseSchemaEvidence } from "./releaseVerifierRunner.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  useSchemaProbeFixtureCache,
  schemaProbeEnvironmentForFixture,
} from "../../tests/fixtures/schemaProbeEnvironment.js";
import {
  acquireSchemaProbeEvidence,
  readInstalledSchemaProbeEvidence,
  type SchemaProbeIdentity,
} from "../server/services/schemaProbeEvidence.js";
import {
  schemaProbeStagingPath,
  publishSchemaProbeComponent,
  retireSchemaProbeStaging,
} from "../../scripts/lib/schema-evidence-publication.mjs";
useSchemaProbeFixtureCache();

function buildResult(buildKey: string): BuildResultWire {
  return {
    dir: "/cache/build",
    buildKey,
    sourceStateHash: null,
    metadata: {
      kind: "panel",
      name: "fixture",
      buildKey,
      sourcePath: null,
      ev: "fixture",
      sourceStateHash: null,
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-10-12T00:00:00.000Z",
    },
    artifacts: [],
  };
}

describe("release verifier RPC batch", () => {
  it("stages only canonical proven schema receipts inside the installed compiled verifier", async () => {
    const derived = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"]!;
    const resources = path.join(derived, "installed");
    const buildKey = "d".repeat(64);
    const source = "workers/fixture";
    const installation = schemaProbeEnvironmentForFixture("owned-compiled-verifier-program");
    const identity: SchemaProbeIdentity = {
      installation,
      source,
      artifactDigest: "a".repeat(64),
      className: "FixtureDO",
      protocol: 3,
      platform: process.platform,
      arch: process.arch,
      compatibility: {
        compatibilityDate: "2025-12-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "worker.js",
      },
    };
    const descriptor = {
      className: "FixtureDO",
      version: 1,
      freshSchemaFingerprint: "proven",
      durableWorkQueues: [],
      nativeOwner: false,
    };
    await acquireSchemaProbeEvidence(
      { identity, signal: new AbortController().signal },
      async () => descriptor
    );
    await fs.mkdir(path.join(resources, "userland-builds", buildKey), { recursive: true });
    await fs.writeFile(
      path.join(resources, "userland-builds/release.json"),
      JSON.stringify({
        ...installation,
        platform: process.platform,
        arch: process.arch,
        builds: [{ source, buildKey }],
      })
    );
    await fs.writeFile(
      path.join(resources, "userland-builds", buildKey, "metadata.json"),
      JSON.stringify({ execution: { artifactDigest: identity.artifactDigest } })
    );
    const stagingPath = schemaProbeStagingPath(resources);
    expect(await stageReleaseSchemaEvidence({ resources, stagingPath })).toBe(stagingPath);
    expect((await readInstalledSchemaProbeEvidence(resources, installation)).size).toBe(0);
    try {
      await publishSchemaProbeComponent(stagingPath, resources);
    } finally {
      await retireSchemaProbeStaging(stagingPath, resources);
    }
    const inventory = await readInstalledSchemaProbeEvidence(resources, installation);
    expect([...inventory.values()].map((receipt) => receipt.descriptor)).toEqual([descriptor]);
  });
  it("uses one client for six joined calls and retains ordered build identities", async () => {
    const sources = Array.from({ length: 9 }, (_, index) => `base/source-${index}`);
    let active = 0;
    let maximumActive = 0;
    const getBuild = async (source: string) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const index = sources.indexOf(source);
      return buildResult(String(index).padStart(64, "0"));
    };

    const outcomes = await verifyReleaseBuildBatch(getBuild, sources);

    expect(maximumActive).toBe(6);
    expect(outcomes).toEqual(
      sources.map((source, index) => ({
        status: "fulfilled",
        source,
        buildKey: String(index).padStart(64, "0"),
      }))
    );
  });

  it("joins every rejected call and preserves its original error object and order", async () => {
    const sources = ["base/first", "base/second", "base/third"];
    const failures = sources.map((source) => new Error(`failed ${source}`));
    let active = 0;
    const getBuild = async (source: string) => {
      active++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      throw failures[sources.indexOf(source)];
    };

    const outcomes = await verifyReleaseBuildBatch(getBuild, sources);

    expect(active).toBe(0);
    expect(outcomes).toEqual(
      sources.map((source, index) => ({ status: "rejected", source, failure: failures[index] }))
    );
  });

  it("stops admitting sources after cancellation and joins calls already in flight", async () => {
    const sources = Array.from({ length: 9 }, (_, index) => `base/source-${index}`);
    const controller = new AbortController();
    const cancellation = new Error("server owner exited");
    let releaseCalls!: () => void;
    const callsReleased = new Promise<void>((resolve) => (releaseCalls = resolve));
    const started: string[] = [];
    const getBuild = async (source: string) => {
      started.push(source);
      await callsReleased;
      return buildResult(source);
    };

    const batch = verifyReleaseBuildBatch(getBuild, sources, controller.signal);
    expect(started).toHaveLength(6);
    controller.abort(cancellation);
    releaseCalls();
    const outcomes = await batch;

    expect(started).toEqual(sources.slice(0, 6));
    expect(outcomes.slice(0, 6).every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(outcomes.slice(6)).toEqual(
      sources.slice(6).map((source) => ({ status: "rejected", source, failure: cancellation }))
    );
  });
});
