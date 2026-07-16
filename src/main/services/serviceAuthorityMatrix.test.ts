import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";

const servicesDir = fileURLToPath(new URL(".", import.meta.url));
const goldenPath = join(servicesDir, "__serviceAuthorityMatrix.golden.json");

function inertDeps(): unknown {
  const fn = (): void => {};
  const proxy: object = new Proxy(fn, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive) return () => "";
      if (property === "then") return undefined;
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function isServiceDefinition(value: unknown): value is ServiceDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ServiceDefinition).name === "string" &&
    typeof (value as ServiceDefinition).handler === "function" &&
    typeof (value as ServiceDefinition).methods === "object"
  );
}

type AuthorityMatrix = Record<
  string,
  {
    service: unknown;
    methods: Record<string, { authority: { inherits: true } | unknown; access: unknown }>;
  }
>;

async function collectAuthorityMatrix(): Promise<AuthorityMatrix> {
  const files = readdirSync(servicesDir)
    .filter((file) => /Service\.ts$/.test(file) && !file.includes(".test."))
    .sort();
  const definitions = new Map<string, ServiceDefinition>();
  for (const file of files) {
    const module = (await import(/* @vite-ignore */ join(servicesDir, file))) as Record<
      string,
      unknown
    >;
    for (const [name, exported] of Object.entries(module)) {
      if (!name.startsWith("create") || typeof exported !== "function") continue;
      let result: unknown;
      try {
        result = (exported as (deps: unknown) => unknown)(inertDeps());
      } catch {
        continue;
      }
      if (isServiceDefinition(result)) definitions.set(result.name, result);
    }
  }
  return Object.fromEntries(
    [...definitions.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition) => [
        definition.name,
        {
          service: definition.authority,
          methods: Object.fromEntries(
            Object.entries(definition.methods)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, schema]) => [
                name,
                {
                  authority: schema.authority ?? { inherits: true },
                  access: schema.access ?? null,
                },
              ])
          ),
        },
      ])
  );
}

describe("main service authority matrix", () => {
  it("matches the reviewed compositional-authority census", async () => {
    const matrix = await collectAuthorityMatrix();
    if (process.env["UPDATE_GOLDEN"]) {
      writeFileSync(goldenPath, `${JSON.stringify(matrix, null, 2)}\n`);
    }
    expect(matrix).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")) as AuthorityMatrix);
  });

  it("has no empty defaults, implicit methods, or caller-kind declarations", async () => {
    const matrix = await collectAuthorityMatrix();
    expect(Object.keys(matrix).length).toBeGreaterThan(0);
    for (const [service, entry] of Object.entries(matrix)) {
      const principals = (entry.service as { principals?: unknown[] }).principals;
      expect(principals?.length, `${service} has no default authority`).toBeGreaterThan(0);
      expect(JSON.stringify(entry), `${service} retained caller-kind policy`).not.toMatch(
        /"allowed"|"callers"|"policy"/
      );
    }
  });
});
