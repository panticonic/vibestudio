import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import { describe, expect, it, vi } from "vitest";
import type { TemplatesClient, TemplateUpdateReview } from "@vibestudio/service-schemas/templates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  reconcileWorkspaceLaunchUpdates,
  type WorkspaceLaunchUpdateReceipt,
} from "./workspaceLaunchUpdates.js";

type Installed = Awaited<ReturnType<TemplatesClient["installed"]>>[number];
const pin = (name: string, version: string): WorkspaceTemplatePin => ({
  url: `git+https://example.test/${name}.git`,
  ref: "refs/heads/main",
  commit: version.repeat(40),
});
const systemA = pin("system", "a");
const systemB = pin("system", "b");
const baseA = pin("base", "c");
const baseB = pin("base", "d");
const installed = (
  pin: WorkspaceTemplatePin,
  relationship: Installed["relationship"],
  dependencies: Installed["dependencies"] = []
): Installed => ({
  pin,
  repositories: [],
  dependencies,
  relationship,
});
const conflict: TemplateUpdateReview["conflicts"][number] = {
  deltaId: "delta:one",
  repoPath: "clients/desktop-browser",
  coordinate: {
    coordinate: { kind: "file", id: "file:titlebar", paths: { ours: "TitleBar.tsx" } },
    status: "conflict",
    aspects: [
      { aspect: "content", base: "old", ours: "local", theirs: "incoming", status: "conflict" },
    ],
    attribution: { ours: [], theirs: [] },
    resolutions: ["ours", "theirs"],
    summary: "Local and incoming titlebar edits differ",
  },
};

function harness(
  initial = [installed(systemA, "direct", [{ url: baseA.url }]), installed(baseA, "transitive")]
) {
  let inventory = initial;
  let mainEventId = "main:one";
  let publication = 0;
  const mainState = vi.fn(async () => ({ eventId: mainEventId }));
  const reviews = new Map<string, TemplateUpdateReview>();
  const receipts: WorkspaceLaunchUpdateReceipt[] = [];
  const readInstalled = vi.fn(async () => inventory);
  const prepareUpdate = vi.fn(async (request: Parameters<TemplatesClient["prepareUpdate"]>[0]) => {
    const previous = reviews.get(request.commandId);
    if (previous) return previous;
    const review: TemplateUpdateReview = {
      operationId: request.commandId,
      contextId: `context:${request.commandId}`,
      sourceUrl: request.sourceUrl,
      target: request.target!,
      mainEventId,
      status: "review",
      repositories: [{ repoPath: "clients/desktop-browser", kind: "changed" }],
      conflicts: [],
    };
    reviews.set(request.commandId, review);
    return review;
  });
  const publishUpdate = vi.fn(async ({ operationId }: { operationId: string }) => {
    const review = reviews.get(operationId)!;
    inventory = inventory.map((source) =>
      normalizeTemplateGitUrl(source.pin.url) === normalizeTemplateGitUrl(review.target.url)
        ? { ...source, pin: review.target }
        : source
    );
    mainEventId = `main:published-${++publication}`;
    const published = { ...review, status: "published" as const };
    reviews.set(operationId, published);
    return published;
  });
  const client = {
    installed: readInstalled,
    prepareUpdate,
    publishUpdate,
  } as unknown as TemplatesClient;
  const reconcile = (targets = [systemB, baseB]) =>
    reconcileWorkspaceLaunchUpdates({
      client,
      mainState,
      targets,
      log: (receipt) => receipts.push(receipt),
    });
  return {
    client,
    prepareUpdate,
    publishUpdate,
    readInstalled,
    mainState,
    setMainEventId: (eventId: string) => {
      mainEventId = eventId;
    },
    receipts,
    reconcile,
    inventory: () => inventory,
    setInventory: (next: Installed[]) => {
      inventory = next;
    },
    reviews,
  };
}

