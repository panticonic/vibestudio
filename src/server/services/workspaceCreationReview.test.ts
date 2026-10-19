import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isEntirelyHostBundledCreationReview,
  WorkspaceCreationReviewStore,
} from "./workspaceCreationReview.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "creation-review-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceCreationReviewStore", () => {
  it("is absent until a workspace is created, so boot asks nothing", () => {
    expect(new WorkspaceCreationReviewStore({ statePath: root }).isPending()).toBe(false);
  });

  it("carries the creation publication's obligation across a restart", () => {
    new WorkspaceCreationReviewStore({ statePath: root }).markPending({
      url: "https://github.com/panticonic/vibestudio",
      ref: "v1.4.0",
      version: "1.4.0",
    });

    const reopened = new WorkspaceCreationReviewStore({ statePath: root });
    expect(reopened.isPending()).toBe(true);
    expect(reopened.rootTemplate()?.version).toBe("1.4.0");
  });

  it("never asks again once the review resolves", () => {
    const store = new WorkspaceCreationReviewStore({ statePath: root });
    store.markPending();
    store.resolve();

    expect(store.isPending()).toBe(false);
    expect(new WorkspaceCreationReviewStore({ statePath: root }).isPending()).toBe(false);
  });

  it("keeps the original creation record when marked twice", () => {
    const store = new WorkspaceCreationReviewStore({ statePath: root });
    store.markPending({ url: "https://github.com/acme/studio", ref: "v2.1", version: "2.1" });
    store.markPending({ url: "https://example.invalid/other", ref: null, version: null });

    expect(store.rootTemplate()?.url).toBe("https://github.com/acme/studio");
  });
  it("does no authority or unit discovery on existing cold starts", async () => {
    const discover = vi.fn(async () => ({ units: ["panel"] }));
    const existing = new WorkspaceCreationReviewStore({ statePath: root });
    await expect(existing.prepareReview(discover)).resolves.toBeUndefined();
    expect(discover).not.toHaveBeenCalled();

    existing.markPending();
    const pendingRestart = new WorkspaceCreationReviewStore({ statePath: root });
    await expect(pendingRestart.prepareReview(discover)).resolves.toEqual({ units: ["panel"] });
    expect(discover).toHaveBeenCalledTimes(1);
    pendingRestart.resolve();
    await expect(
      new WorkspaceCreationReviewStore({ statePath: root }).prepareReview(discover)
    ).resolves.toBeUndefined();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe("isEntirelyHostBundledCreationReview", () => {
  it("accepts only a nonempty set whose every unit the host-build gate vouches for", () => {
    const shipped = new Set(["clients/desktop-browser"]);
    const isHostBuildUnit = (repoPath: string) => shipped.has(repoPath);
    const units = [{ source: { repo: "clients/desktop-browser" } }];
    expect(isEntirelyHostBundledCreationReview(units, isHostBuildUnit)).toBe(true);
    expect(
      isEntirelyHostBundledCreationReview(
        [...units, { source: { repo: "extensions/custom" } }],
        isHostBuildUnit
      )
    ).toBe(false);
    expect(isEntirelyHostBundledCreationReview(units, () => false)).toBe(false);
    expect(isEntirelyHostBundledCreationReview([], () => true)).toBe(false);
  });
});
