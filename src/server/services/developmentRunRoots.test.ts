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
  type ExecutionRoot,
} from "@vibestudio/shared/execution/retention";
import { DEVELOPMENT_RUN_MARKER, DevelopmentRunRoots } from "./developmentRunRoots.js";

const temporaryRoots: string[] = [];
const workspaceId = "workspace:test";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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
    legacyRoots?: (epoch: number) => Promise<readonly ExecutionRoot[]>;
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
      legacyRoots: input.legacyRoots,
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
    await expect(restarted.snapshotRoots(2)).resolves.toEqual([
      { owner: "development-run", ownerId: "run-one", reason: "active", artifact: exact },
    ]);
  });

  it("returns an empty census without consulting an optional legacy service", async () => {
    const legacyRoots = vi.fn();
    const { owner } = await fixture({ legacyRoots });
    await expect(owner.snapshotRoots(1)).resolves.toEqual([]);
    expect(legacyRoots).not.toHaveBeenCalled();
  });

  it("fails closed for a corrupt v2 marker", async () => {
    const { owner } = await fixture();
    await owner.claim("run-corrupt", "b".repeat(64));
    await fs.writeFile(
      path.join(owner.runRoot("run-corrupt"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 2, runId: "run-corrupt", snapshotDigest: "b".repeat(64) })
    );
    await expect(owner.snapshotRoots(1)).rejects.toThrow("foreign owner marker");
  });

  it("fails clearly when legacy runs exist without their authoritative service", async () => {
    const { owner } = await fixture();
    await fs.mkdir(owner.runRoot("run-legacy"), { recursive: true });
    await fs.writeFile(
      path.join(owner.runRoot("run-legacy"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 1, runId: "run-legacy", snapshotDigest: "b".repeat(64) })
    );
    await expect(owner.snapshotRoots(1)).rejects.toThrow(
      "Legacy development run markers require the development service migration source"
    );
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

  it.each([true, false])("migrates a legacy %s run exactly once", async (published) => {
    const exact = artifact();
    const legacyRoots = vi.fn(async () =>
      published
        ? [
            {
              owner: "development-run" as const,
              ownerId: "run-legacy",
              reason: "active" as const,
              artifact: exact,
            },
          ]
        : []
    );
    const { owner } = await fixture({ legacyRoots });
    await fs.mkdir(owner.runRoot("run-legacy"), { recursive: true });
    await fs.writeFile(
      path.join(owner.runRoot("run-legacy"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 1, runId: "run-legacy", snapshotDigest: exact.buildKey })
    );
    const expected = published
      ? [{ owner: "development-run", ownerId: "run-legacy", reason: "active", artifact: exact }]
      : [];
    await expect(owner.snapshotRoots(7)).resolves.toEqual(expected);
    await expect(owner.snapshotRoots(8)).resolves.toEqual(expected);
    expect(legacyRoots).toHaveBeenCalledTimes(1);
  });

  it("never lets legacy migration erase a concurrently published artifact", async () => {
    const exact = artifact();
    const reserve = vi.fn(() => ({ reservationId: "race", epoch: 10 }));
    let releaseLegacy!: (roots: readonly ExecutionRoot[]) => void;
    const legacyStarted = deferred<void>();
    const legacyRoots = vi.fn(
      () =>
        new Promise<readonly ExecutionRoot[]>((resolve) => {
          releaseLegacy = resolve;
          legacyStarted.resolve(undefined);
        })
    );
    const { owner } = await fixture({
      legacyRoots,
      journal: { reserve, finalize: () => undefined },
    });
    await fs.mkdir(owner.runRoot("run-race"), { recursive: true });
    await fs.writeFile(
      path.join(owner.runRoot("run-race"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 1, runId: "run-race", snapshotDigest: exact.buildKey })
    );

    const snapshot = owner.snapshotRoots(10);
    await legacyStarted.promise;
    const publishing = owner.publish("run-race", exact.buildKey, exact);
    expect(reserve).toHaveBeenCalledTimes(1);
    releaseLegacy([]);
    await expect(snapshot).resolves.toEqual([]);
    await publishing;
    await expect(owner.snapshotRoots(11)).resolves.toEqual([
      { owner: "development-run", ownerId: "run-race", reason: "active", artifact: exact },
    ]);
  });

  it("serializes retirement with an in-progress root snapshot", async () => {
    const exact = artifact();
    let releaseLegacy!: (roots: readonly ExecutionRoot[]) => void;
    const legacyStarted = deferred<void>();
    const { owner } = await fixture({
      legacyRoots: () =>
        new Promise((resolve) => {
          releaseLegacy = resolve;
          legacyStarted.resolve(undefined);
        }),
    });
    await fs.mkdir(owner.runRoot("run-retire-race"), { recursive: true });
    await fs.writeFile(
      path.join(owner.runRoot("run-retire-race"), DEVELOPMENT_RUN_MARKER),
      JSON.stringify({ version: 1, runId: "run-retire-race", snapshotDigest: exact.buildKey })
    );

    const snapshot = owner.snapshotRoots(12);
    await legacyStarted.promise;
    const retirement = owner.retire("run-retire-race", exact.buildKey);
    releaseLegacy([]);
    await expect(snapshot).resolves.toEqual([]);
    await expect(retirement).resolves.toBeUndefined();
    await expect(owner.snapshotRoots(13)).resolves.toEqual([]);
  });
});
