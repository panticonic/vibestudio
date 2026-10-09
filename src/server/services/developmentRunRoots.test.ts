import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";
import { DEVELOPMENT_RUN_MARKER, DevelopmentRunRoots } from "./developmentRunRoots.js";

const temporaryRoots: string[] = [];
const workspaceId = "workspace:test";

function artifact(buildKey = "b".repeat(64), workspace = workspaceId): ExecutionArtifactRefV1 {
  const effectiveVersion = "e".repeat(64) as Sha256;
  const key = buildKey as Sha256;
  const artifactDigest = "a".repeat(64) as Sha256;
  const contentRoots = [{ repoPath: "projects/app", stateHash: `state:${"c".repeat(64)}` }];
  const sourceState = {
    kind: "workspace" as const,
    workspaceId: workspace,
    effectiveVersion,
    state: { kind: "event" as const, eventId: "event:test" },
    contentRoots,
    sourceClosureDigest: executionSourceClosureDigest(contentRoots),
  };
  return {
    version: 1,
    sourceState,
    recipeDigest: key,
    buildKey: key,
    artifactDigest,
    executionDigest: executionArtifactDigest({
      version: 1,
      sourceState,
      recipeDigest: key,
      buildKey: key,
      artifactDigest,
    }),
  };
}

async function fixture(
  input: {
    journal?: ExecutionPublicationPort;
  } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "development-run-roots-"));
  temporaryRoots.push(root);
  return {
    root,
    owner: new DevelopmentRunRoots({
      root: path.join(root, "runs"),
      workspaceId,
      publicationJournal: input.journal ?? {
        reserve: () => ({ reservationId: "r", epoch: 1 }),
        finalize: () => undefined,
      },
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("DevelopmentRunRoots", () => {
  it.each([".", ".."])("rejects the reserved path identifier %s", async (runId) => {
    const { owner } = await fixture();
    expect(() => owner.runRoot(runId)).toThrow("Invalid development run id");
  });

  it("restores exact published roots from real markers after restart", async () => {
    const { root, owner } = await fixture();
    const exact = artifact();
    await owner.claim("run-one", exact.buildKey);
    await owner.publish("run-one", exact.buildKey, exact);
    const restarted = new DevelopmentRunRoots({
      root: path.join(root, "runs"),
      workspaceId,
      publicationJournal: {
        reserve: () => ({ reservationId: "unused", epoch: 2 }),
        finalize: () => undefined,
      },
    });
    await expect(restarted.snapshotRoots()).resolves.toEqual([
      { owner: "development-run", ownerId: "run-one", reason: "active", artifact: exact },
    ]);
  });

  it("fails closed for a corrupt v2 marker", async () => {
    const { owner } = await fixture();
    await owner.claim("run-corrupt", "b".repeat(64));
    await fs.writeFile(
      path.join(owner.runRoot("run-corrupt"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 2, runId: "run-corrupt", snapshotDigest: "b".repeat(64) })
    );
    await expect(owner.snapshotRoots()).rejects.toThrow("foreign owner marker");
  });

  it("refuses a marker from an unknown version", async () => {
    const { owner } = await fixture();
    await fs.mkdir(owner.runRoot("run-unknown"), { recursive: true });
    await fs.writeFile(
      path.join(owner.runRoot("run-unknown"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 1, runId: "run-unknown", snapshotDigest: "b".repeat(64) })
    );
    await expect(owner.snapshotRoots()).rejects.toMatchObject({ code: "EOWNERSHIP" });
  });

  it("reserves before exposing a published artifact and finalizes afterward", async () => {
    let owner!: DevelopmentRunRoots;
    const exact = artifact();
    const journal: ExecutionPublicationPort = {
      reserve: vi.fn(() => ({ reservationId: "reservation", epoch: 4 })),
      finalize: vi.fn(() => undefined),
    };
    const state = await fixture({ journal });
    owner = state.owner;
    await owner.claim("run-publish", exact.buildKey);
    (journal.reserve as ReturnType<typeof vi.fn>).mockImplementation(() => {
      expect(
        JSON.parse(
          fsSync.readFileSync(
            path.join(owner.runRoot("run-publish"), DEVELOPMENT_RUN_MARKER),
            "utf8"
          )
        ).artifact
      ).toBeNull();
      return { reservationId: "reservation", epoch: 4 };
    });
    (journal.finalize as ReturnType<typeof vi.fn>).mockImplementation(() => {
      expect(
        JSON.parse(
          fsSync.readFileSync(
            path.join(owner.runRoot("run-publish"), DEVELOPMENT_RUN_MARKER),
            "utf8"
          )
        ).artifact
      ).toEqual(exact);
    });
    await owner.publish("run-publish", exact.buildKey, exact);
  });

  it("removes an explicitly retired owned run", async () => {
    const { owner } = await fixture();
    await owner.claim("run-retired", "b".repeat(64));
    await owner.retire("run-retired", "b".repeat(64));
    await expect(fs.stat(owner.runRoot("run-retired"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats retiring an unclaimed or already-retired root as done", async () => {
    const { owner } = await fixture();
    await expect(owner.retire("run-never-claimed", "c".repeat(64))).resolves.toBeUndefined();
    await owner.claim("run-twice", "d".repeat(64));
    await owner.retire("run-twice", "d".repeat(64));
    await expect(owner.retire("run-twice", "d".repeat(64))).resolves.toBeUndefined();
  });
});
