import fs from "node:fs/promises";
import fsNative from "node:fs";
import { gzipSync } from "node:zlib";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparedWorkspaceTemplatePath } from "./preparedWorkspaceTemplate.js";
import {
  preparedWorkspaceReleaseManifestSchema,
  type WorkspaceReleaseOperation,
} from "./preparedWorkspaceRelease.js";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import {
  prepareBuildRootConfig,
  computeRootDependencyFingerprint,
  type RootDependencyFingerprintInfo,
} from "./buildV2/effectiveVersion.js";
import { blobCasPath } from "./storage/blobCas.js";

const { capturedHostRoots } = vi.hoisted(() => ({
  capturedHostRoots: new Map<string, RootDependencyFingerprintInfo>(),
}));
vi.mock("./buildV2/effectiveVersion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./buildV2/effectiveVersion.js")>()),
  buildCompilerProtocolIdentity: () => ({
    cacheVersion: "test-cache",
    panelEntryProtocolFingerprint: "b".repeat(64),
  }),
  prepareBuildRootConfig: vi.fn(async ({ appRoot }: { appRoot: string }) => {
    const captured = capturedHostRoots.get(appRoot);
    if (!captured) throw new Error(`No canonical fixture host capture for ${appRoot}`);
    return captured;
  }),
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
  vi.restoreAllMocks();
  capturedHostRoots.clear();
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
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "release-fixture", private: true })
  );
  const rootFingerprint = await computeRootDependencyFingerprint(root);
  capturedHostRoots.set(root, rootFingerprint);
  const builds = [];
  for (const workspace of ["base", "personal", "system"] as const) {
    const buildKey = createHash("sha256").update(workspace).digest("hex");
    const artifactBytes = Buffer.from(`runtime-${workspace}`);
    const sourceBytes = Buffer.from(`source-${workspace}`);
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
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
      blobs: [{ digest: sourceDigest, size: sourceBytes.length }],
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
    await fs.writeFile(
      path.join(buildDirectory, "executable-modules.json.gz"),
      gzipSync(Buffer.from("[]"))
    );
    const recordDir = preparedWorkspaceTemplatePath(output, templates[workspace], "use");
    await fs.mkdir(recordDir, { recursive: true });
    await fs.writeFile(path.join(recordDir, "template.json"), JSON.stringify(record));
    const sourcePath = blobCasPath(path.join(recordDir, "blobs"), sourceDigest);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, sourceBytes);
    builds.push({
      workspace,
      source: "panels/chat",
      buildKey,
      builtAt: "2026-10-12T00:00:00.000Z",
    });
  }
  const { publishPreparedWorkspaceRelease } = await import("./preparedWorkspaceRelease.js");
  await publishPreparedWorkspaceRelease({ appRoot: root, output, templates }, builds, {
    appDependencyFingerprint: rootFingerprint.value,
    hostBuild,
    compilerProtocol: {
      cacheVersion: "test-cache",
      panelEntryProtocolFingerprint: "b".repeat(64),
    },
  });
  return { root, output, builds, rootFingerprint };
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

  it("captures one identity per cold publication or trusted warm admission", async () => {
    const { root, output, builds, rootFingerprint } = await fixture();
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const { publishPreparedWorkspaceRelease } = await import("./preparedWorkspaceRelease.js");
    const cold = path.join(root, "cold", "release");
    const producer = vi.fn(async (operation: WorkspaceReleaseOperation) => {
      await fs.cp(output, cold, { recursive: true });
      await fs.rm(path.join(cold, "userland-builds/release.json"));
      // Publication uses the same operation capture; it does not re-fingerprint.
      await publishPreparedWorkspaceRelease(
        { appRoot: root, output: cold, templates },
        builds,
        operation.identity
      );
    });
    await prepareCachedWorkspaceRelease({ appRoot: root, output: cold, templates }, producer);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(1);
    expect(producer).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ appDependencyFingerprint: rootFingerprint.value }),
        rootFingerprint,
      })
    );
    const warm = path.join(root, "warm", "release");
    // Diagnostic paths may change without changing the logical input identity.
    // They must not enter the release cache key or its completion manifest.
    capturedHostRoots.set(root, {
      ...rootFingerprint,
      files: rootFingerprint.files.map((file) => ({
        ...file,
        path: path.join(root, "relocated-inputs", file.file),
      })),
    });
    const reads = vi.spyOn(fs, "readFile");
    const streams = vi.spyOn(fsNative, "createReadStream");
    await prepareCachedWorkspaceRelease({ appRoot: root, output: warm, templates }, producer);
    expect(prepareBuildRootConfig).toHaveBeenCalledTimes(2);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(
      reads.mock.calls.every(([file]) =>
        ["release.json", "template.json", "metadata.json", "artifacts.json"].includes(
          path.basename(String(file))
        )
      )
    ).toBe(true);
    expect(streams).not.toHaveBeenCalled();
    const publishedManifest = JSON.parse(
      await fs.readFile(path.join(warm, "userland-builds/release.json"), "utf8")
    );
    expect(publishedManifest).not.toHaveProperty("rootFingerprint");
    expect(JSON.stringify(publishedManifest)).not.toContain("relocated-inputs");
    expect(JSON.stringify(publishedManifest)).not.toContain(root);
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

  it("publishes an inherited completion marker only after every projection link joins", async () => {
    const { root, output, builds } = await fixture();
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
    const { prepareCachedWorkspaceRelease } = await import("./preparedWorkspaceReleaseCache.js");
    const cold = path.join(root, "cold-projection");
    await prepareCachedWorkspaceRelease({ appRoot: root, output: cold, templates }, async () => {
      await fs.cp(output, cold, { recursive: true });
    });
    const warm = path.join(root, "warm-projection");
    const blockedFile = path.join(warm, "userland-builds", builds[0]!.buildKey, "runtime.js");
    let unblock!: () => void;
    let acknowledge!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      if (destination === blockedFile) {
        acknowledge();
        await blocked;
      }
      return link(source, destination);
    });
    const projection = prepareCachedWorkspaceRelease(
      { appRoot: root, output: warm, templates },
      async () => {
        throw new Error("Warm projection must not compile");
      }
    );
    try {
      await entered;
      await expect(fs.stat(path.join(warm, "userland-builds/release.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      unblock();
      await projection;
    }
    await expect(fs.stat(path.join(warm, "userland-builds/release.json"))).resolves.toBeDefined();
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
  it("admits a matching completed release without reading payloads or compressed inventories", async () => {
    const { output } = await fixture();
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    const reads = vi.spyOn(fs, "readFile");
    const streams = vi.spyOn(fsNative, "createReadStream");

    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: roots[0]!, output, templates })
    ).resolves.toBe(true);
    expect(
      reads.mock.calls.every(([file]) =>
        ["release.json", "template.json", "metadata.json", "artifacts.json"].includes(
          path.basename(String(file))
        )
      )
    ).toBe(true);
    expect(streams).not.toHaveBeenCalled();
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

  it("admits independent descriptors concurrently and joins all admitted failures", async () => {
    const { root, output, builds } = await fixture();
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    const paths = builds.map((build) =>
      path.join(output, "userland-builds", build.buildKey, "metadata.json")
    );
    const firstFailure = new Error("first descriptor failed");
    const secondFailure = new Error("second descriptor failed");
    let entered!: () => void;
    let unblock!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lastOwned = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const read = fs.readFile;
    let started = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const index = paths.indexOf(String(args[0]));
      if (index !== -1) {
        if (++started === 3) entered();
        if (index === 0) throw firstFailure;
        if (index === 1) throw secondFailure;
        await lastOwned;
      }
      return read(...args);
    });
    let settled = false;
    const admission = validateExistingPreparedWorkspaceRelease({
      appRoot: root,
      output,
      templates,
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (failure: unknown) => {
        settled = true;
        return failure;
      }
    );
    try {
      await allEntered;
      expect(started).toBe(3);
      expect(settled).toBe(false);
    } finally {
      unblock();
    }
    const failure = await admission;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([firstFailure, secondFailure])
    );
  });

  it("reads a shared build descriptor once even when multiple roles reference it", async () => {
    const { root, output, builds } = await fixture();
    await fs.rm(path.join(output, "userland-builds/release.json"));
    const directory = preparedWorkspaceTemplatePath(output, templates.personal, "use");
    const recordPath = path.join(directory, "template.json");
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    const previous = builds[1]!.buildKey;
    builds[1]!.buildKey = builds[0]!.buildKey;
    record.builds[0].buildKey = builds[0]!.buildKey;
    await fs.writeFile(recordPath, JSON.stringify(record));
    await fs.rm(path.join(output, "userland-builds", previous), { recursive: true });
    const { publishPreparedWorkspaceRelease, validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await publishPreparedWorkspaceRelease({ appRoot: root, output, templates }, builds);
    const reads = vi.spyOn(fs, "readFile");
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).resolves.toBe(true);
    const sharedMetadata = path.join(
      output,
      "userland-builds",
      builds[0]!.buildKey,
      "metadata.json"
    );
    expect(reads.mock.calls.filter(([file]) => file === sharedMetadata)).toHaveLength(1);
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

  it("rejects corrupted runtime payloads before publishing a completion marker", async () => {
    const { root, output, builds } = await fixture();
    await fs.rm(path.join(output, "userland-builds/release.json"));
    const artifact = path.join(output, "userland-builds", builds[0]!.buildKey, "runtime.js");
    const bytes = await fs.readFile(artifact);
    await fs.writeFile(artifact, Buffer.alloc(bytes.length, "X"));
    const { publishPreparedWorkspaceRelease, validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    await expect(
      publishPreparedWorkspaceRelease({ appRoot: root, output, templates }, builds)
    ).rejects.toThrow(/integrity mismatch/);
    await expect(fs.stat(path.join(output, "userland-builds/release.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/incomplete/);
  });

  it("proves source blob payloads before publishing a completion marker", async () => {
    const { root, output, builds } = await fixture();
    await fs.rm(path.join(output, "userland-builds/release.json"));
    const directory = preparedWorkspaceTemplatePath(output, basePin, "use");
    const record = JSON.parse(await fs.readFile(path.join(directory, "template.json"), "utf8"));
    const blob = record.blobs[0];
    await fs.writeFile(
      blobCasPath(path.join(directory, "blobs"), blob.digest),
      Buffer.alloc(blob.size, "X")
    );
    const { publishPreparedWorkspaceRelease } = await import("./preparedWorkspaceRelease.js");
    await expect(
      publishPreparedWorkspaceRelease({ appRoot: root, output, templates }, builds)
    ).rejects.toThrow(/blob .*integrity/);
    await expect(fs.stat(path.join(output, "userland-builds/release.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("proves compressed executable inventories before publishing a completion marker", async () => {
    const { root, output, builds } = await fixture();
    await fs.rm(path.join(output, "userland-builds/release.json"));
    await fs.writeFile(
      path.join(output, "userland-builds", builds[0]!.buildKey, "executable-modules.json.gz"),
      gzipSync(Buffer.from("{}"))
    );
    const { publishPreparedWorkspaceRelease } = await import("./preparedWorkspaceRelease.js");
    await expect(
      publishPreparedWorkspaceRelease({ appRoot: root, output, templates }, builds)
    ).rejects.toThrow(/Invalid executable module inventory/);
    await expect(fs.stat(path.join(output, "userland-builds/release.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("still rejects missing payloads and noncanonical artifact paths during descriptor admission", async () => {
    const { root, output, builds } = await fixture();
    const { validateExistingPreparedWorkspaceRelease } =
      await import("./preparedWorkspaceRelease.js");
    const directory = path.join(output, "userland-builds", builds[0]!.buildKey);
    const bytes = await fs.readFile(path.join(directory, "runtime.js"));
    await fs.rm(path.join(directory, "runtime.js"));
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(directory, "runtime.js"), bytes);
    const artifacts = JSON.parse(await fs.readFile(path.join(directory, "artifacts.json"), "utf8"));
    artifacts[0].path = "../escaped.js";
    await fs.writeFile(path.join(directory, "artifacts.json"), JSON.stringify(artifacts));
    await expect(
      validateExistingPreparedWorkspaceRelease({ appRoot: root, output, templates })
    ).rejects.toThrow(/Invalid release artifact path/);
  });
});
