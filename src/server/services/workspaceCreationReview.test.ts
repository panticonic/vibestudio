import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceCreationReviewStore } from "./workspaceCreationReview.js";

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
});
