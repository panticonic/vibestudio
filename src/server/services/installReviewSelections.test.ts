import { describe, expect, it } from "vitest";
import { InstallReviewSelectionStore } from "./installReviewSelections.js";

describe("InstallReviewSelectionStore", () => {
  it("restores a leased selection when admission fails", () => {
    const store = new InstallReviewSelectionStore();
    store.record([["panels/news@ev-1", ["row:network"]]]);

    const first = store.leaseMany(["panels/news@ev-1"]);
    expect(first.selections.get("panels/news@ev-1")).toEqual(["row:network"]);
    first.failed();

    const retry = store.leaseMany(["panels/news@ev-1"]);
    expect(retry.selections.get("panels/news@ev-1")).toEqual(["row:network"]);
  });

  it("does not restore an older lease over a newer decision", () => {
    const store = new InstallReviewSelectionStore();
    store.record([["panels/news@ev-1", ["row:old"]]]);

    const old = store.leaseMany(["panels/news@ev-1"]);
    store.record([["panels/news@ev-1", ["row:new"]]]);
    old.failed();

    const current = store.leaseMany(["panels/news@ev-1"]);
    expect(current.selections.get("panels/news@ev-1")).toEqual(["row:new"]);
  });

  it("does not let an empty concurrent lease suppress the holder's rollback", () => {
    const store = new InstallReviewSelectionStore();
    store.record([["panels/news@ev-1", ["row:network"]]]);

    const holder = store.leaseMany(["panels/news@ev-1"]);
    const observer = store.leaseMany(["panels/news@ev-1"]);
    expect(observer.selections.size).toBe(0);

    observer.failed();
    holder.failed();

    const retry = store.leaseMany(["panels/news@ev-1"]);
    expect(retry.selections.get("panels/news@ev-1")).toEqual(["row:network"]);
  });

  it("consumes a selection permanently only after commit", () => {
    const store = new InstallReviewSelectionStore();
    store.record([["panels/news@ev-1", []]]);

    const lease = store.leaseMany(["panels/news@ev-1"]);
    lease.committed();

    expect(store.leaseMany(["panels/news@ev-1"]).selections.has("panels/news@ev-1")).toBe(false);
  });
});
