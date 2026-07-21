import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { normalizeStateRef, readWorkspaceConfigFromState } from "./workspaceConfigSource.js";

const MANIFEST = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ninitPanels: []\n`;
const WORKSPACE_ID = "ws_opaque_test";

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

    const config = await readWorkspaceConfigFromState({ readFile }, WORKSPACE_ID, "state:main");

    expect(config.id).toBe(WORKSPACE_ID);
    expect(readFile).toHaveBeenCalledWith("state:main", "meta/vibestudio.yml");
  });
});
