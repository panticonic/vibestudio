import { describe, expect, it } from "vitest";
import type { BuildResultWire } from "@vibestudio/service-schemas/build";
import { verifyReleaseBuildBatch } from "./releaseVerifierRunner.js";

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
