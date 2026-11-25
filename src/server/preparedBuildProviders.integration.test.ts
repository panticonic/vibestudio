import { expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { createPreparedBuildProviders } from "./preparedBuildProviders.js";
import type { BuildSystemV2 } from "./buildV2/index.js";

it("uses the owned extension child and streamed provider artifacts during release preparation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prepared-build-provider-"));
  const statePath = path.join(root, "state");
  const sourcePath = path.join(statePath, "source");
  const buildsPath = path.join(statePath, "builds");
  let native: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  let providers: ReturnType<typeof createPreparedBuildProviders> | undefined;
  try {
    await mkdir(path.join(sourcePath, "meta"), { recursive: true });
    await mkdir(buildsPath, { recursive: true });
    await writeFile(
      path.join(sourcePath, "meta/vibestudio.yml"),
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\nextensions:\n  - source: extensions/mobile-builder\nruntimeExtensions:\n  react-native:\n    - extensions/mobile-builder\n`
    );
    const file = path.join(buildsPath, "provider.mjs");
    const integrity =
      "sha256-" + createHash("sha256").update("actual-native-artifact").digest("hex");
    await writeFile(
      file,
      `export function activate() { return {
      build(input) { return { artifacts: [{ path: input.target + '/index.bundle', role: 'primary', contentType: 'application/javascript', stream: {method:'buildArtifact',args:[],integrity:${JSON.stringify(integrity)}} }] }; },
      buildArtifact() { return new Response('actual-native-artifact'); }
    }; }`
    );
    native = await startNativeWorkspaceRuntime({
      workspaceId: "prepared-provider",
      statePath,
      sourceRoot: sourcePath,
      scratchRoot: path.join(statePath, "scratch"),
      buildsRoot: buildsPath,
      appRoot: process.env["VIBESTUDIO_TEST_INSTALLED_APP_ROOT"] ?? process.cwd(),
    });
    const getStoredBuild = vi.fn(async () => ({
      dir: buildsPath,
      buildKey: "b".repeat(64),
      metadata: { ev: "e".repeat(64) },
      artifacts: [{ path: "provider.mjs", role: "primary" }],
    }));
    const builds = {
      getStoredBuild,
      getGraph: () => ({
        allNodes: () => [
          {
            kind: "extension",
            name: "@workspace-extensions/mobile-builder",
            relativePath: "extensions/mobile-builder",
            manifest: { extension: { contributes: { buildTargets: ["react-native"] } } },
          },
        ],
      }),
    } as unknown as BuildSystemV2;
    providers = createPreparedBuildProviders({
      sourcePath,
      statePath,
      stateHash: "state:" + "a".repeat(64),
      workspaceId: "prepared-provider",
      native,
      builds: () => builds,
    });
    const [provider, same] = await Promise.all([
      providers.ensure("react-native"),
      providers.ensure("react-native"),
    ]);
    expect(provider).toBe(same);
    expect(getStoredBuild).toHaveBeenCalledOnce();
    expect(getStoredBuild).toHaveBeenCalledWith(
      "extensions/mobile-builder",
      "state:" + "a".repeat(64),
      { priority: "speculative" }
    );
    const input = {
      target: "react-native" as const,
      unitName: "@workspace-clients/mobile",
      sourcePath,
      dependencyProjection: { nodeModulesPath: null, modules: {} },
      effectiveVersion: "c".repeat(64),
      client: {
        id: "mobile",
        runtime: "react-native" as const,
        hostAbi: "rn-host-6",
        entry: "index.ts",
      },
    };
    const result = await provider.build(input);
    expect(result.artifacts[0]?.stream?.integrity).toBe(integrity);
    const response = await provider.streamArtifact!(result.artifacts[0]!, input);
    expect(await response.text()).toBe("actual-native-artifact");
    expect(provider).toMatchObject({ activeEv: "e".repeat(64), activeBuildKey: "b".repeat(64) });
  } finally {
    await providers?.close();
    if (native) {
      expect((await native.stop()).launcherExited).toBe(true);
      await native.retireStorage();
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
