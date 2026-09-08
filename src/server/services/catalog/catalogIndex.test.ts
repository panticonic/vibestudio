import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createCatalogIndex } from "./catalogIndex.js";
import type { BuildCatalogDeps } from "./buildCatalog.js";

const TEST_OPEN_TIER = {
  tier: "open" as const,
  session: "family" as const,
  rationale: "Explicit catalog fixture",
};

const blobstore: ServiceDefinition = {
  name: "blobstore",
  description: "Content-addressable blob storage",
  authority: { principals: ["code", "host"] },
  methods: {
    putText: {
      website: {
        kind: "eligible",
        rationale: "Explicit receiver policy for this test fixture.",
      } as const,
      description: "Store a UTF-8 string and return its digest",
      args: z.tuple([z.string()]),
      returns: z.object({ digest: z.string() }),
      tier: TEST_OPEN_TIER,
    },
    "admin.wipe": {
      website: {
        kind: "eligible",
        rationale: "Explicit receiver policy for this test fixture.",
      } as const,
      description: "Delete everything",
      args: z.tuple([]),
      authority: { principals: ["host"] },
      tier: TEST_OPEN_TIER,
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

  it("opens service roots with only the caller-visible child methods", () => {
    const index = createCatalogIndex(load);
    expect(index.get("service:blobstore", "panel")?.members).toEqual(["blobstore.putText"]);
    expect(index.get("service:blobstore", "server")?.members).toEqual([
      "blobstore.admin.wipe",
      "blobstore.putText",
    ]);
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
        authority: { principals: ["host"] },
        methods: {
          ping: {
            website: {
              kind: "eligible",
              rationale: "Explicit receiver policy for this test fixture.",
            },
            args: z.tuple([]),
            tier: TEST_OPEN_TIER,
          },
        } as const,
        handler: async () => undefined,
      },
    ];
    expect(index.get("service:demo2", "server")).toBeTruthy();
  });

  it("picks up workspace capability changes from the live declaration source", () => {
    let workspaceCapabilities: NonNullable<BuildCatalogDeps["workspaceCapabilities"]> = [];
    const index = createCatalogIndex(() => ({
      ...load(),
      workspaceCapabilities,
    }));
    expect(index.get("workspace:notes", "worker")).toBeNull();
    workspaceCapabilities = [
      {
        name: "notes",
        source: "workers/notes",
        protocols: ["notes.v1"],
        principals: ["code"],
        target: { kind: "worker", routePath: "/rpc" },
      },
    ];
    expect(index.get("workspace:notes", "worker")).toMatchObject({
      access: { capability: "workspace-service:notes" },
    });
  });

  it("caps oversized direct search requests instead of rejecting discovery", () => {
    const index = createCatalogIndex(load);
    expect(index.search("", "server", { limit: 200 })).toHaveLength(3);
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
            website: {
              kind: "eligible",
              rationale: "Explicit receiver policy for this test fixture.",
            } as const,
            description: "Delete everything, now panel-visible.",
            args: z.tuple([]),
            authority: { principals: ["code", "host"] },
            tier: TEST_OPEN_TIER,
          },
        },
      },
    ];

    const replacement = index.get("service:blobstore.admin.wipe", "panel");
    expect(replacement?.description).toBe("Delete everything, now panel-visible.");
  });
});

describe("website receiver discovery", () => {
  it("projects the exact reviewed methods and removes closed names from the parent", () => {
    const methods: NonNullable<
      NonNullable<BuildCatalogDeps["workspaceCapabilities"]>[number]["methods"]
    > = [
      {
        name: "summarize",
        signature: "summarize(text: string): string",
        website: { kind: "eligible", rationale: "Returns only a result for the submitted text." },
      },
      {
        name: "history",
        signature: "history(): string[]",
        website: { kind: "closed", reason: "Private receiver history." },
      },
    ];
    const index = createCatalogIndex(() => ({
      definitions: [],
      workspaceCapabilities: [
        {
          name: "notes",
          source: "workers/notes",
          protocols: [],
          principals: ["code", "website"],
          target: { kind: "durable-object", className: "Notes", defaultObjectKey: "main" },
          methods,
        },
      ],
    }));
    expect(index.get("workspace:notes", "website")?.members).toEqual(["summarize"]);
    expect(index.get("workspace:notes.history", "website")).toBeNull();
    expect(index.get("workspace:notes.summarize", "website")?.access?.["website"]).toEqual(
      methods[0]!.website
    );
    expect(index.get("workspace:notes", "panel")?.members).toEqual(["history", "summarize"]);
  });
});
