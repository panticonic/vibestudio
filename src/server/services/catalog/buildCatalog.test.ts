import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import type { CatalogEntry } from "@vibestudio/service-schemas/docs";
import { buildCatalog, isCatalogEntryVisible } from "./buildCatalog.js";

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
  });

  it("emits a service parent + one entry per agent-facing method", () => {
    expect(byId(entries, "service:demo").surface).toBe("service");
    expect(byId(entries, "service:demo.get").parent).toBe("service:demo");
    expect(byId(entries, "service:demo.admin.wipe").qualifiedName).toBe("demo.admin.wipe");
    expect(entries.some((entry) => entry.id === "service:demo.internalTransport")).toBe(false);
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
  });

  it("serializes args/returns JSON Schema and carries description/examples", () => {
    const get = byId(entries, "service:demo.get");
    expect(get.argsSchema).toBeTruthy();
    expect(get.returnsSchema).toBeTruthy();
    expect(get.description).toBe("Get a value.");
    const wipe = byId(entries, "service:demo.admin.wipe");
    expect(wipe.returnsSchema).toBeUndefined();
  });

  it("surfaces reviewed per-leaf eval acquisition without treating it as a grant", () => {
    const catalog = buildCatalog({
      definitions: [demo],
      evalAuthorityForMethod: (service, method) =>
        service === "demo" && method === "probe"
          ? [
              {
                capability: "service:demo.probe",
                rpcPlane: "host-service",
                sensitivity: "read",
                resourceDerivation: { kind: "literal", key: "service:demo.probe" },
                acquisition: { kind: "baseline" },
              },
            ]
          : [],
    });
    expect(byId(catalog, "service:demo.probe").evalAuthority).toEqual([
      expect.objectContaining({
        capability: "service:demo.probe",
        acquisition: { kind: "baseline" },
      }),
    ]);
  });

  it("derives authority principals with method > service precedence", () => {
    const access = (id: string) =>
      (byId(entries, id).access as { principals?: string[] } | undefined) ?? {};
    expect(access("service:demo.get").principals).toEqual(["code", "host"]);
    expect(access("service:demo.admin.wipe").principals).toEqual(["host"]);
    expect(access("service:demo.probe").principals).toEqual(["code"]);
  });

  it("emits runtime entries", () => {
    const foo = byId(entries, "runtime:panel.foo");
    expect(foo.surface).toBe("runtime");
    expect(foo.members).toEqual(["a", "b"]);
    expect((foo.access as { callers?: string[] }).callers).toEqual(["panel"]);
    expect(
      (byId(entries, "runtime:workerRuntime.bar").access as { callers?: string[] }).callers
    ).toEqual(["worker", "do"]);
  });
});

describe("isCatalogEntryVisible", () => {
  const entries = buildCatalog({
    definitions: [demo],
    runtimeSurfaces: { panel: panelSurface, workerRuntime: workerSurface },
  });
  const get = byId(entries, "service:demo.get");
  const wipe = byId(entries, "service:demo.admin.wipe");
  const probe = byId(entries, "service:demo.probe");
  const runtimeFoo = byId(entries, "runtime:panel.foo");
  const runtimeBar = byId(entries, "runtime:workerRuntime.bar");

  it("filters service discovery by authority principal shape", () => {
    expect(isCatalogEntryVisible(wipe, "panel")).toBe(false);
    expect(isCatalogEntryVisible(wipe, "server")).toBe(true);
    expect(isCatalogEntryVisible(get, "panel")).toBe(true);
    expect(isCatalogEntryVisible(get, "do")).toBe(true);
  });

  it("does not turn runtime shape into service privilege", () => {
    expect(isCatalogEntryVisible(probe, "do")).toBe(true);
    const codeOnly: CatalogEntry = { ...probe, access: { principals: ["code"] } };
    expect(isCatalogEntryVisible(codeOnly, "panel")).toBe(true);
    expect(isCatalogEntryVisible(codeOnly, "worker")).toBe(true);
    expect(isCatalogEntryVisible(codeOnly, "shell")).toBe(false);
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
