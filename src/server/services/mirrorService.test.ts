import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createMirrorService, type MirrorServiceDeps } from "./mirrorService.js";

/** A tiny CAS: path → bytes, plus a state → file-list index. */
function fixture() {
  const blobs = new Map<string, Buffer>();
  const put = (content: string | Buffer): string => {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    const hash = `h${blobs.size}`;
    blobs.set(hash, buf);
    return hash;
  };
  const files = [
    { path: "src/a.ts", contentHash: put("export const a = 1;\n"), mode: 33188 },
    { path: "bin/run", contentHash: put("#!/bin/sh\n"), mode: 33261 },
    { path: "img.bin", contentHash: put(Buffer.from([0, 1, 2, 255])), mode: 33188 },
  ];
  const deps: MirrorServiceDeps = {
    contextRepoTargets: async (contextId) => [
      { repoPath: "packages/x", stateHash: `state-${contextId}` },
    ],
    listStateFiles: async () => files,
    readBlob: async (hash) => blobs.get(hash) ?? null,
  };
  return { deps, blobs, files };
}

const CALLER = { caller: createVerifiedCaller("shell:dev", "shell") };
const AGENT_CALLER = {
  caller: createVerifiedCaller("agent:session-1", "agent", null, {
    entityId: "session-1",
    contextId: "ctx-agent",
    channelId: "chan-1",
    agentId: "agent:session-1",
  }),
};

describe("createMirrorService", () => {
  it("targets returns the context's per-repo states", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);
    const result = await service.handler(CALLER, "targets", [{ contextId: "ctx_9" }]);
    expect(result).toEqual([{ repoPath: "packages/x", stateHash: "state-ctx_9" }]);
  });

  it("agent targets are pinned to the host-verified bound context", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);

    await expect(
      service.handler(AGENT_CALLER, "targets", [{ contextId: "ctx-foreign" }])
    ).rejects.toThrow(/must match the connection's entity binding/);

    await expect(
      service.handler(AGENT_CALLER, "targets", [{ contextId: "ctx-agent" }])
    ).resolves.toEqual([{ repoPath: "packages/x", stateHash: "state-ctx-agent" }]);
  });

  it("objects streams the tree as base64 with mode + size, sorted by path", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);
    const { files } = (await service.handler(CALLER, "objects", [{ stateHash: "s" }])) as {
      files: Array<{ path: string; mode: number; content: string; size: number }>;
      next?: string;
    };
    expect(files.map((f) => f.path)).toEqual(["bin/run", "img.bin", "src/a.ts"]);
    const bin = files.find((f) => f.path === "img.bin")!;
    expect(Buffer.from(bin.content, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
    const run = files.find((f) => f.path === "bin/run")!;
    expect(run.mode).toBe(33261);
    const a = files.find((f) => f.path === "src/a.ts")!;
    expect(a.size).toBe(Buffer.from("export const a = 1;\n").length);
  });

  it("objects honors a paths filter", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);
    const result = (await service.handler(CALLER, "objects", [
      { stateHash: "s", paths: ["src/a.ts"] },
    ])) as { files: Array<{ path: string }>; next?: string };
    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(result.next).toBeUndefined();
  });

  it("agent objects require a state hash returned by an authorized targets call", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);

    await expect(
      service.handler(AGENT_CALLER, "objects", [{ stateHash: "state-ctx-foreign" }])
    ).rejects.toThrow(/not authorized/);

    await service.handler(AGENT_CALLER, "targets", [{ contextId: "ctx-agent" }]);
    await expect(
      service.handler(AGENT_CALLER, "objects", [{ stateHash: "state-ctx-agent" }])
    ).resolves.toMatchObject({ files: expect.any(Array) });
  });

  it("agent objects fail closed when the verified binding is missing", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);

    await expect(
      service.handler({ caller: createVerifiedCaller("agent:session-1", "agent") }, "objects", [
        { stateHash: "state-ctx-agent" },
      ])
    ).rejects.toThrow(/agent caller has no entity binding/);
  });

  it("objects fails when the CAS listing references a missing blob", async () => {
    const { deps, blobs, files } = fixture();
    blobs.delete(files[0]!.contentHash);
    const service = createMirrorService(deps);
    await expect(service.handler(CALLER, "objects", [{ stateHash: "s" }])).rejects.toThrow(
      /missing blob/
    );
  });

  it("objects transfers every file exactly once and terminates the cursor loop", async () => {
    const { deps } = fixture();
    const service = createMirrorService(deps);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await service.handler(CALLER, "objects", [
        { stateHash: "s", ...(cursor ? { cursor } : {}) },
      ])) as { files: Array<{ path: string }>; next?: string };
      for (const f of page.files) seen.push(f.path);
      cursor = page.next;
    } while (cursor);
    // All three transferred exactly once regardless of paging.
    expect(seen.sort()).toEqual(["bin/run", "img.bin", "src/a.ts"]);
  });
});
