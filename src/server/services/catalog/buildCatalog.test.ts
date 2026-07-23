import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import type { CatalogEntry } from "@vibestudio/service-schemas/docs";
import { buildCatalog, isCatalogEntryVisible } from "./buildCatalog.js";
import { workerRuntimeSurface } from "@vibestudio/service-schemas/runtime/runtimeSurface.worker";

const testTierLookup = (method: string) =>
  method.startsWith("demo.")
    ? { tier: "open" as const, session: "family" as const, rationale: "Explicit catalog fixture" }
    : null;

const demo: ServiceDefinition = {
  name: "demo",
  description: "Demo service",
  authority: { principals: ["code", "host"] },
  methods: {
    get: {
      description: "Get a value.",
      args: z.tuple([z.string()]),
      returns: z.object({ v: z.number() }),
    },
    "admin.wipe": {
      description: "Destroy everything (server only).",
      args: z.tuple([]),
      authority: { principals: ["host"] },
    },
    probe: {
      description: "A probe method.",
      args: z.tuple([]),
      authority: { principals: ["code"] },
      access: { sensitivity: "read" },
    },
    internalTransport: {
      description: "Implementation detail.",
      args: z.tuple([]),
      agentFacing: false,
    },
  },
  handler: async () => undefined,
};

const panelSurface: RuntimeSurface = {
  target: "panel",
  description: "panel runtime",
  exports: {
    foo: { kind: "namespace", description: "Foo namespace", members: ["a", "b"] },
  },
};

const workerSurface: RuntimeSurface = {
  target: "workerRuntime",
  description: "worker runtime",
  exports: {
    bar: { kind: "namespace", description: "Bar namespace", members: ["run"] },
  },
};

function byId(entries: CatalogEntry[], id: string): CatalogEntry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`missing entry ${id}`);
  return e;
}

describe("buildCatalog", () => {
  const entries = buildCatalog({
    definitions: [demo],
    runtimeSurfaces: { panel: panelSurface, workerRuntime: workerSurface },
    tierLookup: testTierLookup,
  });

  it("emits a service parent + one entry per agent-facing method", () => {
    expect(byId(entries, "service:demo").surface).toBe("service");
    expect(byId(entries, "service:demo.get").parent).toBe("service:demo");
    expect(byId(entries, "service:demo.admin.wipe").qualifiedName).toBe("demo.admin.wipe");
    expect(entries.some((entry) => entry.id === "service:demo.internalTransport")).toBe(false);
  });

  it("discovers workspace-declared capabilities without a checked-in census", () => {
    const dynamic = buildCatalog({
      definitions: [],
      workspaceCapabilities: [
        {
          name: "example.notes",
          title: "Notes",
          description: "A workspace-local notes provider",
          source: "workers/notes",
          protocols: ["example.notes.v1"],
          principals: ["code"],
          target: { kind: "durable-object", className: "NotesDO" },
        },
      ],
    });
    expect(byId(dynamic, "workspace:example.notes")).toMatchObject({
      surface: "workspace",
      qualifiedName: "example.notes",
      access: {
        capability: "workspace-service:example.notes",
        principals: ["code"],
        source: "workers/notes",
        protocols: ["example.notes.v1"],
        target: { kind: "durable-object", className: "NotesDO" },
      },
    });
    expect(isCatalogEntryVisible(byId(dynamic, "workspace:example.notes"), "worker")).toBe(true);
    expect(isCatalogEntryVisible(byId(dynamic, "workspace:example.notes"), "server")).toBe(false);
  });

  it("omits a transport-only service parent when every method has a modern wrapper", () => {
    const transportOnly: ServiceDefinition = {
      name: "transportOnly",
      description: "Internal transport",
      authority: { principals: ["code"] },
      methods: {
        call: { args: z.tuple([]), agentFacing: false },
      },
      handler: async () => undefined,
    };
    const transportEntries = buildCatalog({ definitions: [transportOnly] });
    expect(transportEntries).toEqual([]);
  });

  it("projects hidden transport schemas under the modern runtime namespace", () => {
    const projected = buildCatalog({
      definitions: [demo],
      tierLookup: testTierLookup,
      runtimeSurfaces: {
        workerRuntime: {
          target: "workerRuntime",
          description: "worker runtime",
          exports: {
            modern: {
              kind: "namespace",
              members: ["internalTransport"],
              schemaRef: "demo",
            },
          },
        },
      },
    });

    expect(projected.some((entry) => entry.id === "service:demo.internalTransport")).toBe(false);
    const method = byId(projected, "runtime:workerRuntime.modern.internalTransport");
    expect(method).toMatchObject({
      surface: "runtime",
      qualifiedName: "modern.internalTransport",
      parent: "runtime:workerRuntime.modern",
      access: { callers: ["worker", "do"] },
    });
    expect(method.argsSchema).toBeTruthy();
    expect(byId(projected, "runtime:workerRuntime.modern").description).not.toContain(
      "service:demo"
    );
  });

  it("projects generated runtime method schemas without importing userland code", () => {
    const projected = buildCatalog({
      definitions: [],
      runtimeSurfaces: {
        workerRuntime: {
          target: "workerRuntime",
          description: "worker runtime",
          exports: {
            gad: {
              kind: "namespace",
              members: ["query"],
              methodCatalog: {
                query: {
                  description: "Run a parameterized query.",
                  access: { sensitivity: "read" },
                  argsSchema: { type: "array" },
                  returnsSchema: { type: "object" },
                },
              },
            },
          },
        },
      },
    });

    expect(byId(projected, "runtime:workerRuntime.gad.query")).toMatchObject({
      description: "Run a parameterized query.",
      access: { sensitivity: "read", callers: ["worker", "do"] },
      argsSchema: { type: "array" },
      returnsSchema: { type: "object" },
    });
    expect(byId(projected, "runtime:workerRuntime.gad").description).toContain(
      'docs_open("runtime:workerRuntime.gad.query")'
    );
    expect(byId(projected, "runtime:workerRuntime.gad").members).toEqual(["query"]);
  });

  it("serializes args/returns JSON Schema and carries description/examples", () => {
    const get = byId(entries, "service:demo.get");
    expect(get.argsSchema).toBeTruthy();
    expect(get.returnsSchema).toBeTruthy();
    expect(get.description).toBe("Get a value.");
    const wipe = byId(entries, "service:demo.admin.wipe");
    expect(wipe.returnsSchema).toBeUndefined();
  });

  it("derives authority principals with method > service precedence and includes reviewed tier", () => {
    const access = (id: string) =>
      (byId(entries, id).access as
        | { principals?: string[]; tier?: string; sessionAdmission?: string }
        | undefined) ?? {};
    expect(access("service:demo.get")).toMatchObject({
      principals: ["code", "host"],
      tier: "open",
      sessionAdmission: "family",
    });
    expect(access("service:demo.admin.wipe").principals).toEqual(["host"]);
    expect(access("service:demo.probe").principals).toEqual(["code"]);
  });

  it("emits runtime entries", () => {
    const foo = byId(entries, "runtime:panel.foo");
    expect(foo.surface).toBe("runtime");
    expect(foo.members).toBeUndefined();
    expect((foo.access as { callers?: string[] }).callers).toEqual(["panel"]);
    expect(
      (byId(entries, "runtime:workerRuntime.bar").access as { callers?: string[] }).callers
    ).toEqual(["worker", "do"]);
  });
});

