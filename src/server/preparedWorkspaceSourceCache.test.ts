import fs from "node:fs/promises";
import fsNative from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePreparedWorkspaceSources,
  type PreparedWorkspaceSourceIdentity,
} from "./preparedWorkspaceSourceCache.js";
import { preparedWorkspaceTemplatePath } from "./preparedWorkspaceTemplate.js";
import { blobCasPath } from "./storage/blobCas.js";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";

const roots: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/tags/v1",
  commit: "a".repeat(40),
};
const templates = {
  base: pin,
  personal: { ...pin, commit: "b".repeat(40) },
  system: { ...pin, commit: "c".repeat(40) },
};
const identity: PreparedWorkspaceSourceIdentity = {
  recipe: "d".repeat(64),
  appDependencyFingerprint: "e".repeat(64),
  systemEpoch: 0,
  templates,
  layers: { base: [templates.base], personal: [templates.personal], system: [templates.system] },
};
const bytes = Buffer.from("immutable source");
const digest = createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-workspace-sources-"));
  roots.push(root);
  vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", path.join(root, "derived"));
  return root;
}
async function produce(root: string) {
  for (const role of ["base", "personal", "system"] as const) {
    const directory = preparedWorkspaceTemplatePath(root, templates[role], "use");
    const blob = blobCasPath(path.join(directory, "blobs"), digest);
    await fs.mkdir(path.dirname(blob), { recursive: true });
    await fs.writeFile(blob, bytes);
    await fs.writeFile(
      path.join(directory, "template.json"),
      JSON.stringify({
        format: "vibestudio-prepared-workspace/1",
        purpose: "use",
        pin: templates[role],
        layers: identity.layers[role],
        installation: { sources: [{ pin: templates[role], manifest: "manifest.yml" }] },
        snapshot: `v1-sha256:${"f".repeat(64)}`,
        files: [],
        repositories: [],
        stateHash: `state:${"f".repeat(64)}`,
        builds: [],
        blobs: [{ digest, size: bytes.length }],
      })
    );
  }
}
async function acquire(producer = produce, input = identity) {
  const handle = await acquirePreparedWorkspaceSources({ identity: input }, producer);
  handles.push(handle);
  return handle;
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  await closeDerivedCacheCoordinators();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe("immutable workspace source phase", () => {
  it("survives an interrupted runtime continuation without retaining workspace state", async () => {
    const root = await fixture();
    const producer = vi.fn(produce);
    const first = await acquire(producer);
    await first.close();
    const second = await acquire(producer);
    expect(second.root).toBe(first.root);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(second.root)).toEqual(["source-release.json", "workspace-templates"]);
    expect(await fs.readdir(path.join(root, "derived"))).toContain("workspace-sources");
  });
  it("joins one canonical source publisher for concurrent consumers", async () => {
    await fixture();
    const producer = vi.fn(produce);
    const [first, second] = await Promise.all([acquire(producer), acquire(producer)]);
    expect(first.root).toBe(second.root);
    expect(producer).toHaveBeenCalledTimes(1);
  });
  it("reads only sealed descriptors and file metadata on a trusted cache hit", async () => {
    await fixture();
    const first = await acquire();
    await first.close();
    const read = vi.spyOn(fs, "readFile");
    const stream = vi.spyOn(fsNative, "createReadStream").mockImplementation(() => {
      throw new Error("Consumer must not stream payload bytes");
    });
    await expect(
      acquire(async () => {
        throw new Error("Must not reproduce");
      })
    ).resolves.toMatchObject({ root: first.root });
    expect(
      read.mock.calls.every(([file]) => !String(file).includes(`${path.sep}blobs${path.sep}`))
    ).toBe(true);
    expect(stream).not.toHaveBeenCalled();
  });
  it("proves bytes before publication and retires failed staging without hiding the failure", async () => {
    const root = await fixture();
    await expect(
      acquire(async (output) => {
        await produce(output);
        await fs.writeFile(
          blobCasPath(
            path.join(preparedWorkspaceTemplatePath(output, templates.base, "use"), "blobs"),
            digest
          ),
          Buffer.alloc(bytes.length)
        );
      })
    ).rejects.toThrow(/integrity/);
    expect(
      (await fs.readdir(path.join(root, "derived/workspace-sources"))).filter(
        (entry) => !entry.startsWith(".")
      )
    ).toEqual([]);
  });
  it("keys the admitted dependency closure, not just the three root pins", async () => {
    await fixture();
    const first = await acquire();
    const changed = {
      ...identity,
      layers: { ...identity.layers, system: [templates.base, templates.system] },
    };
    const second = await acquire(async (root) => {
      await produce(root);
      const recordPath = path.join(
        preparedWorkspaceTemplatePath(root, templates.system, "use"),
        "template.json"
      );
      const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
      record.layers = changed.layers.system;
      await fs.writeFile(recordPath, JSON.stringify(record));
    }, changed);
    expect(first.root).not.toBe(second.root);
  });
  it("rejects runtime records or producer state in the source publication", async () => {
    await fixture();
    await expect(
      acquire(async (root) => {
        await produce(root);
        await fs.mkdir(path.join(root, "workspace-state"));
      })
    ).rejects.toThrow(/outside/);
  });
  it("propagates original producer cancellation and owns no completed source publication", async () => {
    const root = await fixture();
    const failure = new Error("Original cancelled preparation");
    await expect(
      acquire(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(
      (await fs.readdir(path.join(root, "derived/workspace-sources"))).filter(
        (entry) => !entry.startsWith(".")
      )
    ).toEqual([]);
  });
});
