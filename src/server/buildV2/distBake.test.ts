import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAppDistBakeManifest,
  writeAppDistBake,
  type ApprovedAppDistEntry,
} from "./distBake.js";
import type { BuildResult } from "./buildStore.js";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { executionArtifactFixture } from "../testing/executionArtifactFixture.js";

const APP_SOURCE = sha256("dist-app-source");

function appEntry(overrides: Partial<ApprovedAppDistEntry> = {}): ApprovedAppDistEntry {
  return {
    name: "@workspace-apps/shell",
    target: "electron",
    capabilities: ["notifications"],
    source: { repo: "workspace/apps/shell", ref: "main" },
    activeSourceDigest: APP_SOURCE,
    activeExecutionDigest: DIST_EXECUTION.binding.artifact.executionDigest,
    activeSourceHash: "state:shell",
    activeBundleKey: "build-shell",
    status: "running",
    ...overrides,
  };
}

function appBuild(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    dir: "/builds/build-shell",
    sourceStateHash: "state:shell",
    metadata: {
      kind: "app",
      name: "@workspace-apps/shell",
      sourceDigest: APP_SOURCE,
      sourceStateHash: "state:shell",
      sourcemap: true,
      details: {
        kind: "app",
        target: "electron",
        platform: "electron",
        integrity: "sha256-shell",
        rnHostAbi: null,
        provider: null,
      },
      builtAt: "2026-05-26T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "index.html",
        role: "html",
        contentType: "text/html; charset=utf-8",
        encoding: "utf8",
        content:
          '<html><head><base href="/apps/shell/"></head><body><script src="/__loader.js"></script></body></html>',
      },
      {
        path: "bundle.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: "console.log('shell')",
      },
    ],
    ...overrides,
  };
}

const DIST_EXECUTION = executionArtifactFixture("apps/shell", appBuild(), "main", "build-shell");

describe("app dist bake", () => {
  it("creates a target-checked manifest for an active approved Electron app build", () => {
    const manifest = createAppDistBakeManifest({
      entry: appEntry(),
      build: appBuild(),
      execution: DIST_EXECUTION.bundle,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      version: 2,
      generatedAt: "2026-05-26T12:00:00.000Z",
      app: {
        name: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        capabilities: ["notifications"],
      },
      build: {
        key: DIST_EXECUTION.binding.artifact.buildKey,
        compilationCacheKey: "build-shell",
        executionDigest: DIST_EXECUTION.binding.artifact.executionDigest,
        authorityRequests: DIST_EXECUTION.bundle.requested,
        sourceStateHash: "state:shell",
        target: "electron",
        integrity: "sha256-shell",
      },
    });
    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      "index.html",
      "bundle.js",
    ]);
  });

  it("rejects inactive or mismatched app builds", () => {
    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry({ status: "pending-approval" }),
        build: appBuild(),
        execution: DIST_EXECUTION.bundle,
      })
    ).toThrow(/not running/);

    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry({ activeBundleKey: "other-build" }),
        build: appBuild(),
        execution: DIST_EXECUTION.bundle,
        buildKey: "build-shell",
      })
    ).toThrow(/no matching active app build/);

    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry(),
        build: appBuild({
          metadata: {
            ...appBuild().metadata,
            sourceDigest: "other-sourceDigest",
          },
        }),
        execution: DIST_EXECUTION.bundle,
      })
    ).toThrow(/source digest does not match/);
  });

  it("requires signed platform-keyed primary artifacts for React Native bakes", () => {
    const rnEntry = appEntry({
      name: "@workspace-apps/mobile",
      target: "react-native",
      activeBundleKey: "build-mobile",
    });
    const rnBuild = appBuild({
      dir: "/builds/build-mobile",
      metadata: {
        ...appBuild().metadata,
        name: "@workspace-apps/mobile",
        details: {
          kind: "app",
          target: "react-native",
          platform: "android",
          integrity: "sha256-mobile",
          rnHostAbi: "rn-0.79-vibestudio-1",
          provider: {
            name: "@workspace-extensions/react-native",
            activeSourceDigest: "sourceDigest-provider",
            activeBuildKey: "provider-build",
            contractVersion: "vibestudio-build-provider-v1",
          },
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "global.__RN = true;",
        },
      ],
    });
    const rnExecution = executionArtifactFixture("apps/mobile", rnBuild, "main", "build-mobile");
    rnEntry.activeExecutionDigest = rnExecution.binding.artifact.executionDigest;

    expect(
      createAppDistBakeManifest({ entry: rnEntry, build: rnBuild, execution: rnExecution.bundle })
        .build.rnHostAbi
    ).toBe("rn-0.79-vibestudio-1");

    expect(() =>
      createAppDistBakeManifest({
        entry: rnEntry,
        build: appBuild({
          metadata: rnBuild.metadata,
          artifacts: [{ ...rnBuild.artifacts[0]!, platform: undefined }],
        }),
        execution: rnExecution.bundle,
      })
    ).toThrow(/missing a mobile platform/);
  });

  it("writes a manifest and artifact tree atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dist-bake-"));
    const outDir = path.join(root, "baked-app");
    try {
      writeAppDistBake({
        entry: appEntry(),
        build: appBuild(),
        execution: DIST_EXECUTION.bundle,
        outDir,
        generatedAt: "2026-05-26T12:00:00.000Z",
      });

      expect(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))).toMatchObject(
        {
          app: { source: "apps/shell" },
          build: { compilationCacheKey: "build-shell" },
        }
      );
      expect(fs.readFileSync(path.join(outDir, "artifacts", "index.html"), "utf8")).toBe(
        '<html><head></head><body><script type="module" src="./bundle.js"></script></body></html>'
      );
      expect(fs.readFileSync(path.join(outDir, "artifacts", "bundle.js"), "utf8")).toBe(
        "console.log('shell')"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
