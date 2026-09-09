import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IROH_NODE_OPTIONAL_PACKAGE_INTEGRITIES,
  IROH_RELEASE_SET,
  IROH_RELAY_1_0_2_LINUX_ASSET_SHA256,
} from "./releaseSet.js";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const bindingManifestPath = require.resolve("@number0/iroh/package.json");
const bindingPackageRoot = path.dirname(bindingManifestPath);
const bindingManifest = JSON.parse(readFileSync(bindingManifestPath, "utf8")) as {
  version?: string;
  main?: string;
  types?: string;
  optionalDependencies?: Record<string, string>;
};

describe("pinned Iroh release set", () => {
  it("pins the binding and every platform package to one exact distribution version", () => {
    expect(bindingManifest.version).toBe(IROH_RELEASE_SET.bindingVersion);
    expect(bindingManifest.optionalDependencies).toEqual(
      Object.fromEntries(
        Object.keys(IROH_NODE_OPTIONAL_PACKAGE_INTEGRITIES).map((name) => [
          name,
          IROH_RELEASE_SET.bindingVersion,
        ])
      )
    );
  });

  it("pins registry integrity for the wrapper and every package still taken upstream", () => {
    const lockfile = readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain(
      `'@number0/iroh@${IROH_RELEASE_SET.bindingVersion}':\n    resolution: {integrity: ${IROH_RELEASE_SET.npmIntegrity}}`
    );
    // A platform overridden onto the stream-cancellation repair is deliberately
    // not upstream's binary, so it has no upstream integrity left to pin. The
    // wrapper above and every platform still resolved from the registry keep
    // theirs, so dropping an override silently is still caught here.
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
    ) as { pnpm?: { overrides?: Record<string, string> } };
    const repaired = new Set(Object.keys(manifest.pnpm?.overrides ?? {}));
    for (const [name, integrity] of Object.entries(IROH_NODE_OPTIONAL_PACKAGE_INTEGRITIES)) {
      if (repaired.has(name)) continue;
      expect(lockfile).toContain(
        `'${name}@${IROH_RELEASE_SET.bindingVersion}':\n    resolution: {integrity: ${integrity}}`
      );
    }
  });

  it("records relay digests for every retained Linux deployment target", () => {
    expect(Object.keys(IROH_RELAY_1_0_2_LINUX_ASSET_SHA256).sort()).toEqual([
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ]);
    for (const digest of Object.values(IROH_RELAY_1_0_2_LINUX_ASSET_SHA256)) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("records the upstream npm entry defect until a corrected release set replaces it", () => {
    expect(bindingManifest.main).toBe("iroh-js/index.js");
    expect(bindingManifest.types).toBe("iroh-js/index.d.ts");
    expect(existsSync(path.join(bindingPackageRoot, bindingManifest.main!))).toBe(false);
    expect(existsSync(path.join(bindingPackageRoot, bindingManifest.types!))).toBe(false);
    expect(existsSync(path.join(bindingPackageRoot, "index.js"))).toBe(true);
    expect(existsSync(path.join(bindingPackageRoot, "index.d.ts"))).toBe(true);
  });
});
