import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverHostWorkspacePackageManifests,
  resolveHostWorkspacePackageManifest,
} from "./hostWorkspacePackages.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-packages-"));
  tempRoots.push(root);
  return root;
}

describe("host workspace package discovery", () => {
  it("projects a source package even when pnpm has not linked it into node_modules", () => {
    const root = tempRoot();
    const packageRoot = path.join(root, "packages", "browser-import-archive");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@vibestudio/browser-import-archive" })
    );

    const manifests = discoverHostWorkspacePackageManifests(root);
    expect(
      resolveHostWorkspacePackageManifest("@vibestudio/browser-import-archive", manifests, [
        path.join(root, "node_modules"),
      ])
    ).toBe(path.join(packageRoot, "package.json"));
  });

  it("falls back to installed packages in packaged deployments", () => {
    const root = tempRoot();
    const manifest = path.join(root, "node_modules", "@vendor", "library", "package.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: "@vendor/library" }));

    expect(
      resolveHostWorkspacePackageManifest(
        "@vendor/library",
        discoverHostWorkspacePackageManifests(root),
        [path.join(root, "node_modules")]
      )
    ).toBe(manifest);
  });
});
