import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type {
  ServiceContext,
  ServiceDispatcher,
  CallerKind,
} from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import type { CatalogEntry, CatalogHit } from "@vibestudio/shared/serviceSchemas/docs";
import { createDocsService } from "./docsService.js";

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
    "wire.handle": {
      description: "Internal wire method",
      args: z.tuple([]),
      docs: {
        visibility: "internal",
        preferred: "Use blobstore.putText instead.",
      },
    },
  },
  handler: async () => undefined,
};

const dispatcher = {
  getServiceDefinitions: () => [blobstore],
  getPolicy: (service: string) => (service === "blobstore" ? blobstore.policy : undefined),
  getMethodPolicy: (service: string, method: string) =>
    service === "blobstore" ? blobstore.methods[method]?.policy : undefined,
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

  it("hides internal docs from default search but allows explicit opt-in", async () => {
    const defaultHits = (await svc.handler(ctx("panel"), "search", [
      "wire internal",
      undefined,
    ])) as CatalogHit[];
    expect(defaultHits.find((h) => h.id === "service:blobstore.wire.handle")).toBeUndefined();

    const internalHits = (await svc.handler(ctx("panel"), "search", [
      "wire internal",
      { includeInternal: true },
    ])) as CatalogHit[];
    expect(internalHits.find((h) => h.id === "service:blobstore.wire.handle")).toBeTruthy();
  });

  it("describe returns null for hidden entries, the entry for allowed callers", async () => {
    expect(
      await svc.handler(ctx("panel"), "describe", ["service:blobstore.admin.wipe"])
    ).toBeNull();
    const entry = (await svc.handler(ctx("server"), "describe", [
      "service:blobstore.admin.wipe",
    ])) as CatalogEntry;
    expect(entry.qualifiedName).toBe("blobstore.admin.wipe");
    expect((entry.access as { callers?: string[] }).callers).toEqual(["server"]);
  });

  it("describe can open an exact internal entry with docs guidance", async () => {
    const entry = (await svc.handler(ctx("panel"), "describe", [
      "service:blobstore.wire.handle",
    ])) as CatalogEntry;
    expect(entry.qualifiedName).toBe("blobstore.wire.handle");
    expect(entry.docs).toMatchObject({
      visibility: "internal",
      preferred: "Use blobstore.putText instead.",
    });
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

  it("describeService omits internal methods from broad per-service docs", async () => {
    const def = (await svc.handler(ctx("panel"), "describeService", ["blobstore"])) as {
      methods: Record<string, unknown>;
    };

    expect(def.methods["putText"]).toBeTruthy();
    expect(def.methods["wire.handle"]).toBeUndefined();
  });

  it("search filters runtime entries to the caller's runtime target", async () => {
    const runtimeSvc = createDocsService({
      dispatcher,
      runtimeSurfaces: {
        panel: surface("panel", "panelOnly"),
        workerRuntime: surface("workerRuntime", "workerOnly"),
      },
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
});
