import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { ExecutionPublicationJournal } from "./executionPublicationJournal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function artifact(buildKey = "b".repeat(64)): ExecutionArtifactRefV1 {
  const effectiveVersion = "e".repeat(64) as Sha256;
  const artifactDigest = "a".repeat(64) as Sha256;
  const contentRoots = [{ repoPath: "workers/example", stateHash: `state:${"c".repeat(64)}` }];
  const unsigned = {
    version: 1,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion,
      state: { kind: "event" as const, eventId: "event:test" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: buildKey as Sha256,
    buildKey: buildKey as Sha256,
    artifactDigest,
  } as const;
  return { ...unsigned, executionDigest: executionArtifactDigest(unsigned) };
}

function publication(ref: ExecutionArtifactRefV1) {
  return {
    owner: "runtime-entity" as const,
    ownerId: "entity:test",
    artifacts: [{ buildKey: ref.buildKey, executionDigest: ref.executionDigest }],
  };
}

describe("ExecutionPublicationJournal", () => {
  it("rejects a mismatched execution digest before the owner write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
    roots.push(root);
    const ref = artifact();
    const journal = new ExecutionPublicationJournal(root, () => ref);

    expect(() =>
      journal.reserve({
        ...publication(ref),
        artifacts: [{ buildKey: ref.buildKey, executionDigest: "f".repeat(64) }],
      })
    ).toThrow(/does not match stored build/);
    expect(journal.pendingPublicationCount()).toBe(0);
    journal.close();
  });

  it("resolves an artifact by both build key and execution digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
    roots.push(root);
    const ref = artifact();
    const observed: Array<[string, string]> = [];
    const journal = new ExecutionPublicationJournal(root, (buildKey, executionDigest) => {
      observed.push([buildKey, executionDigest]);
      return ref;
    });

    const reservation = journal.reserve(publication(ref));
    expect(observed).toEqual([[ref.buildKey, ref.executionDigest]]);
    journal.finalize(reservation);
    journal.close();
  });

  it("serializes a final deletion check with publication reservations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
    roots.push(root);
    const ref = artifact();
    let available = true;
    const journal = new ExecutionPublicationJournal(root, () => (available ? ref : null));
    const epoch = journal.beginEpoch();
    const reservation = journal.reserve(publication(ref));

    expect(journal.commitArtifactDeletion(epoch, ref.buildKey, () => (available = false))).toBe(
      false
    );
    journal.finalize(reservation);
    journal.completeEpoch(epoch + 1, new Set([ref.buildKey]));
    expect(journal.commitArtifactDeletion(epoch + 1, ref.buildKey, () => (available = false))).toBe(
      true
    );
    expect(() => journal.reserve(publication(ref))).toThrow(/missing execution artifact/);
    journal.close();
  });

  it("acquires the publication lock before resolving so delete cannot slip before insert", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
    roots.push(root);
    const ref = artifact();
    let deletionContended = false;
    const publisher = new ExecutionPublicationJournal(root, () => {
      expect(() => contender.beginEpoch()).toThrow(/locked|busy/i);
      expect(() =>
        contender.commitArtifactDeletion(0, ref.buildKey, () => {
          throw new Error("deletion must not run");
        })
      ).toThrow(/locked|busy/i);
      deletionContended = true;
      return ref;
    });
    const contender = new ExecutionPublicationJournal(root, () => ref, { busyTimeoutMs: 0 });

    const reservation = publisher.reserve(publication(ref));
    expect(deletionContended).toBe(true);
    expect(reservation.epoch).toBe(0);
    expect(publisher.protectedBuildKeys(0)).toContain(ref.buildKey);
    publisher.finalize(reservation);
    expect(contender.beginEpoch()).toBe(1);
    contender.close();
    publisher.close();
  });

  it("compacts finalized history so hot publication state stays bounded", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-journal-"));
    roots.push(root);
    const ref = artifact();
    const journal = new ExecutionPublicationJournal(root, () => ref);

    for (let index = 0; index < 500; index += 1) {
      const reservation = journal.reserve({
        ...publication(ref),
        ownerId: `entity:${index}`,
      });
      journal.finalize(reservation);
      const epoch = journal.beginEpoch();
      journal.completeEpoch(epoch, new Set([ref.buildKey]));
    }
    expect(journal.pendingPublicationCount()).toBe(0);
    journal.close();
  });
});
