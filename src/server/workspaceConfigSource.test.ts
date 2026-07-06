import { describe, expect, it, vi } from "vitest";
import {
  normalizeStateRef,
  readStartupWorkspaceConfig,
  readWorkspaceConfigFromState,
  type StartupWorkspaceConfigVcsReader,
} from "./workspaceConfigSource.js";

const MANIFEST = "initPanels: []\n";
const WORKSPACE_PATH = "/tmp/vibestudio-test-workspace/source";

function textFile(text: string) {
  return { content: { kind: "text" as const, text } };
}

describe("workspace config source", () => {
  it("normalizes bare state hashes without double-prefixing existing state refs", () => {
    expect(normalizeStateRef("abc123")).toBe("state:abc123");
    expect(normalizeStateRef("state:abc123")).toBe("state:abc123");
  });

  it("reads workspace config from an already-prefixed state ref", async () => {
    const readFile = vi.fn(async () => textFile(MANIFEST));

    const config = await readWorkspaceConfigFromState({ readFile }, WORKSPACE_PATH, "state:main");

    expect(config.id).toBe("/tmp/vibestudio-test-workspace");
    expect(readFile).toHaveBeenCalledWith("state:main", "meta/vibestudio.yml");
  });

  it("uses protected main at startup when main refs already exist", async () => {
    const readFile = vi.fn(async () => textFile(MANIFEST));
    const ensureFresh = vi.fn(async () => ({ stateHash: "state:disk" }));
    const workspaceView = vi.fn(async () => ({ stateHash: "state:protected" }));
    const vcs: StartupWorkspaceConfigVcsReader = { readFile, ensureFresh, workspaceView };

    const result = await readStartupWorkspaceConfig(
      vcs,
      { listMains: () => [{ repoPath: "meta" }] },
      WORKSPACE_PATH
    );

    expect(result.source).toBe("protected-main");
    expect(result.stateHash).toBe("state:protected");
    expect(workspaceView).toHaveBeenCalledOnce();
    expect(ensureFresh).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("state:protected", "meta/vibestudio.yml");
  });

  it("falls back to a disk snapshot only before protected main refs exist", async () => {
    const readFile = vi.fn(async () => textFile(MANIFEST));
    const ensureFresh = vi.fn(async () => ({ stateHash: "state:disk" }));
    const workspaceView = vi.fn(async () => ({ stateHash: "state:protected" }));
    const vcs: StartupWorkspaceConfigVcsReader = { readFile, ensureFresh, workspaceView };

    const result = await readStartupWorkspaceConfig(vcs, { listMains: () => [] }, WORKSPACE_PATH);

    expect(result.source).toBe("disk-snapshot");
    expect(result.stateHash).toBe("state:disk");
    expect(workspaceView).not.toHaveBeenCalled();
    expect(ensureFresh).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith("state:disk", "meta/vibestudio.yml");
  });
});
