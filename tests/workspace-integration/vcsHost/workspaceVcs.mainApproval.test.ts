/**
 * Protected-main integration at its real host boundary.
 *
 * Main advancement is one atomic content compare-and-swap guarded by an
 * injected approval function. These tests deliberately exercise that
 * primitive directly: no repository-local history, staging area, or
 * host-orchestrated edit workflow is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createProtectedRefStore,
  type RefGate,
  type RefGateBatch,
} from "../../../src/server/services/protectedRefStore.js";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";

const STATE_A = `state:${"a".repeat(64)}`;
const STATE_B = `state:${"b".repeat(64)}`;
const EVENT_GENESIS = "event:genesis";
const EVENT_A = "event:published:a";
const EVENT_B = "event:published:b";
const REPO = "packages/approval";
const EMPTY_BASIS = hostRefBasisDigest([]);
const A_BASIS = hostRefBasisDigest([{ repoPath: REPO, contentRoot: STATE_A }]);

describe("protected main ref approval and compare-and-swap", () => {
  let root: string;
  let gate: RefGate;
  let observed: RefGateBatch[];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "protected-main-"));
    gate = async () => {};
    observed = [];
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function makeStore() {
    return createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async (batch) => {
        observed.push(batch);
        await gate(batch);
      },
    });
  }

  it("keeps reads lock-free while approval holds the write compare-and-swap", async () => {
    const refs = makeStore();
    await refs.updateMains({
      entries: [{ repoPath: REPO, expectedOld: null, next: STATE_A }],
      evidence: {
        publicationId: "test:seed:1",
        previousEventId: EVENT_GENESIS,
        publishedEventId: EVENT_A,
        hostRefsBasisDigest: EMPTY_BASIS,
      },
      gateContext: { kind: "workspace-initialization" },
    });

    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    gate = async () => {
      approvalStarted();
      await approval;
    };

    const advancing = refs.updateMains({
      entries: [{ repoPath: REPO, expectedOld: STATE_A, next: STATE_B }],
      evidence: {
        publicationId: "test:publish:1",
        previousEventId: EVENT_A,
        publishedEventId: EVENT_B,
        hostRefsBasisDigest: A_BASIS,
      },
      gateContext: { kind: "caller", id: "agent-1" },
    });
    await started;

    expect(refs.readMain(REPO)?.contentRoot).toBe(STATE_A);
    releaseApproval();
    await advancing;
    expect(refs.readMain(REPO)?.contentRoot).toBe(STATE_B);
  });

  it("passes the resolved CAS pair to the gate and commits nothing when approval rejects", async () => {
    const refs = makeStore();
    await refs.updateMains({
      entries: [{ repoPath: REPO, expectedOld: null, next: STATE_A }],
      evidence: {
        publicationId: "test:seed:2",
        previousEventId: EVENT_GENESIS,
        publishedEventId: EVENT_A,
        hostRefsBasisDigest: EMPTY_BASIS,
      },
      gateContext: { kind: "workspace-initialization" },
    });
    observed = [];
    gate = async () => {
      throw new Error("approval denied");
    };

    await expect(
      refs.updateMains({
        entries: [{ repoPath: REPO, expectedOld: STATE_A, next: STATE_B }],
        evidence: {
          publicationId: "test:publish:2",
          previousEventId: EVENT_A,
          publishedEventId: EVENT_B,
          hostRefsBasisDigest: A_BASIS,
        },
        gateContext: { kind: "caller", id: "agent-1" },
      })
    ).rejects.toThrow("approval denied");

    expect(observed).toEqual([
      {
        entries: [{ repoPath: REPO, old: STATE_A, next: STATE_B }],
        publication: {
          publicationId: "test:publish:2",
          previousEventId: EVENT_A,
          publishedEventId: EVENT_B,
        },
        gateContext: { kind: "caller", id: "agent-1" },
      },
    ]);
    expect(refs.readMain(REPO)?.contentRoot).toBe(STATE_A);
  });
});
