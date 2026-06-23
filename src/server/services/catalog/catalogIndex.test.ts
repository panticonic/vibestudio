import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createCatalogIndex } from "./catalogIndex.js";

const blobstore: ServiceDefinition = {
  name: "blobstore",
  description: "Content-addressable blob storage",
  policy: { allowed: ["panel", "worker", "do", "server"] },
  methods: {
    putText: {
      description: "Store a UTF-8 string and return its digest",
      args: z.tuple([z.string()]),
      returns: z.object({ digest: z.string() }),
    },
    "admin.wipe": {
      description: "Delete everything",
      args: z.tuple([]),
      policy: { allowed: ["server"] },
    },
  },
  handler: async () => undefined,
};

const load = () => ({ definitions: [blobstore] });

describe("createCatalogIndex", () => {
  it("ranks token-overlap hits and filters by caller", () => {
    const index = createCatalogIndex(load);
    const hits = index.search("store text digest", "panel");
    expect(hits[0]?.id).toBe("service:blobstore.putText");
    expect(hits.find((h) => h.id === "service:blobstore.admin.wipe")).toBeUndefined(); // server-only
    const serverHits = index.search("delete wipe", "server");
    expect(serverHits.find((h) => h.id === "service:blobstore.admin.wipe")).toBeTruthy();
  });

  it("get() respects caller visibility", () => {
    const index = createCatalogIndex(load);
    expect(index.get("service:blobstore.admin.wipe", "server")).toBeTruthy();
    expect(index.get("service:blobstore.admin.wipe", "panel")).toBeNull();
    expect(index.get("service:nope", "server")).toBeNull();
  });

  it("listSurfaces counts only visible entries", () => {
    const index = createCatalogIndex(load);
    const sp = index.listSurfaces("panel").find((s) => s.surface === "service")?.count ?? 0;
    const ss = index.listSurfaces("server").find((s) => s.surface === "service")?.count ?? 0;
    expect(ss).toBeGreaterThan(sp); // server additionally sees admin.wipe
  });

  it("picks up new definitions without explicit rebuild", () => {
    let defs: ServiceDefinition[] = [blobstore];
    const index = createCatalogIndex(() => ({ definitions: defs }));
    expect(index.get("service:demo2", "server")).toBeNull();
    defs = [
      ...defs,
      {
        name: "demo2",
        description: "d",
        policy: { allowed: ["server"] },
        methods: {},
        handler: async () => undefined,
      },
    ];
    expect(index.get("service:demo2", "server")).toBeTruthy();
  });

  it("picks up same-name definition replacements without explicit rebuild", () => {
    let defs: ServiceDefinition[] = [blobstore];
    const index = createCatalogIndex(() => ({ definitions: defs }));
    expect(index.get("service:blobstore.admin.wipe", "panel")).toBeNull();

    defs = [
      {
        ...blobstore,
        methods: {
          ...blobstore.methods,
          "admin.wipe": {
            description: "Delete everything, now panel-visible.",
            args: z.tuple([]),
            policy: { allowed: ["panel", "server"] },
          },
        },
      },
    ];

    const replacement = index.get("service:blobstore.admin.wipe", "panel");
    expect(replacement?.description).toBe("Delete everything, now panel-visible.");
  });
});