describe("retained workspace updates during product launch", () => {
  it("publishes the exact root target and leaves dependency selection to that root", async () => {
    const t = harness();
    const publish = t.publishUpdate.getMockImplementation()!;
    t.publishUpdate.mockImplementation(async (request) => {
      const result = await publish(request);
      t.setInventory(
        t
          .inventory()
          .map((source) => (source.pin.url === baseA.url ? installed(baseB, "transitive") : source))
      );
      return result;
    });
    const results = await t.reconcile([baseB, systemB]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.prepareUpdate).toHaveBeenCalledWith({
      commandId: expect.any(String),
      sourceUrl: systemA.url,
      target: systemB,
    });
    expect(results).toEqual([
      expect.objectContaining({
        sourceUrl: systemA.url,
        prior: systemA,
        target: systemB,
        status: "published",
      }),
    ]);
    expect(t.inventory().find((source) => source.pin.url === baseA.url)?.pin).toEqual(baseB);
    expect(t.receipts).toEqual([
      expect.objectContaining({
        status: "published",
        sourceUrl: systemA.url,
        fromCommit: systemA.commit,
        toCommit: systemB.commit,
      }),
      expect.objectContaining({
        status: "published",
        sourceUrl: baseA.url,
        fromCommit: baseA.commit,
        toCommit: baseB.commit,
      }),
      { status: "current", sourceUrl: baseB.url, fromCommit: baseB.commit, toCommit: baseB.commit },
    ]);
  });

  it("reports current state without republishing on the next launch", async () => {
    const t = harness();
    await t.reconcile([systemB]);
    expect(await t.reconcile([systemB])).toEqual([]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.publishUpdate).toHaveBeenCalledTimes(1);
    expect(t.receipts.at(-1)).toEqual({
      status: "current",
      sourceUrl: systemB.url,
      fromCommit: systemB.commit,
      toCommit: systemB.commit,
    });
  });

  it("retains the same staged conflict across launches without advancing any source", async () => {
    const personalA = pin("personal", "e");
    const personalB = pin("personal", "f");
    const t = harness([installed(systemA, "upstream"), installed(personalA, "direct")]);
    const prepare = t.prepareUpdate.getMockImplementation()!;
    t.prepareUpdate.mockImplementation(async (request) => {
      const review = await prepare(request);
      review.conflicts = [conflict];
      return review;
    });
    const first = await t.reconcile([personalB, systemB]);
    const again = await t.reconcile([personalB, systemB]);
    expect(first[0]?.status).toBe("conflicts");
    expect(again[0]?.operationId).toBe(first[0]?.operationId);
    expect(t.publishUpdate).not.toHaveBeenCalled();
    expect(t.prepareUpdate.mock.calls.map(([request]) => request.target)).toEqual([
      systemB,
      systemB,
    ]);
    expect(t.inventory().map((source) => source.pin)).toEqual([systemA, personalA]);
    expect(t.receipts.map((receipt) => receipt.status)).toEqual(["conflicts", "conflicts"]);
  });

  it("rereads provenance after a root updates another installed root's dependency", async () => {
    const t = harness([
      installed(systemA, "upstream", [{ url: baseA.url }]),
      installed(baseA, "direct"),
    ]);
    const publish = t.publishUpdate.getMockImplementation()!;
    t.publishUpdate.mockImplementation(async (request) => {
      const result = await publish(request);
      t.setInventory(
        t
          .inventory()
          .map((source) => (source.pin.url === baseA.url ? installed(baseB, "transitive") : source))
      );
      return result;
    });
    await t.reconcile([baseB, systemB]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.inventory().map((source) => source.pin)).toEqual([systemB, baseB]);
  });

  it("normalizes source URL spellings and ignores targets absent from the workspace", async () => {
    const t = harness();
    await t.reconcile([
      { ...systemB, url: "https://example.test/system.git" },
      pin("uninstalled", "e"),
    ]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.prepareUpdate.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: systemA.url,
      target: { commit: systemB.commit },
    });
  });

  it("rejects ambiguous product targets before touching workspace source", async () => {
    const t = harness();
    await expect(t.reconcile([systemB, { ...systemB, ref: "refs/tags/v2" }])).rejects.toThrow(
      "conflicting target snapshots"
    );
    expect(t.readInstalled).not.toHaveBeenCalled();
    expect(t.prepareUpdate).not.toHaveBeenCalled();
  });

  it.each(["read", "baseline", "prepare", "publish"] as const)(
    "propagates the original %s failure",
    async (phase) => {
      const t = harness();
      const failure = new Error(`${phase} failed`);
      if (phase === "read") t.readInstalled.mockRejectedValue(failure);
      if (phase === "baseline") t.mainState.mockRejectedValue(failure);
      if (phase === "prepare") t.prepareUpdate.mockRejectedValue(failure);
      if (phase === "publish") t.publishUpdate.mockRejectedValue(failure);
      await expect(t.reconcile()).rejects.toBe(failure);
      expect(t.receipts).toEqual([]);
    }
  );

  it("records a publication before a later source's failure propagates", async () => {
    const t = harness([installed(systemA, "direct"), installed(baseA, "direct")]);
    const failure = new Error("Base prepare failed");
    const prepare = t.prepareUpdate.getMockImplementation()!;
    t.prepareUpdate.mockImplementation(async (request) =>
      request.sourceUrl === normalizeTemplateGitUrl(baseA.url)
        ? Promise.reject(failure)
        : prepare(request)
    );
    await expect(t.reconcile([systemB, baseB])).rejects.toBe(failure);
    expect(t.inventory().map((source) => source.pin)).toEqual([systemB, baseA]);
    expect(t.receipts).toEqual([
      expect.objectContaining({
        status: "published",
        sourceUrl: normalizeTemplateGitUrl(systemA.url),
        fromCommit: systemA.commit,
        toCommit: systemB.commit,
      }),
    ]);
  });

  it("verifies installed provenance instead of trusting a published response", async () => {
    const t = harness();
    t.publishUpdate.mockImplementation(async ({ operationId }) => ({
      ...t.reviews.get(operationId)!,
      status: "published" as const,
    }));
    await expect(t.reconcile([systemB])).rejects.toThrow("returned published but installed");
    expect(t.receipts).toEqual([]);
  });

  it("uses the new main baseline for an A to B to A to B source cycle", async () => {
    const t = harness();
    await t.reconcile([systemB]);
    await t.reconcile([systemA]);
    await t.reconcile([systemB]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(3);
    const ids = t.prepareUpdate.mock.calls.map(([request]) => request.commandId);
    expect(new Set(ids).size).toBe(3);
    expect(t.publishUpdate).toHaveBeenCalledTimes(3);
    expect(t.inventory()[0]?.pin).toEqual(systemB);
  });

  it("refuses a replayed published operation from another main baseline", async () => {
    const t = harness();
    const [first] = await t.reconcile([systemB]);
    t.setInventory([installed(systemA, "direct")]);
    t.prepareUpdate.mockResolvedValue(first!.review);
    await expect(t.reconcile([systemB])).rejects.toThrow("the observed launch baseline");
    expect(t.publishUpdate).toHaveBeenCalledTimes(1);
  });

  it("prepares a new review when local main advances after a staged conflict", async () => {
    const t = harness();
    const prepare = t.prepareUpdate.getMockImplementation()!;
    t.prepareUpdate.mockImplementation(async (request) => {
      const review = await prepare(request);
      review.conflicts = [conflict];
      return review;
    });
    const [first] = await t.reconcile([systemB]);
    t.setMainEventId("main:local-edit");
    const [next] = await t.reconcile([systemB]);
    expect(first?.operationId).not.toBe(next?.operationId);
    expect(next?.review.mainEventId).toBe("main:local-edit");
    expect(t.publishUpdate).not.toHaveBeenCalled();
    expect(t.reviews.size).toBe(2);
  });

  it("refuses to publish if main changes between observing the baseline and preparing", async () => {
    const t = harness();
    const prepare = t.prepareUpdate.getMockImplementation()!;
    t.prepareUpdate.mockImplementation(async (request) => {
      t.setMainEventId("main:concurrent-edit");
      return prepare(request);
    });
    await expect(t.reconcile([systemB])).rejects.toThrow(
      "the observed launch baseline was main:one"
    );
    expect(t.publishUpdate).not.toHaveBeenCalled();
    expect(t.receipts).toEqual([]);
  });

  it("recognizes an already adopted source after a publication response is lost", async () => {
    const t = harness();
    const failure = new Error("Publication response lost");
    const publish = t.publishUpdate.getMockImplementation()!;
    t.publishUpdate.mockImplementation(async (request) => {
      await publish(request);
      throw failure;
    });
    await expect(t.reconcile([systemB])).rejects.toBe(failure);
    expect(await t.reconcile([systemB])).toEqual([]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.publishUpdate).toHaveBeenCalledTimes(1);
    expect(t.receipts).toEqual([
      {
        status: "current",
        sourceUrl: systemB.url,
        fromCommit: systemB.commit,
        toCommit: systemB.commit,
      },
    ]);
  });

  it("updates a floating Base dependency when its System root pin has not changed", async () => {
    const t = harness();
    const results = await t.reconcile([baseB, systemA]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.prepareUpdate.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: baseA.url,
      target: baseB,
    });
    expect(results[0]).toMatchObject({ sourceUrl: baseA.url, status: "published" });
    expect(t.inventory().map((source) => source.pin)).toEqual([systemA, baseB]);
    expect(t.receipts).toEqual([
      {
        status: "current",
        sourceUrl: systemA.url,
        fromCommit: systemA.commit,
        toCommit: systemA.commit,
      },
      expect.objectContaining({
        status: "published",
        sourceUrl: baseA.url,
        fromCommit: baseA.commit,
        toCommit: baseB.commit,
      }),
    ]);
  });

  it("retains an explicit Base commit even when the product follows a newer one", async () => {
    const t = harness([
      installed(systemA, "direct", [{ url: baseA.url, commit: baseA.commit }]),
      installed(baseA, "transitive"),
    ]);
    expect(await t.reconcile([baseB, systemA])).toEqual([]);
    expect(t.prepareUpdate).not.toHaveBeenCalled();
    expect(t.inventory().map((source) => source.pin)).toEqual([systemA, baseA]);
  });

  it("uses a changed parent's incoming fixed dependency before considering Base", async () => {
    const t = harness();
    const publish = t.publishUpdate.getMockImplementation()!;
    t.publishUpdate.mockImplementation(async (request) => {
      const result = await publish(request);
      t.setInventory(
        t
          .inventory()
          .map((source) =>
            source.pin.url === systemB.url
              ? installed(systemB, "direct", [{ url: baseA.url, commit: baseA.commit }])
              : source
          )
      );
      return result;
    });
    await t.reconcile([baseB, systemB]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.prepareUpdate.mock.calls[0]?.[0].sourceUrl).toBe(systemA.url);
    expect(t.inventory().map((source) => source.pin)).toEqual([systemB, baseA]);
  });

  it("updates a floating dependency beneath a fixed parent without changing that parent", async () => {
    const commonA = pin("common", "e");
    const commonB = pin("common", "f");
    const t = harness([
      installed(systemA, "direct", [{ url: baseA.url, commit: baseA.commit }]),
      installed(baseA, "transitive", [{ url: commonA.url }]),
      installed(commonA, "transitive"),
    ]);
    await t.reconcile([commonB, baseB, systemA]);
    expect(t.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(t.prepareUpdate.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: commonA.url,
      target: commonB,
    });
    expect(t.inventory().map((source) => source.pin)).toEqual([systemA, baseA, commonB]);
  });
});
