import { describe, expect, it, vi } from "vitest";
import { resolveWorkspaceService } from "./workspaceServices.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  normalizeStateRef,
  readWorkspaceConfigFromState,
  readWorkspaceDeclarationsFromState,
} from "./workspaceConfigSource.js";

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
    const readFile = vi.fn(async (_ref: string, filePath: string) =>
      filePath === "meta/vibestudio.yml" ? textFile(MANIFEST) : null
    );

    const config = await readWorkspaceConfigFromState({ readFile }, WORKSPACE_ID, "state:main");

    expect(config.id).toBe(WORKSPACE_ID);
    expect(readFile).toHaveBeenCalledWith("state:main", "meta/vibestudio.yml");
  });
  it("coalesces one exact state across callers without sharing mutable configuration", async () => {
    const readFile = vi.fn(async (_ref: string, filePath: string) =>
      filePath === "meta/vibestudio.yml" ? textFile(MANIFEST) : null
    );
    const reader = { readFile };
    const [first, concurrent] = await Promise.all([
      readWorkspaceConfigFromState(reader, WORKSPACE_ID, "state:one"),
      readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one"),
    ]);
    const reads = readFile.mock.calls.length;
    if (!first.initPanels) throw new Error("Expected configured initial panels");
    first.initPanels.push("changed" as never);
    expect(concurrent.initPanels).toEqual([]);
    expect((await readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one")).initPanels).toEqual(
      []
    );
    expect(readFile).toHaveBeenCalledTimes(reads);
    await readWorkspaceConfigFromState(reader, WORKSPACE_ID, "two");
    expect(readFile.mock.calls.length).toBeGreaterThan(reads);
    expect(readFile).toHaveBeenCalledWith("state:two", "meta/vibestudio.yml");
  });

  it("keeps readers and workspace identities independent and preserves failed reads", async () => {
    const original = new Error("original config read failure");
    let fail = true;
    const readFile = vi.fn(async (_ref: string, filePath: string) => {
      if (fail) throw original;
      return filePath === "meta/vibestudio.yml" ? textFile(MANIFEST) : null;
    });
    const reader = { readFile };
    await expect(readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one")).rejects.toThrow(
      original.message
    );
    await expect(readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one")).rejects.toMatchObject({
      cause: original,
    });
    fail = false;
    expect((await readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one")).id).toBe(WORKSPACE_ID);
    expect((await readWorkspaceConfigFromState(reader, "ws_other", "one")).id).toBe("ws_other");
    const second = {
      readFile: vi.fn(async (_ref: string, filePath: string) =>
        filePath === "meta/vibestudio.yml" ? textFile(MANIFEST) : null
      ),
    };
    await readWorkspaceConfigFromState(second, WORKSPACE_ID, "one");
    expect(second.readFile).toHaveBeenCalledWith("state:one", "meta/vibestudio.yml");
  });

  it("borrows one immutable declaration snapshot and observes package changes at a new state", async () => {
    const manifest = `${MANIFEST}singletonObjects:\n  - source: workers/store\n    className: Store\n    key: store\nservices:\n  - source: workers/store\n    name: store\n`;
    const readFile = vi.fn(async (ref: string, filePath: string) => {
      if (filePath === "meta/vibestudio.yml") return textFile(manifest);
      if (filePath === "workers/store/package.json")
        return textFile(
          JSON.stringify({
            vibestudio: {
              services: [
                {
                  name: "store",
                  action: "read the store",
                  presentation: { domain: "files", verb: "see" },
                  authority: {
                    principals: ref === "state:two" ? ["host"] : ["code"],
                    binding: { declaredFor: ["workers/consumer"] },
                  },
                  durableObject: { className: "Store" },
                },
              ],
            },
          })
        );
      return null;
    });
    const reader = { readFile };
    const [first, concurrent] = await Promise.all([
      readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "one"),
      readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "state:one"),
    ]);
    expect(first).toBe(concurrent);
    const reads = readFile.mock.calls.length;
    expect(await readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "one")).toBe(first);
    expect(readFile).toHaveBeenCalledTimes(reads);
    const service = first.services[0]!;
    expect(() => service.authority.principals.push("host")).toThrow(TypeError);
    expect(() => {
      service.durableObject!.className = "Other";
    }).toThrow(TypeError);
    expect(() => {
      first.singletons.find("workers/store", "Store")!.key = "other";
    }).toThrow(TypeError);
    expect(() => {
      first.services = [];
    }).toThrow(TypeError);
    const config = await readWorkspaceConfigFromState(reader, WORKSPACE_ID, "one");
    config.services![0]!.authority.principals.push("user");
    expect(first.services[0]!.authority.principals).toEqual(["code"]);
    const resolved = resolveWorkspaceService(first, "store");
    resolved.authority.principals.push("user");
    resolved.presentation.domain = "automation";
    expect(first.services[0]!.authority.principals).toEqual(["code"]);
    expect(first.services[0]!.presentation.domain).toBe("files");
    const next = await readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "two");
    expect(next).not.toBe(first);
    expect(next.services[0]!.authority.principals).toEqual(["host"]);
    expect(first.services[0]!.authority.principals).toEqual(["code"]);
    expect(readFile).toHaveBeenCalledWith("state:two", "workers/store/package.json");
    expect(await readWorkspaceDeclarationsFromState(reader, "ws_other", "one")).not.toBe(first);
    expect(await readWorkspaceDeclarationsFromState({ readFile }, WORKSPACE_ID, "one")).not.toBe(
      first
    );
  });

  it("preserves failed declaration reads and recovers only from a new successful owner read", async () => {
    const original = new Error("immutable configuration read failed");
    let fail = true;
    const reader = {
      readFile: async (_ref: string, filePath: string) => {
        if (fail) throw original;
        return filePath === "meta/vibestudio.yml" ? textFile(MANIFEST) : null;
      },
    };
    await expect(
      readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "one")
    ).rejects.toMatchObject({ cause: original });
    fail = false;
    expect(
      (await readWorkspaceDeclarationsFromState(reader, WORKSPACE_ID, "one")).services
    ).toEqual([]);
  });
});
