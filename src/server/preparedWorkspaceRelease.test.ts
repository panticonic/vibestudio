import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparedWorkspaceTemplatePath } from "./preparedWorkspaceTemplate.js";
import {
  preparedWorkspaceReleaseManifestSchema,
  type WorkspaceReleaseIdentity,
} from "./preparedWorkspaceRelease.js";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import { prepareBuildRootConfig } from "./buildV2/effectiveVersion.js";

vi.mock("./buildV2/effectiveVersion.js", () => ({
  buildCompilerProtocolIdentity: () => ({
    cacheVersion: "test-cache",
    panelEntryProtocolFingerprint: "b".repeat(64),
  }),
  prepareBuildRootConfig: vi.fn(async () => ({ value: "a".repeat(64) })),
}));
const roots: string[] = [];
const basePin = {
  url: "git+https://example.test/vibestudio.git",
  ref: "refs/tags/v1",
  commit: "c".repeat(40),
};
const templates = {
  base: basePin,
  personal: { ...basePin, commit: "d".repeat(40) },
  system: { ...basePin, commit: "e".repeat(40) },
};
const hostBuild = {
  version: 1,
  mode: "production" as const,
  fingerprint: "9".repeat(64),
  inputCount: 7,
} as const;

afterEach(async () => {
  await closeDerivedCacheCoordinators();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-workspace-release-"));
  roots.push(root);
  const output = path.join(root, "release");
  await fs.mkdir(output);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist", "host-build-fingerprint.json"),
    JSON.stringify(hostBuild)
  );
  vi.stubEnv("VIBESTUDIO_HOST_ARTIFACT_ROOT", path.join(root, "dist"));
  const builds = [];
  for (const workspace of ["base", "personal", "system"] as const) {
    const buildKey = createHash("sha256").update(workspace).digest("hex");
    const artifactBytes = Buffer.from(`runtime-${workspace}`);
    const record = {
      format: "vibestudio-prepared-workspace/1",
      purpose: "use",
      pin: templates[workspace],
      layers: [templates[workspace]],
      installation: {
        sources: [{ pin: templates[workspace], manifest: "manifest.yml" }],
      },
      snapshot: `v1-sha256:${"d".repeat(64)}`,
      files: [],
      repositories: [],
      stateHash: `state:${"e".repeat(64)}`,
      builds: [{ source: "panels/chat", buildKey, effectiveVersion: "f".repeat(64) }],
      blobs: [],
    };
    const buildDirectory = path.join(output, "userland-builds", buildKey);
    await fs.mkdir(buildDirectory, { recursive: true });
    await fs.writeFile(
      path.join(buildDirectory, "metadata.json"),
      JSON.stringify({
        buildKey,
        sourcePath: "panels/chat",
        ev: "f".repeat(64),
        builtAt: "2026-10-12T00:00:00.000Z",
      })
    );
    await fs.writeFile(
      path.join(buildDirectory, "artifacts.json"),
      JSON.stringify([
        {
          path: "runtime.js",
          byteLength: artifactBytes.byteLength,
          integrity: `sha256-${createHash("sha256").update(artifactBytes).digest("hex")}`,
        },
      ])
    );
    await fs.writeFile(path.join(buildDirectory, "runtime.js"), artifactBytes);
    const recordDir = preparedWorkspaceTemplatePath(output, templates[workspace], "use");
    await fs.mkdir(recordDir, { recursive: true });
    await fs.writeFile(path.join(recordDir, "template.json"), JSON.stringify(record));
    builds.push({
      workspace,
      source: "panels/chat",
      buildKey,
      builtAt: "2026-10-12T00:00:00.000Z",
    });
  }
  const { createPreparedWorkspaceReleaseManifest } = await import("./preparedWorkspaceRelease.js");
  const manifest = await createPreparedWorkspaceReleaseManifest(
    { appRoot: root, output, templates },
    builds,
    {
      appDependencyFingerprint: "a".repeat(64),
      hostBuild,
      compilerProtocol: {
        cacheVersion: "test-cache",
        panelEntryProtocolFingerprint: "b".repeat(64),
      },
    }
  );
  await fs.mkdir(path.join(output, "userland-builds"), { recursive: true });
  await fs.writeFile(path.join(output, "userland-builds/release.json"), JSON.stringify(manifest));
  return { root, output, builds };
}

