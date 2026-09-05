import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverPackageGraph } from "../server/buildV2/packageGraph.js";
import { requiresNativeHost } from "../../scripts/lib/userland-dependency-projection.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps native dependencies and their consumers out of the desktop validation realm", () => {
  const root = mkdtempSync(join(tmpdir(), "native-dependency-ownership-"));
  roots.push(root);
  const units = {
    "native-navigation": { peerDependencies: { "react-native": "0.79.7", react: "19.0.0" } },
    "native-app": { dependencies: { "@workspace/native-navigation": "workspace:*" } },
    "native-host": { dependencies: { "react-native": "0.79.7" } },
    "web-ui": { peerDependencies: { react: "^19.2.4" } },
    "shared-utils": {},
  };
  for (const [name, manifest] of Object.entries(units)) {
    const directory = join(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: `@workspace/${name}`, version: "1.0.0", ...manifest })
    );
  }
  const graph = discoverPackageGraph(root);
  for (const name of ["native-navigation", "native-app", "native-host"]) {
    expect(requiresNativeHost(graph.get(`@workspace/${name}`), graph)).toBe(true);
  }
  for (const name of ["web-ui", "shared-utils"]) {
    expect(requiresNativeHost(graph.get(`@workspace/${name}`), graph)).toBe(false);
  }
});
