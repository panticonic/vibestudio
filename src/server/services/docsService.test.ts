import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type {
  ServiceContext,
  ServiceDispatcher,
  CallerKind,
} from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import type { CatalogEntry, CatalogHit } from "@vibestudio/service-schemas/docs";
import { createDocsService } from "./docsService.js";

const TEST_WORKSPACE_SERVICE_PRESENTATION = {
  action: "use the test service",
  presentation: { domain: "automation" as const, verb: "act" as const },
};

const blobstore: ServiceDefinition = {
  name: "blobstore",
  description: "Content-addressable blob storage",
  authority: { principals: ["code", "host"] },
  methods: {
    putText: {
      description: "Store a UTF-8 string and return its digest",
      args: z.tuple([z.string()]),
      returns: z.object({ digest: z.string() }),
    },
    "admin.wipe": {
      description: "Delete everything",
      args: z.tuple([]),
      authority: { principals: ["host"] },
    },
    internalTransport: {
      description: "Internal transport that has a higher-level runtime API",
      args: z.tuple([]),
      agentFacing: false,
    },
  },
  handler: async () => undefined,
};

const dispatcher = {
  getServiceDefinitions: () => [blobstore],
  getPolicy: (service: string) => (service === blobstore.name ? blobstore.authority : undefined),
  getMethodPolicy: (service: string, method: string) =>
    service === blobstore.name ? blobstore.methods[method]?.authority : undefined,
} as unknown as ServiceDispatcher;
const emptySurface = (target: "panel" | "workerRuntime"): RuntimeSurface => ({
  target,
  description: "",
  exports: {},
});
const surface = (target: "panel" | "workerRuntime", name: string): RuntimeSurface => ({
  target,
  description: `${target} runtime`,
  exports: { [name]: { kind: "namespace", members: ["x"] } },
});
const svc = createDocsService({
  dispatcher,
  runtimeSurfaces: { panel: emptySurface("panel"), workerRuntime: emptySurface("workerRuntime") },
  tierLookup: (method) =>
    method.startsWith("blobstore.")
      ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
      : null,
});

const ctx = (kind: CallerKind): ServiceContext =>
  ({ caller: { runtime: { id: "test", kind } } }) as ServiceContext;