describe("prepared workspace release admission", () => {
  it("projects only owned release resources from a packaged application's resource root", async () => {
    const { root, output } = await fixture();
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
    const host = path.join(output, "app.asar.unpacked", "dist", "node");
    await fs.mkdir(host, { recursive: true });
    await fs.writeFile(path.join(host, "corepack.cjs"), "host-owned executable");
    await fs.symlink("corepack.cjs", path.join(host, "corepack"));
    await fs.writeFile(path.join(output, "app.asar"), "host-owned archive");
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const cold = path.join(root, "packaged", "resources");
    const producer = vi.fn(async () => {
      await fs.cp(output, cold, { recursive: true });
    });
    await prepareCachedWorkspaceRelease({ appRoot: root, output: cold, templates }, producer);
    expect(
      await fs.readlink(path.join(cold, "app.asar.unpacked", "dist", "node", "corepack"))
    ).toContain("corepack.cjs");
    const cached = path.join(root, "derived", "workspace-releases");
    const keys = (await fs.readdir(cached)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry));
    expect(keys).toHaveLength(1);
    expect(await fs.readdir(path.join(cached, keys[0]!))).toEqual([
      "userland-builds",
      "workspace-templates",
    ]);
    const warm = path.join(root, "consumer", "resources");
    await prepareCachedWorkspaceRelease({ appRoot: root, output: warm, templates }, producer);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(warm)).toEqual(["userland-builds", "workspace-templates"]);
  });

  it("captures one identity per cold or warm operation without skipping integrity validation", async () => {
    const { root, output, builds } = await fixture();
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const { publishPreparedWorkspaceRelease } = await import("./preparedWorkspaceRelease.js");
    const cold = path.join(root, "cold", "release");
    const producer = vi.fn(async (identity: WorkspaceReleaseIdentity) => {
      await fs.cp(output, cold, { recursive: true });
      // Publication uses the same operation capture; it does not re-fingerprint.
      await publishPreparedWorkspaceRelease(
        { appRoot: root, output: cold, templates },
        builds,
        identity
      );
    });
    await prepareCachedWorkspaceRelease({ appRoot: root, output: cold, templates }, producer);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(1);
    expect(producer).toHaveBeenCalledWith(
      expect.objectContaining({ appDependencyFingerprint: "a".repeat(64) })
    );
    const warm = path.join(root, "warm", "release");
    await prepareCachedWorkspaceRelease({ appRoot: root, output: warm, templates }, producer);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(2);
    expect(producer).toHaveBeenCalledTimes(1);
    // The warm private projection is a hardlink tree. Corrupt one payload at
    // its sealed length and ensure the next reuse still hashes every artifact.
    const artifactPath = path.join(warm, "userland-builds", builds[1]!.buildKey, "runtime.js");
    const bytes = await fs.readFile(artifactPath);
    await fs.writeFile(artifactPath, Buffer.alloc(bytes.length, "X"));
    await expect(
      prepareCachedWorkspaceRelease(
        { appRoot: root, output: path.join(root, "invalid", "release"), templates },
        producer
      )
    ).rejects.toThrow(/integrity mismatch/);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(3);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it("captures an identity once when the requested complete release is already present", async () => {
    const { root, output } = await fixture();
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const producer = vi.fn(async () => {
      throw new Error("Complete output must not be rebuilt");
    });
    await prepareCachedWorkspaceRelease({ appRoot: root, output, templates }, producer);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(1);
    expect(producer).not.toHaveBeenCalled();
  });
  it("reuses a validated complete release after the first ephemeral projection is discarded", async () => {
    const { root, output } = await fixture();
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const first = path.join(root, "first-ephemeral", "release");
    await prepareCachedWorkspaceRelease({ appRoot: root, output: first, templates }, async () => {
      await fs.cp(output, first, { recursive: true });
    });
    await fs.rm(path.dirname(first), { recursive: true });
    const second = path.join(root, "second-ephemeral", "release");
    const producer = vi.fn(async () => {
      throw new Error("An unchanged warm launch must not compile");
    });
    const sourcesReady = vi.fn();
    await prepareCachedWorkspaceRelease(
      { appRoot: root, output: second, templates, onSourcesPrepared: sourcesReady },
      producer
    );
    expect(producer).not.toHaveBeenCalled();
    expect(sourcesReady).toHaveBeenCalledWith(second);
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    expect(
      await validateExistingPreparedWorkspaceRelease({ appRoot: root, output: second, templates })
    ).toBe(true);
    expect(await fs.readdir(path.join(root, "derived", "workspace-releases"))).toHaveLength(2);
  });
  it("reuses only a matching complete release and verifies every unique build artifact", async () => {
    const { output } = await fixture();
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");

    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: roots[0]!, output, templates })
    ).resolves.toBe(true);
  });

  it("rejects partial output instead of treating it as a cache miss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-workspace-partial-"));
    roots.push(root);
    const output = path.join(root, "release");
    await fs.mkdir(path.join(output, "userland-builds", "partial"), { recursive: true });
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/incomplete/);
  });

  it("rejects an existing release when its template pin differs", async () => {
    const { root, output } = await fixture();
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    const changed = { ...templates, base: { ...basePin, commit: "9".repeat(40) } };
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates: changed })
    ).rejects.toThrow(/does not match/);
  });

  it("rejects a release from a different immutable host build generation", async () => {
    const { root, output } = await fixture();
    await fs.writeFile(
      path.join(root, "dist", "host-build-fingerprint.json"),
      JSON.stringify({ ...hostBuild, fingerprint: "8".repeat(64) })
    );
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/does not match/);
  });

  it("rejects a runtime record whose build timestamp differs from its manifest", async () => {
    const { root, output, builds } = await fixture();
    const metadataPath = path.join(output, "userland-builds", builds[0]!.buildKey, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    metadata.builtAt = "2026-10-11T23:59:59.000Z";
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/metadata does not match/);
  });

  it("rejects a sealed release with an empty runtime inventory for any role", async () => {
    const { root, output } = await fixture();
    const recordPath = path.join(
      preparedWorkspaceTemplatePath(output, basePin, "use"),
      "template.json"
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    record.builds = [];
    const recordBytes = Buffer.from(JSON.stringify(record));
    await fs.writeFile(recordPath, recordBytes);

    const manifestPath = path.join(output, "userland-builds/release.json");
    const manifest = preparedWorkspaceReleaseManifestSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, "utf8"))
    );
    manifest.preparedTemplates.find((entry) => entry.workspace === "base")!.recordDigest =
      createHash("sha256").update(recordBytes).digest("hex");
    manifest.builds = manifest.builds.filter((entry) => entry.workspace !== "base");
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/no runtime builds for base/);
  });

  it("rejects a release whose sealed template record or build inventory changed", async () => {
    const { root, output } = await fixture();
    const recordPath = path.join(
      preparedWorkspaceTemplatePath(output, basePin, "use"),
      "template.json"
    );
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    record.builds = [];
    await fs.writeFile(recordPath, JSON.stringify(record));
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/record digest mismatch/);
  });

  it("rejects a runtime artifact whose sealed bytes have changed", async () => {
    const { root, output, builds } = await fixture();
    await fs.writeFile(
      path.join(output, "userland-builds", builds[0]!.buildKey, "runtime.js"),
      "changed"
    );
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/integrity mismatch/);
  });
});
