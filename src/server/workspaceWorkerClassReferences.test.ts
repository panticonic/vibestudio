import { describe, expect, it } from "vitest";
import {
  newlyReferencedWorkerSources,
  workspaceWorkerClassReferences,
} from "./workspaceWorkerClassReferences.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";

describe("workspace worker class references", () => {
  it("joins singleton, service, and route class references by source", () => {
    expect(
      workspaceWorkerClassReferences({
        singletons: new SingletonRegistry([
          { source: "workers/store", className: "Store", key: "main" },
        ]),
        services: [
          {
            name: "store",
            source: "workers/store",
            durableObject: { className: "Store" },
            action: "manage stored data",
            presentation: { domain: "files", verb: "manage" },
            authority: { principals: [] },
          },
        ],
        routes: [
          { path: "/other", source: "workers/store", durableObject: { className: "Other" } },
        ],
      })
    ).toEqual(new Map([["workers/store", new Set(["Store", "Other"])]]));
  });

  it("does not invalidate unchanged or removed references", () => {
    const published = new Map([
      ["workers/store", new Set(["Store", "Other"])],
      ["workers/removed", new Set(["Removed"])],
    ]);
    expect(
      newlyReferencedWorkerSources(published, new Map([["workers/store", new Set(["Store"])]]))
    ).toEqual([]);
  });

  it("checks newly declared classes and retargeted sources", () => {
    expect(
      newlyReferencedWorkerSources(
        new Map([["workers/store", new Set(["Store"])]]),
        new Map([
          ["workers/store", new Set(["Store", "Added"])],
          ["workers/retargeted", new Set(["Store"])],
        ])
      )
    ).toEqual(["workers/store", "workers/retargeted"]);
  });
});
