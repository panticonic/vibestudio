import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DevelopmentExecutionSnapshot,
  DevelopmentRun,
} from "@vibestudio/service-schemas/development";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";
import { DevelopmentRecipeRegistry } from "./developmentRecipes.js";
import { DevelopmentSessionStore } from "./developmentSessionStore.js";
import type { PreparedDevelopmentBuild } from "./developmentExecutor.js";

const roots: string[] = [];
const hash = (character: string): string => character.repeat(64);

function temporaryStatePath(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-development-store-"));
  roots.push(value);
  return value;
}

function artifact(): NonNullable<DevelopmentRun["artifact"]> {
  const contentRoots = [{ repoPath: "projects/vibestudio", stateHash: `state:${hash("a")}` }];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: hash("b") as never,
      state: { kind: "application" as const, applicationId: "application:base" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: hash("c") as never,
    buildKey: hash("d") as never,
    artifactDigest: hash("e") as never,
  };
  // The schema's JSON-facing arrays are mutable while the shared verifier's
  // domain model is readonly. The value is verified through both boundaries.
  return {
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  } as unknown as NonNullable<DevelopmentRun["artifact"]>;
}

function runAndPlan(runId = "run-one"): { run: DevelopmentRun; plan: PreparedDevelopmentBuild } {
  const recipe = new DevelopmentRecipeRegistry().list()[0]!;
  const snapshot: DevelopmentExecutionSnapshot = {
    version: 1,
    sessionId: "development-session",
    contextId: "context:development",
    repositoryId: "repository:vibestudio",
    repoPath: "projects/vibestudio",
    repositoryState: { kind: "application", applicationId: "application:base" },
    repositoryManifestDigest: hash("1"),
    materializedTreeDigest: hash("2"),
    contentRoot: `state:${hash("3")}`,
    sourcePlanDigest: hash("4"),
    recipeDigest: hash("5"),
    toolchain: {
      executorId: hash("6"),
      node: { digest: hash("7"), version: "v24", platform: process.platform, arch: process.arch },
      pnpm: { digest: hash("8"), version: "10" },
      hostSourceBuild: { digest: hash("9") },
    },
    declaredEnvironment: recipe.declaredEnvironment,
    environmentDigest: hash("a"),
    lockfileDigest: hash("b"),
    snapshotDigest: hash("c"),
  };
  const run: DevelopmentRun = {
    version: 1,
    runId,
    sessionId: snapshot.sessionId,
    ownerRuntimeId: "worker:one",
    ownerRuntimeKind: "worker",
    ownerUserId: "user:one",
    attachedHostAuthorityCeiling: null,
    target: { kind: "build-only" },
    recipe,
    snapshot,
    state: "accepted",
    commitPoint: "none",
    artifact: null,
    instance: null,
    hostReadiness: null,
    client: null,
    attachedHost: null,
    repair: null,
    createdAt: 1,
    updatedAt: 1,
    terminalAt: null,
  };
  return {
    run,
    plan: {
      version: 1,
      runId,
      sourcePlan: {} as PreparedDevelopmentBuild["sourcePlan"],
      snapshot,
      recipe,
      executables: {
        nodePath: "/exact/node",
        pnpmCliPath: "/exact/pnpm/pnpm.cjs",
        pnpmRootPath: "/exact/pnpm",
        pnpmCliRelativePath: "pnpm.cjs",
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DevelopmentSessionStore durable run contract", () => {
  it("uses runId as the only start key, rejects drift, and enforces CAS transitions", () => {
    const store = new DevelopmentSessionStore({ statePath: temporaryStatePath() });
    const { run, plan } = runAndPlan();
    expect(store.putRun(run, plan, "intent-one").run).toEqual(run);
    expect(store.putRun(run, plan, "intent-one").run).toEqual(run);
    expect(() => store.putRun(run, plan, "intent-two")).toThrow(/different start intent/);
    expect(() =>
      store.transitionRun({
        runId: run.runId,
        expected: ["building"],
        state: "succeeded",
        terminal: true,
        message: "must not skip the durable state machine",
      })
    ).toThrow(/expected building/);
    expect(
      store.transitionRun({
        runId: run.runId,
        expected: ["accepted"],
        state: "materializing",
        message: "private materialization begins",
      }).run.state
    ).toBe("materializing");
    store.close();
  });

  it("publishes retention ownership in the same transition that exposes an artifact", () => {
    const calls: string[] = [];
    const publicationPort: ExecutionPublicationPort = {
      reserve: vi.fn((publication) => {
        calls.push(`reserve:${publication.ownerId}`);
        return { reservationId: "reservation", epoch: 4 };
      }),
      finalize: vi.fn(() => calls.push("finalize")),
    };
    const store = new DevelopmentSessionStore({ statePath: temporaryStatePath(), publicationPort });
    const { run, plan } = runAndPlan();
    store.putRun(run, plan, "intent-one");
    const value = store.transitionRun({
      runId: run.runId,
      expected: ["accepted"],
      state: "succeeded",
      commitPoint: "artifacts-verified",
      artifact: artifact(),
      terminal: true,
      message: "artifact retained",
    });
    expect(calls).toEqual(["reserve:run-one", "finalize"]);
    expect(value.run.artifact?.executionDigest).toBe(artifact().executionDigest);
    return expect(store.snapshotExecutionRoots(4)).resolves.toEqual([
      expect.objectContaining({
        owner: "development-run",
        ownerId: run.runId,
        reason: "retained-result",
      }),
    ]);
  });

  it("survives a cold restart with immutable plan, event sequence, and retained roots", () => {
    const statePath = temporaryStatePath();
    const first = new DevelopmentSessionStore({ statePath });
    const { run, plan } = runAndPlan("run-restart");
    first.putRun(run, plan, "intent-one");
    first.transitionRun({
      runId: run.runId,
      expected: ["accepted"],
      state: "succeeded",
      commitPoint: "artifacts-verified",
      artifact: artifact(),
      terminal: true,
      message: "artifact retained",
    });
    first.appendRunEvent(run.runId, "log", { line: "first durable log" }, 2);
    first.close();

    const restarted = new DevelopmentSessionStore({ statePath });
    expect(restarted.getRun(run.runId)).toMatchObject({ state: "succeeded", artifact: artifact() });
    expect(restarted.getRunPlan(run.runId)).toEqual(plan);
    expect(restarted.listRunEvents(run.runId, 0, 10).events).toHaveLength(3);
    return expect(restarted.snapshotExecutionRoots(8)).resolves.toHaveLength(1);
  });
});
