import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectUserlandPackageManagerBoundaryErrors } from "../scripts/check-userland-package-manager-boundary.mjs";

function makeCheckout(rootManifest: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-package-boundary-"));
  const unitRoot = path.join(root, "workspace", "packages", "adapter");
  fs.mkdirSync(unitRoot, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "host", private: true, ...rootManifest })
  );
  fs.writeFileSync(
    path.join(unitRoot, "package.json"),
    JSON.stringify({
      name: "@workspace/adapter",
      private: true,
      vibestudio: { dependencyResolution: { overrides: { transitive: "1.0.0" } } },
    })
  );
  fs.writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "workspace"\n'
  );
  fs.writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  workspace: {}\n"
  );
  return root;
}

describe("userland package-manager boundary", () => {
  it("accepts Build V2-owned dependency policy", () => {
    const root = makeCheckout();
    try {
      expect(collectUserlandPackageManagerBoundaryErrors(root, path.join(root, "workspace"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects host dependencies and patch paths that reach into userland", () => {
    const root = makeCheckout({
      dependencies: { "@workspace/adapter": "workspace:*" },
      pnpm: {
        patchedDependencies: {
          "external@1.0.0": "workspace/packages/adapter/patches/external.patch",
        },
      },
    });
    try {
      const errors = collectUserlandPackageManagerBoundaryErrors(root, path.join(root, "workspace"));
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("reaches into userland"),
          expect.stringContaining("includes userland package @workspace/adapter"),
        ])
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects package-manager resolution policy on buildable userland units", () => {
    const root = makeCheckout();
    try {
      const manifestPath = path.join(root, "workspace", "packages", "adapter", "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.pnpm = { patchedDependencies: { "external@1.0.0": "patches/external.patch" } };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      expect(collectUserlandPackageManagerBoundaryErrors(root, path.join(root, "workspace"))).toEqual([
        expect.stringContaining("declares package-manager resolution policy"),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
