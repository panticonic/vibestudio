import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import { PackageGraph, type GraphNode } from "../src/server/buildV2/packageGraph";
import { discoveredUserlandSourceAliases, hostSourceAliases } from "../vitest.sourceAliases";
import { userlandDependencyAliases } from "../vitest.userlandProjection";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "vibestudio-alias-test-"));
  roots.push(root);
  return root;
}

describe("source package resolution", () => {
  it("resolves an exported host subpath without a separate tsconfig path", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const server = await createServer({
      configFile: false,
      optimizeDeps: { noDiscovery: true, entries: [] },
      root,
      resolve: { alias: hostSourceAliases(root) },
      server: { middlewareMode: true },
      appType: "custom",
    });
    try {
      const resolved = await server.pluginContainer.resolveId(
        "@vibestudio/durable/rpcMethods",
        path.join(fixtureRoot(), "probe.ts")
      );
      expect(resolved?.id).toBe(path.join(root, "packages/durable/src/rpcMethods.ts"));
    } finally {
      await server.close();
    }
  });

  it("keeps exact exports separate from wildcard exports in source and npm projections", async () => {
    const root = fixtureRoot();
    const packageDir = path.join(root, "node_modules/@fixture/library");
    mkdirSync(path.join(packageDir, "features"), { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@fixture/library",
        version: "1.0.0",
        exports: {
          ".": "./index.js",
          "./features/*": "./features/*.js",
          "./features/one": "./special.js",
        },
      })
    );
    writeFileSync(path.join(packageDir, "index.js"), "export const root = true;");
    writeFileSync(path.join(packageDir, "features/one.js"), "export const one = true;");
    writeFileSync(path.join(packageDir, "special.js"), "export const one = false;");
    const unit: GraphNode = {
      name: "@fixture/library",
      path: packageDir,
      relativePath: "packages/library",
      kind: "package",
      dependencies: {},
      peerDependencies: {},
      optionalPeerDependencies: [],
      dependencyOverrides: {},
      internalDeps: [],
      manifest: { name: "@fixture/library", version: "1.0.0" },
    };
    const projected = userlandDependencyAliases({
      graph: new PackageGraph(),
      units: [],
      dependencies: { "@fixture/library": "1.0.0" },
      dependencyOverrides: {},
      dependencyPatches: [],
      nodeModulesDir: path.join(root, "node_modules"),
      release() {},
    });
    for (const aliases of [discoveredUserlandSourceAliases([unit]), projected]) {
      const server = await createServer({
        configFile: false,
        optimizeDeps: { noDiscovery: true, entries: [] },
        root,
        resolve: { alias: aliases },
        server: { middlewareMode: true },
        appType: "custom",
      });
      try {
        expect(
          (await server.pluginContainer.resolveId("@fixture/library", path.join(root, "probe.js")))
            ?.id
        ).toBe(path.join(packageDir, "index.js"));
        expect(
          (
            await server.pluginContainer.resolveId(
              "@fixture/library/features/one",
              path.join(root, "probe.js")
            )
          )?.id
        ).toBe(path.join(packageDir, "special.js"));
        await expect(
          server.pluginContainer.resolveId("@fixture/library/private", path.join(root, "probe.js"))
        ).rejects.toThrow(/Missing.*specifier/u);
      } finally {
        await server.close();
      }
    }
  });
});
