import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import {
  ensureLayout,
  getBytes,
  mirrorWorktreeTree,
  putBytes,
} from "../services/blobstoreService.js";
import { createProtectedRefStore } from "../services/protectedRefStore.js";
import { createWorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import { createDevelopmentCheckoutPublicationObserver } from "../developmentCheckoutProjection.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

describe("WorkspaceVcs protected publication notification", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fsp.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("emits the complete CAS batch even when source mirroring fails", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-"));
    const blobsDir = path.join(root, "blobs");
    const workspaceRoot = path.join(root, "source");
    ensureLayout(blobsDir);
    await fsp.mkdir(workspaceRoot, { recursive: true });
    // A file where the repository parent directory belongs forces the
    // non-authoritative source mirror to fail after notification.
    await fsp.writeFile(path.join(workspaceRoot, "packages"), "blocked\n");
    const contentHash = (await putBytes(blobsDir, Buffer.from("published\n"))).digest;
    const stateHash = (
      await mirrorWorktreeTree(blobsDir, [{ path: "index.ts", contentHash, mode: 0o100644 }])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot,
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      extractMainToSource: true,
      refs,
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch: async () => undefined as never } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const listener = vi.fn(async () => listenerGate);
    vcs.onProtectedPublication(listener);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let publicationSettled = false;
    const publication = refs.updateMains({
      entries: [{ repoPath: "packages/app", expectedOld: null, next: stateHash }],
      evidence: {
        publicationId: "publication:test",
        previousEventId: "event:genesis",
        publishedEventId: "event:test",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });
    void publication.then(() => {
      publicationSettled = true;
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(publicationSettled).toBe(false);
    releaseListener();
    await publication;

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: "publication:test",
        resultHostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/app", contentRoot: stateHash },
        ]),
        changedPaths: ["packages/app/index.ts"],
        repositories: [
          expect.objectContaining({
            repoPath: "packages/app",
            previousStateHash: null,
            nextStateHash: stateHash,
            fileChanges: [
              {
                kind: "added",
                path: "packages/app/index.ts",
                oldContentHash: null,
                newContentHash: contentHash,
                oldExecutable: null,
                newExecutable: false,
              },
            ],
          }),
        ],
      })
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("protected publication source mirror failed"),
      expect.anything()
    );
  });

  it("settles a protected publication only after the external development checkout is updated", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-writeback-"));
    const blobsDir = path.join(root, "blobs");
    const checkout = path.join(root, "base-checkout");
    const repositoryRoot = path.join(checkout, "packages/demo");
    ensureLayout(blobsDir);
    await fsp.mkdir(repositoryRoot, { recursive: true });
    await fsp.writeFile(path.join(repositoryRoot, "index.ts"), "before\n");
    const beforeHash = (await putBytes(blobsDir, Buffer.from("before\n"))).digest;
    const afterHash = (await putBytes(blobsDir, Buffer.from("after\n"))).digest;
    const beforeState = (
      await mirrorWorktreeTree(blobsDir, [
        { path: "index.ts", contentHash: beforeHash, mode: 0o100644 },
      ])
    ).stateHash;
    const afterState = (
      await mirrorWorktreeTree(blobsDir, [
        { path: "index.ts", contentHash: afterHash, mode: 0o100644 },
      ])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "semantic-source"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch: async () => undefined as never } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    const observer = createDevelopmentCheckoutPublicationObserver({
      destinationRoot: checkout,
      inspectRepository: async () => {
        const inspected = await vcs.contentProjection.localState(repositoryRoot, { exact: true });
        return {
          files: inspected.files.map((file) => ({
            path: file.path,
            contentHash: file.contentHash,
            executable: (file.mode & 0o111) !== 0,
          })),
          skippedPaths: [],
        };
      },
      readState: async (stateHash) =>
        (await vcs.contentProjection.listStateFiles(stateHash)).map((file) => ({
          path: file.path,
          contentHash: file.content_hash,
          executable: (file.mode & 0o111) !== 0,
        })),
      readBlob: (contentHash) => getBytes(blobsDir, contentHash),
    });
    vcs.onProtectedPublication(async (event) => {
      await observer.observe(event);
    });

    await refs.updateMains({
      entries: [{ repoPath: "packages/demo", expectedOld: null, next: beforeState }],
      evidence: {
        publicationId: "publication:seed",
        previousEventId: "event:genesis",
        publishedEventId: "event:seed",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });
    await refs.updateMains({
      entries: [{ repoPath: "packages/demo", expectedOld: beforeState, next: afterState }],
      evidence: {
        publicationId: "publication:edit",
        previousEventId: "event:seed",
        publishedEventId: "event:edit",
        hostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/demo", contentRoot: beforeState },
        ]),
      },
    });

    expect(await fsp.readFile(path.join(repositoryRoot, "index.ts"), "utf8")).toBe("after\n");
  });

  it("serializes every protected-main author while allowing one authoring lease to publish", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-lease-"));
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs: createProtectedRefStore({
        statePath: path.join(root, "refs"),
        gate: async () => undefined,
      }),
    });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = vcs.withProtectedMainMutation(async () => {
      order.push("first:start");
      await gate;
      await vcs.withProtectedMainMutation(async () => {
        order.push("first:publish");
      });
      order.push("first:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    const second = vcs.withProtectedMainMutation(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:publish", "first:end", "second"]);
  });
});
