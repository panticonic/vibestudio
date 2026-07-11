import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTreeReachableDigests,
  ensureLayout,
  mirrorWorktreeTree,
  putBytes,
} from "../services/blobstoreService.js";
import { EMPTY_STATE_HASH } from "@vibestudio/shared/contentTree/worktreeHash";
import { createRefService } from "../services/refService.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

const FILE_MODE = 33188;

describe("WorkspaceVcs startup source authority", () => {
  let root: string;
  let blobsDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-startup-"));
    blobsDir = path.join(root, "blobs");
    workspaceRoot = path.join(root, "source");
    ensureLayout(blobsDir);
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writeDiskManifest(text: string): Promise<void> {
    await fsp.writeFile(path.join(workspaceRoot, "meta", "vibestudio.yml"), text, "utf8");
  }

  async function stateWithFile(filePath: string, text: string): Promise<string> {
    const { digest } = await putBytes(blobsDir, Buffer.from(text, "utf8"));
    return (
      await mirrorWorktreeTree(blobsDir, [{ path: filePath, contentHash: digest, mode: FILE_MODE }])
    ).stateHash;
  }

  function makeVcs() {
    const refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: async () => {},
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "test-ws",
      blobsDir,
      workspaceRoot,
      contextsRoot: path.join(root, "contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    return { refs, vcs };
  }

  it("uses protected main refs instead of stale disk before the gad store attaches", async () => {
    await writeDiskManifest("initPanels:\n  - source: panels/stale\n");
    const protectedMetaState = await stateWithFile(
      "vibestudio.yml",
      "initPanels:\n  - source: panels/protected\n"
    );
    const { refs, vcs } = makeVcs();
    await refs.seedMain({ repoPath: "meta", value: protectedMetaState });

    const fresh = await vcs.ensureFresh();
    const manifest = await vcs.readFile(fresh.stateHash, "meta/vibestudio.yml");

    expect(manifest?.content).toEqual({
      kind: "text",
      text: "initPanels:\n  - source: panels/protected\n",
    });
  });

  it("falls back to disk only when no protected main refs exist yet", async () => {
    await writeDiskManifest("initPanels:\n  - source: panels/disk\n");
    const { vcs } = makeVcs();

    const fresh = await vcs.ensureFresh();
    const manifest = await vcs.readFile(fresh.stateHash, "meta/vibestudio.yml");

    expect(manifest?.content).toEqual({
      kind: "text",
      text: "initPanels:\n  - source: panels/disk\n",
    });
  });

  it("materializes the canonical empty tree before marking it as a GC root", async () => {
    await fsp.rm(path.join(workspaceRoot, "meta"), { recursive: true });
    const { vcs } = makeVcs();
    await vcs.attachGad({
      async call<T>(method: string): Promise<T> {
        if (method === "vcsHealPublishDrift") return undefined as T;
        if (method === "runGadGcMark") {
          return {
            keptStates: 1,
            sweptStates: 0,
            sweptManifests: 0,
            sweptFileVersions: 0,
            blobCandidates: 0,
            liveStateHashes: [EMPTY_STATE_HASH],
            liveBlobDigests: [],
          } as T;
        }
        if (method === "runGadGcSweep") return { digests: [] } as T;
        throw new Error(`Unexpected GAD call: ${method}`);
      },
    });

    await expect(vcs.runGc({ minAgeMs: 0 })).resolves.toMatchObject({
      keptStates: 1,
      sweptTreeObjects: 0,
    });
    await expect(collectTreeReachableDigests(blobsDir, EMPTY_STATE_HASH)).resolves.not.toBeNull();
  });
});
