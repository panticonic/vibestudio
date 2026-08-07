import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthorityCompilerSnapshot,
  type AuthorityCompilerSnapshotUnit,
} from "./authorityCompilerSnapshot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authority-compiler-snapshot-"));
  roots.push(root);
  const units: AuthorityCompilerSnapshotUnit[] = [];
  const add = (
    name: string,
    relativePath: string,
    files: Record<string, string>,
    dependencies: Record<string, string> = {}
  ) => {
    const dir = path.join(root, relativePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, type: "module", types: "index.ts", dependencies })
    );
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const unit = {
      name,
      relativePath,
      effectiveVersion: `ev:${name}`,
      packageDigest: `digest:${name}`,
    };
    units.push(unit);
    return unit;
  };
  return { root, units, add };
}

const runtimeDeclarations = `
  declare const workers: {
    resolveService(query: string, objectKey?: string): Promise<{ targetId: string }>;
  };
  declare const rpc: {
    call(target: string, method: string, ...args: unknown[]): Promise<unknown>;
  };
`;

describe("AuthorityCompilerSnapshot", () => {
  it("shares one program while composing a shared dependency into both consumers", async () => {
    const fixture = workspace();
    fixture.add("@workspace/shared", "packages/shared", {
      "index.ts": `${runtimeDeclarations}
        export function client() { return workers.resolveService("notes.v1", "shared"); }
      `,
    });
    fixture.add(
      "@workspace/alpha",
      "workers/alpha",
      {
        "index.ts": `import { client } from "@workspace/shared";
          ${runtimeDeclarations}
          export async function run() { const value = await client(); return rpc.call(value.targetId, "alpha"); }
        `,
      },
      { "@workspace/shared": "workspace:*" }
    );
    fixture.add(
      "@workspace/beta",
      "workers/beta",
      {
        "index.ts": `import { client } from "@workspace/shared";
          ${runtimeDeclarations}
          export async function run() { const value = await client(); return rpc.call(value.targetId, "beta"); }
        `,
      },
      { "@workspace/shared": "workspace:*" }
    );

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });

    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]?.units.map((unit) => unit.name)).toEqual([
      "@workspace/shared",
      "@workspace/alpha",
      "@workspace/beta",
    ]);
    const alpha = snapshot.factsByConsumer.get("@workspace/alpha") ?? [];
    const beta = snapshot.factsByConsumer.get("@workspace/beta") ?? [];
    expect(alpha.some((fact) => fact.origin.unitName === "@workspace/shared")).toBe(true);
    expect(beta.some((fact) => fact.origin.unitName === "@workspace/shared")).toBe(true);
    expect(
      alpha.some((fact) => fact.methods.kind === "literals" && fact.methods.values.has("alpha"))
    ).toBe(true);
    expect(
      beta.some((fact) => fact.methods.kind === "literals" && fact.methods.values.has("beta"))
    ).toBe(true);
  });

  it("preserves imported wrapper resolution and producer relationships", async () => {
    const fixture = workspace();
    fixture.add("@workspace/wrapper", "packages/wrapper", {
      "index.ts": `${runtimeDeclarations}
        export function client() { return workers.resolveService("notes.v1", "wrapped"); }
      `,
    });
    fixture.add(
      "@workspace/consumer",
      "workers/consumer",
      {
        "index.ts": `import { client } from "@workspace/wrapper";
          ${runtimeDeclarations}
          export async function run() {
            const service = await client();
            const produced = await rpc.call(service.targetId, "produce");
            await rpc.call(service.targetId, "consume", produced);
          }
        `,
      },
      { "@workspace/wrapper": "workspace:*" }
    );

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });
    const facts = snapshot.factsByConsumer.get("@workspace/consumer") ?? [];
    const resolution = facts.find((fact) => fact.kind === "resolution");
    const produced = facts.find(
      (fact) => fact.methods.kind === "literals" && fact.methods.values.has("produce")
    );
    const consumed = facts.find(
      (fact) => fact.methods.kind === "literals" && fact.methods.values.has("consume")
    );
    expect(resolution?.origin.package?.name).toBe("@workspace/wrapper");
    expect(produced?.origin.package).toBeUndefined();
    expect(consumed?.arguments).toContainEqual({
      kind: "service-call-result",
      producerCallId: produced?.id,
    });
  });

  it("excludes an unused dependency file from a consumer's composed facts", async () => {
    const fixture = workspace();
    fixture.add("@workspace/dependency", "packages/dependency", {
      "index.ts": "export const used = true;",
      "unused.ts": `${runtimeDeclarations}
        export async function unused() { const service = await workers.resolveService("unused.v1"); return rpc.call(service.targetId, "unused"); }
      `,
    });
    fixture.add(
      "@workspace/consumer",
      "workers/consumer",
      { "index.ts": `import { used } from "@workspace/dependency"; export const value = used;` },
      { "@workspace/dependency": "workspace:*" }
    );

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });

    expect(snapshot.factsByConsumer.get("@workspace/consumer")).toEqual([]);
    expect(
      snapshot.factsByConsumer
        .get("@workspace/dependency")
        ?.some((fact) => fact.origin.file.endsWith("unused.ts"))
    ).toBe(true);
  });

  it.each([
    ["static import", `import "@workspace/dependency";`],
    ["re-export", `export * from "@workspace/dependency";`],
    ["import equals", `import dependency = require("@workspace/dependency"); void dependency;`],
    ["dynamic import", `void import("@workspace/dependency");`],
  ])("composes facts reachable through a %s", async (_label, statement) => {
    const fixture = workspace();
    fixture.add("@workspace/dependency", "packages/dependency", {
      "index.ts": `${runtimeDeclarations}
        export async function dependency() {
          const service = await workers.resolveService("dependency.v1");
          return rpc.call(service.targetId, "reachable");
        }
      `,
    });
    fixture.add(
      "@workspace/consumer",
      "workers/consumer",
      { "index.ts": statement },
      { "@workspace/dependency": "workspace:*" }
    );

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });

    expect(
      snapshot.factsByConsumer
        .get("@workspace/consumer")
        ?.some((fact) => fact.origin.unitName === "@workspace/dependency")
    ).toBe(true);
  });

  it("excludes reachable trusted runtime dispatch plumbing from consumer facts", async () => {
    const fixture = workspace();
    fixture.add("@workspace/runtime", "packages/runtime", {
      "index.ts": `${runtimeDeclarations}
        export function runtimeClient(query: string) { return workers.resolveService(query); }
      `,
    });
    fixture.add(
      "@workspace/consumer",
      "workers/consumer",
      {
        "index.ts": `import { runtimeClient } from "@workspace/runtime"; export const client = runtimeClient;`,
      },
      { "@workspace/runtime": "workspace:*" }
    );

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });

    expect(snapshot.factsByConsumer.get("@workspace/consumer")).toEqual([]);
  });

  it("groups own tsconfigs by their normalized compiler semantics", async () => {
    const fixture = workspace();
    fixture.add("@workspace/default", "workers/default", { "index.ts": "export const x = 1;" });
    fixture.add("@workspace/configured-a", "workers/configured-a", {
      "index.ts": "export const y = 2;",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false } }),
    });
    fixture.add("@workspace/configured-b", "workers/configured-b", {
      "index.ts": "export const z = 3;",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, outDir: "dist" } }),
    });

    const snapshot = await createAuthorityCompilerSnapshot({
      sourceRoot: fixture.root,
      units: fixture.units,
      nodeModulesPaths: [],
    });

    expect(snapshot.groups).toHaveLength(2);
    expect(
      snapshot.groups
        .map((group) => group.units.map((unit) => unit.name).sort((a, b) => a.localeCompare(b)))
        .sort((a, b) => a.join("\0").localeCompare(b.join("\0")))
    ).toEqual([["@workspace/configured-a", "@workspace/configured-b"], ["@workspace/default"]]);
    expect(snapshot.factsByConsumer.has("@workspace/configured-a")).toBe(true);
    expect(snapshot.factsByConsumer.has("@workspace/configured-b")).toBe(true);
  });
});