it("documents runtime-owned worker lifecycle helpers without exposing raw transport calls", () => {
  const projected = buildCatalog({
    definitions: [],
    runtimeSurfaces: { workerRuntime: workerRuntimeSurface },
  });
  expect(byId(projected, "runtime:workerRuntime.workers.create")).toMatchObject({
    qualifiedName: "workers.create",
    signature: "create(source: string, options?: WorkerCreateOptions): Promise<WorkerEntityHandle>",
    access: { callers: ["worker", "do"] },
  });
  expect(byId(projected, "runtime:workerRuntime.workers.destroy").description).toContain(
    "disposable target from workers.resolveDurableObject"
  );
  expect(byId(projected, "runtime:workerRuntime.workers.resolveService")).toMatchObject({
    qualifiedName: "workers.resolveService",
    signature:
      "resolveService(query: string, objectKey?: string | null): Promise<ResolvedWorkspaceService>",
  });
  expect(byId(projected, "runtime:workerRuntime.workers.listServices").description).toContain(
    "exact semantic context"
  );
});

describe("isCatalogEntryVisible", () => {
  const entries = buildCatalog({
    definitions: [demo],
    runtimeSurfaces: { panel: panelSurface, workerRuntime: workerSurface },
    tierLookup: testTierLookup,
  });
  const get = byId(entries, "service:demo.get");
  const wipe = byId(entries, "service:demo.admin.wipe");
  const probe = byId(entries, "service:demo.probe");
  const runtimeFoo = byId(entries, "runtime:panel.foo");
  const runtimeBar = byId(entries, "runtime:workerRuntime.bar");

  it("filters by caller kind", () => {
    expect(isCatalogEntryVisible(wipe, "panel")).toBe(false); // server-only hidden from panel
    expect(isCatalogEntryVisible(wipe, "server")).toBe(true);
    expect(isCatalogEntryVisible(get, "panel")).toBe(true);
    expect(isCatalogEntryVisible(get, "do")).toBe(true); // DO inherits panel userland access
  });

  it("applies the DO userland inheritance rule", () => {
    expect(isCatalogEntryVisible(probe, "do")).toBe(true); // explicit do
    // a worker-only method is visible to do
    const workerOnly: CatalogEntry = { ...probe, access: { callers: ["worker"] } };
    expect(isCatalogEntryVisible(workerOnly, "do")).toBe(true);
    const panelOnly: CatalogEntry = { ...probe, access: { callers: ["panel"] } };
    expect(isCatalogEntryVisible(panelOnly, "do")).toBe(true);
  });

  it("filters runtime surfaces by target caller", () => {
    expect(isCatalogEntryVisible(runtimeFoo, "panel")).toBe(true);
    expect(isCatalogEntryVisible(runtimeFoo, "worker")).toBe(false);
    expect(isCatalogEntryVisible(runtimeFoo, "do")).toBe(false);
    expect(isCatalogEntryVisible(runtimeFoo, "extension")).toBe(false);
    expect(isCatalogEntryVisible(runtimeBar, "worker")).toBe(true);
    expect(isCatalogEntryVisible(runtimeBar, "do")).toBe(true);
    expect(isCatalogEntryVisible(runtimeBar, "panel")).toBe(false);
  });
});
