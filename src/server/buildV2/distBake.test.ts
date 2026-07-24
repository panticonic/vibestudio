import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAppDistBakeManifest,
  writeAppDistBake,
  type ApprovedAppDistEntry,
} from "./distBake.js";
import type { BuildResult } from "./buildStore.js";
import { domainHash } from "@vibestudio/shared/execution/identity";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";

const BUILD_KEY = "b".repeat(64);
const EFFECTIVE_VERSION = "e".repeat(64);

function integrity(content: string): string {
  return `sha256-${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function executionIdentity(artifacts: BuildResult["artifacts"]) {
  const artifactDigest = domainHash(
    "vibestudio/build-v2-artifacts/v1",
    canonicalJson(
      artifacts
        .map(({ content: _content, ...artifact }) => ({
          path: artifact.path,
          role: artifact.role,
          contentType: artifact.contentType,
          encoding: artifact.encoding,
          platform: artifact.platform ?? null,
          integrity: artifact.integrity ?? null,
        }))
        .sort((left, right) =>
          `${left.path}\0${left.platform ?? ""}`.localeCompare(
            `${right.path}\0${right.platform ?? ""}`
          )
        )
    )
  );
  const source = { repoPath: "apps/shell", effectiveVersion: EFFECTIVE_VERSION as never };
  const executionDigest = domainHash(
    "vibestudio/build-v2-execution/v1",
    canonicalJson({ version: 1, source, buildInputDigest: BUILD_KEY, artifactDigest })
  );
  return {
    version: 1 as const,
    source,
    buildInputDigest: BUILD_KEY as never,
    artifactDigest,
    executionDigest,
  };
}

function appEntry(overrides: Partial<ApprovedAppDistEntry> = {}): ApprovedAppDistEntry {
  return {
    name: "@workspace-apps/shell",
    target: "electron",
    capabilities: ["notifications"],
    source: { repo: "workspace/apps/shell", ref: "main" },
    activeEv: EFFECTIVE_VERSION,
    activeSourceHash: "state:shell",
    activeBundleKey: BUILD_KEY,
    status: "running",
    ...overrides,
  };
}

function appBuild(overrides: Partial<BuildResult> = {}): BuildResult {
  const artifacts: BuildResult["artifacts"] = [
    {
      path: "index.html",
      role: "html",
      contentType: "text/html; charset=utf-8",
      encoding: "utf8",
      integrity: integrity(
        '<html><head><base href="/apps/shell/"></head><body><script src="/__loader.js"></script></body></html>'
      ),
      content:
        '<html><head><base href="/apps/shell/"></head><body><script src="/__loader.js"></script></body></html>',
    },
    {
      path: "bundle.js",
      role: "primary",
      contentType: "text/javascript; charset=utf-8",
      encoding: "utf8",
      integrity: integrity("console.log('shell')"),
      content: "console.log('shell')",
    },
  ];
  return {
    dir: `/builds/${BUILD_KEY}`,
    buildKey: BUILD_KEY,
    sourceStateHash: "state:shell",
    metadata: {
      kind: "app",
      name: "@workspace-apps/shell",
      buildKey: BUILD_KEY,
      sourcePath: "apps/shell",
      ev: EFFECTIVE_VERSION,
      sourceStateHash: "state:shell",
      sourcemap: true,
      authority: {
        requests: [
          {
            capability: "service:events.watch",
            resource: { kind: "exact", key: "service:events.watch" },
            tier: "gated",
            evidence: "exact",
          },
        ],
      },
      execution: executionIdentity(artifacts),
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
    artifacts,
    ...overrides,
  };
}

describe("app dist bake", () => {
  it("creates a target-checked manifest for an active approved Electron app build", () => {
    const manifest = createAppDistBakeManifest({
      entry: appEntry(),
      build: appBuild(),
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
        key: BUILD_KEY,
        effectiveVersion: EFFECTIVE_VERSION,
        sourceStateHash: "state:shell",
        target: "electron",
        integrity: "sha256-shell",
        executionDigest: appBuild().metadata.execution?.executionDigest,
        execution: appBuild().metadata.execution,
        authorityRequests: [
          {
            capability: "service:events.watch",
            resource: { kind: "exact", key: "service:events.watch" },
          },
        ],
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
      })
    ).toThrow(/not running/);

    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry({ activeBundleKey: "other-build" }),
        build: appBuild(),
        buildKey: BUILD_KEY,
      })
    ).toThrow(/no matching active app build/);

    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry(),
        build: appBuild({
          metadata: {
            ...appBuild().metadata,
            ev: "f".repeat(64),
          },
        }),
      })
    ).toThrow(/EV does not match/);
  });

  it("rejects app bakes without exact sealed execution authority", () => {
    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry(),
        build: appBuild({ metadata: { ...appBuild().metadata, execution: undefined } }),
      })
    ).toThrow(/execution digest must be a full lowercase SHA-256/);

    expect(() =>
      createAppDistBakeManifest({
        entry: appEntry(),
        build: appBuild({ metadata: { ...appBuild().metadata, authority: undefined } }),
      })
    ).toThrow(/sealed build authority must be an object/);
  });

  it("requires signed platform-keyed primary artifacts for React Native bakes", () => {
    const rnEntry = appEntry({
      name: "@workspace-apps/mobile",
      target: "react-native",
      activeBundleKey: BUILD_KEY,
    });
    const rnBuild = appBuild({
      dir: `/builds/${BUILD_KEY}`,
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
            activeEv: "ev-provider",
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
          integrity: integrity("global.__RN = true;"),
          content: "global.__RN = true;",
        },
      ],
    });

    expect(createAppDistBakeManifest({ entry: rnEntry, build: rnBuild }).build.rnHostAbi).toBe(
      "rn-0.79-vibestudio-1"
    );

    expect(() =>
      createAppDistBakeManifest({
        entry: rnEntry,
        build: appBuild({
          metadata: rnBuild.metadata,
          artifacts: [{ ...rnBuild.artifacts[0]!, platform: undefined }],
        }),
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
        outDir,
        generatedAt: "2026-05-26T12:00:00.000Z",
      });

      expect(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))).toMatchObject(
        {
          app: { source: "apps/shell" },
          build: {
            key: BUILD_KEY,
            executionDigest: appBuild().metadata.execution?.executionDigest,
          },
        }
      );
      expect(fs.readFileSync(path.join(outDir, "artifacts", "index.html"), "utf8")).toBe(
        '<html><head><base href="/apps/shell/"></head><body><script src="/__loader.js"></script></body></html>'
      );
      expect(fs.readFileSync(path.join(outDir, "artifacts", "bundle.js"), "utf8")).toBe(
        "console.log('shell')"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
