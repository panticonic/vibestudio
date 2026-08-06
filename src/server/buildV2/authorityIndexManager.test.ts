import { describe, expect, it, vi } from "vitest";
import { AuthorityIndexManager } from "./authorityIndexManager.js";
import type { AuthorityDependencyIndex } from "./authorityDependencyIndex.js";

function index(
  stateHash: string,
  epoch = { analyzerVersion: "a", rpcSchemaVersion: "s" }
): AuthorityDependencyIndex {
  return {
    stateHash,
    epoch,
    complete: true,
    consumerInputs: new Map(),
    providersByQuery: new Map(),
    consumersByQuery: new Map(),
    consumersByProviderUnit: new Map(),
    blockingConsumers: new Set(),
    digest: `digest:${stateHash}`,
  };
}

describe("authority index manager", () => {
  it("coalesces concurrent analysis for the same state and epoch", async () => {
    const manager = new AuthorityIndexManager();
    const expected = index("state:published");
    let resolve!: (value: AuthorityDependencyIndex) => void;
    const pending = new Promise<AuthorityDependencyIndex>((done) => {
      resolve = done;
    });
    const create = vi.fn(() => pending);

    const prewarm = manager.indexAt(expected.stateHash, expected.epoch, create);
    const publication = manager.indexAt(expected.stateHash, expected.epoch, create);

    expect(publication).toBe(prewarm);
    expect(create).toHaveBeenCalledTimes(1);
    resolve(expected);
    await expect(publication).resolves.toBe(expected);
  });

  it("does not retain a failed analysis flight", async () => {
    const manager = new AuthorityIndexManager();
    const expected = index("state:published");
    const create = vi
      .fn<() => Promise<AuthorityDependencyIndex>>()
      .mockRejectedValueOnce(new Error("cold analysis failed"))
      .mockResolvedValueOnce(expected);

    await expect(manager.indexAt(expected.stateHash, expected.epoch, create)).rejects.toThrow(
      "cold analysis failed"
    );
    await expect(manager.indexAt(expected.stateHash, expected.epoch, create)).resolves.toBe(
      expected
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("returns an incomplete attempt without retaining it for the same-state retry", async () => {
    const manager = new AuthorityIndexManager();
    const incomplete = {
      ...index("state:published"),
      complete: false,
      blockingConsumers: new Set(["@workspace-panels/broken"]),
    };
    const complete = index("state:published");
    const create = vi
      .fn<() => Promise<AuthorityDependencyIndex>>()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(complete);

    await expect(manager.indexAt(incomplete.stateHash, incomplete.epoch, create)).resolves.toBe(
      incomplete
    );
    await expect(manager.indexAt(complete.stateHash, complete.epoch, create)).resolves.toBe(
      complete
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("promotes only the exact staged candidate for the current epoch", () => {
    const manager = new AuthorityIndexManager();
    const candidate = index("state:candidate");
    manager.stageCandidate(candidate);
    expect(manager.promotePublished("state:other", candidate.epoch)).toBe(false);
    expect(manager.publishedBaseline(candidate.epoch)).toBeNull();
    expect(manager.promotePublished(candidate.stateHash, candidate.epoch)).toBe(true);
    expect(manager.publishedBaseline(candidate.epoch)?.stateHash).toBe("state:candidate");
  });
});