describe("docs service (caller-aware)", () => {
  it("search hides methods the caller cannot invoke", async () => {
    const panelHits = (await svc.handler(ctx("panel"), "search", [
      "wipe delete",
      undefined,
    ])) as CatalogHit[];
    expect(panelHits.find((h) => h.id === "service:blobstore.admin.wipe")).toBeUndefined();
    const serverHits = (await svc.handler(ctx("server"), "search", [
      "wipe delete",
      undefined,
    ])) as CatalogHit[];
    expect(serverHits.find((h) => h.id === "service:blobstore.admin.wipe")).toBeTruthy();
  });

  it("omits transport-only methods from all agent-facing discovery views", async () => {
    const hits = (await svc.handler(ctx("server"), "search", [
      "internal transport",
      undefined,
    ])) as CatalogHit[];
    expect(hits.find((hit) => hit.id === "service:blobstore.internalTransport")).toBeUndefined();

    const listed = (await svc.handler(ctx("server"), "listServices", [])) as Array<{
      name: string;
      methods: Record<string, unknown>;
    }>;
    expect(listed.find((service) => service.name === "blobstore")?.methods).not.toHaveProperty(
      "internalTransport"
    );

    const described = (await svc.handler(ctx("server"), "describeService", ["blobstore"])) as {
      methods: Record<string, unknown>;
    };
    expect(described.methods).not.toHaveProperty("internalTransport");
  });

  it("describe returns null for hidden entries, the entry for allowed callers", async () => {
    expect(
      await svc.handler(ctx("panel"), "describe", ["service:blobstore.admin.wipe"])
    ).toBeNull();
    const entry = (await svc.handler(ctx("server"), "describe", [
      "service:blobstore.admin.wipe",
    ])) as CatalogEntry;
    expect(entry.qualifiedName).toBe("blobstore.admin.wipe");
    expect((entry.access as { principals?: string[] }).principals).toEqual(["host"]);
  });

  it("getSchema returns args/returns JSON Schema for visible methods", async () => {
    const schema = (await svc.handler(ctx("panel"), "getSchema", [
      "service:blobstore.putText",
    ])) as {
      argsSchema?: unknown;
      returnsSchema?: unknown;
    };
    expect(schema.argsSchema).toBeTruthy();
    expect(schema.returnsSchema).toBeTruthy();
    expect(
      await svc.handler(ctx("panel"), "getSchema", ["service:blobstore.admin.wipe"])
    ).toBeNull();
  });

  it("listSurfaces reflects caller visibility", async () => {
    const surfaces = (await svc.handler(ctx("server"), "listSurfaces", [])) as Array<{
      surface: string;
      count: number;
    }>;
    expect(surfaces.find((s) => s.surface === "service")?.count).toBeGreaterThan(0);
  });

  it("search filters runtime entries to the caller's runtime target", async () => {
    const runtimeSvc = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: surface("panel", "panelOnly"),
        workerRuntime: surface("workerRuntime", "workerOnly"),
      },
      tierLookup: (method) =>
        method.startsWith("blobstore.")
          ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
          : null,
    });

    const panelHits = (await runtimeSvc.handler(ctx("panel"), "search", [
      "",
      { surface: "runtime" },
    ])) as CatalogHit[];
    expect(panelHits.map((h) => h.id)).toEqual(["runtime:panel.panelOnly"]);

    const workerHits = (await runtimeSvc.handler(ctx("worker"), "search", [
      "",
      { surface: "runtime" },
    ])) as CatalogHit[];
    expect(workerHits.map((h) => h.id)).toEqual(["runtime:workerRuntime.workerOnly"]);

    const extensionHits = (await runtimeSvc.handler(ctx("extension"), "search", [
      "",
      { surface: "runtime" },
    ])) as CatalogHit[];
    expect(extensionHits).toEqual([]);
  });

  it("does not couple stable service/runtime docs to live workspace builds", async () => {
    let workspaceLoads = 0;
    const partitioned = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: surface("panel", "panelOnly"),
        workerRuntime: surface("workerRuntime", "workerOnly"),
      },
      workspaceServicesForCaller: () => {
        workspaceLoads += 1;
        throw new Error("workspace provider build must not run for stable docs");
      },
      tierLookup: (method) =>
        method.startsWith("blobstore.")
          ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
          : null,
    });

    expect(
      await partitioned.handler(ctx("worker"), "describe", ["runtime:workerRuntime.workerOnly"])
    ).toMatchObject({ id: "runtime:workerRuntime.workerOnly" });
    expect(
      await partitioned.handler(ctx("worker"), "describe", ["service:blobstore.putText"])
    ).toMatchObject({ id: "service:blobstore.putText" });
    expect(
      await partitioned.handler(ctx("worker"), "search", ["worker runtime", { surface: "runtime" }])
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "runtime:workerRuntime.workerOnly" })])
    );
    expect(workspaceLoads).toBe(0);
  });

  it("discovers workspace service capabilities from the caller's live semantic context", async () => {
    const servicesByCaller = new Map<
      string,
      import("./docsService.js").LiveWorkspaceServiceDoc[]
    >();
    const dynamic = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: emptySurface("panel"),
        workerRuntime: emptySurface("workerRuntime"),
      },
      workspaceServicesForCaller: (callerCtx) =>
        servicesByCaller.get(callerCtx.caller.runtime.id) ?? [],
      tierLookup: (method) =>
        method.startsWith("blobstore.")
          ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
          : null,
    });
    const author = ctx("worker");
    author.caller.runtime.id = "worker:author";
    const other = ctx("worker");
    other.caller.runtime.id = "worker:other";
    expect(await dynamic.handler(author, "describe", ["workspace:notes"])).toBeNull();
    servicesByCaller.set("worker:author", [
      {
        providerEffectiveVersion: "a".repeat(64),
        methods: [
          {
            name: "getNote",
            signature: "getNote(id: string): Promise<string>",
            access: { tier: "open", sensitivity: "read", principals: ["code"] },
          },
        ],
        declaration: {
          source: "workers/notes",
          name: "notes",
          ...TEST_WORKSPACE_SERVICE_PRESENTATION,
          protocols: ["notes.v1"],
          authority: { principals: ["code"] },
          durableObject: { className: "NotesDO" },
        },
      },
    ]);
    expect(await dynamic.handler(author, "describe", ["workspace:notes"])).toMatchObject({
      surface: "workspace",
      access: { capability: "workspace-service:notes", source: "workers/notes" },
      members: ["getNote"],
    });
    expect(await dynamic.handler(author, "describe", ["workspace:notes.getNote"])).toMatchObject({
      signature: "getNote(id: string): Promise<string>",
      access: { providerEffectiveVersion: "a".repeat(64), receiver: { tier: "open" } },
    });
    expect(await dynamic.handler(other, "describe", ["workspace:notes"])).toBeNull();
  });

  it("keeps stable repair docs available while a workspace provider build is invalid", async () => {
    const reported: unknown[] = [];
    const repairing = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: emptySurface("panel"),
        workerRuntime: emptySurface("workerRuntime"),
      },
      workspaceServicesForCaller: () => {
        throw new Error("notes provider has an invalid RPC declaration");
      },
      reportWorkspaceDocsError: (error) => reported.push(error),
      tierLookup: (method) =>
        method.startsWith("blobstore.")
          ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
          : null,
    });

    const hits = (await repairing.handler(ctx("worker"), "search", [
      "store utf-8",
      undefined,
    ])) as CatalogHit[];
    expect(hits.some((hit) => hit.id === "service:blobstore.putText")).toBe(true);
    await repairing.handler(ctx("worker"), "search", ["store utf-8", undefined]);
    expect(reported).toHaveLength(1);
  });

  it("keeps an invalid provider declaration discoverable without inventing method docs", async () => {
    const dynamic = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: emptySurface("panel"),
        workerRuntime: emptySurface("workerRuntime"),
      },
      workspaceServicesForCaller: () => [
        {
          declaration: {
            source: "workers/notes",
            name: "notes",
            ...TEST_WORKSPACE_SERVICE_PRESENTATION,
            protocols: ["notes.v1"],
            authority: { principals: ["code"] },
            durableObject: { className: "NotesDO" },
          },
          providerBuildError: "reportValue must declare a literal RPC effect",
          methods: [],
        },
      ],
      tierLookup: (method) =>
        method.startsWith("blobstore.")
          ? { tier: "open", session: "family", rationale: "Explicit docs fixture" }
          : null,
    });

    const entry = await dynamic.handler(ctx("worker"), "describe", ["workspace:notes"]);
    expect(entry).toMatchObject({
      access: {
        availability: "build-error",
        providerBuildError: "reportValue must declare a literal RPC effect",
      },
    });
    expect(entry).not.toHaveProperty("members");
  });
});
