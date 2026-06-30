import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import type { RuntimeSurface } from "@vibez1/shared/runtimeSurface";
import type { CatalogEntry } from "@vibez1/shared/serviceSchemas/docs";
import { buildCatalog, isCatalogEntryVisible } from "./buildCatalog.js";

const demo: ServiceDefinition = {
  name: "demo",
  description: "Demo service",
  policy: { allowed: ["panel", "server"] },
  methods: {
    get: {
      description: "Get a value.",
      args: z.tuple([z.string()]),
      returns: z.object({ v: z.number() }),
    },
    "admin.wipe": {
      description: "Destroy everything (server only).",
      args: z.tuple([]),
      policy: { allowed: ["server"] },
    },
    probe: {
      description: "A probe method.",
      args: z.tuple([]),
      policy: { allowed: ["do", "worker"] },
      access: { sensitivity: "read" },
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

  it("emits a service parent + one entry per method", () => {
    expect(byId(entries, "service:demo").surface).toBe("service");
    expect(byId(entries, "service:demo.get").parent).toBe("service:demo");
    expect(byId(entries, "service:demo.admin.wipe").qualifiedName).toBe("demo.admin.wipe");
  });

  it("serializes args/returns JSON Schema and carries description/examples", () => {
    const get = byId(entries, "service:demo.get");
    expect(get.argsSchema).toBeTruthy();
    expect(get.returnsSchema).toBeTruthy();
    expect(get.description).toBe("Get a value.");
    const wipe = byId(entries, "service:demo.admin.wipe");
    expect(wipe.returnsSchema).toBeUndefined();
  });

  it("derives access.callers with method > service precedence", () => {
    const access = (id: string) =>
      (byId(entries, id).access as { callers?: string[] } | undefined) ?? {};
    expect(access("service:demo.get").callers).toEqual(["panel", "server"]); // service policy
    expect(access("service:demo.admin.wipe").callers).toEqual(["server"]); // method policy
    expect(access("service:demo.probe").callers).toEqual(["do", "worker"]); // method policy
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

  it("filters by caller kind", () => {
    expect(isCatalogEntryVisible(wipe, "panel")).toBe(false); // server-only hidden from panel
    expect(isCatalogEntryVisible(wipe, "server")).toBe(true);
    expect(isCatalogEntryVisible(get, "panel")).toBe(true);
    expect(isCatalogEntryVisible(get, "do")).toBe(false); // panel/server only
  });

  it("applies the do→worker inheritance rule", () => {
    expect(isCatalogEntryVisible(probe, "do")).toBe(true); // explicit do
    // a worker-only method is visible to do
    const workerOnly: CatalogEntry = { ...probe, access: { callers: ["worker"] } };
    expect(isCatalogEntryVisible(workerOnly, "do")).toBe(true);
  });

  it("filters runtime surfaces by target caller", () => {
    expect(isCatalogEntryVisible(runtimeFoo, "panel")).toBe(true);
    expect(isCatalogEntryVisible(runtimeFoo, "worker")).toBe(false);
    expect(isCatalogEntryVisible(runtimeFoo, "extension")).toBe(false);
    expect(isCatalogEntryVisible(runtimeBar, "worker")).toBe(true);
    expect(isCatalogEntryVisible(runtimeBar, "do")).toBe(true);
    expect(isCatalogEntryVisible(runtimeBar, "panel")).toBe(false);
  });
});
