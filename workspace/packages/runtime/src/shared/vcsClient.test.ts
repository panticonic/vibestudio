import { describe, expect, it, vi } from "vitest";
import { createVcsClient } from "./vcsClient.js";

describe("createVcsClient history defaults", () => {
  it("routes fileHistory through the runtime's own context head by default", async () => {
    const call = vi.fn(async (targetId: string, method: string, args: unknown[]) => {
      if (targetId === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "workers/gad-store",
          className: "GadWorkspaceDO",
          objectKey: "workspace",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace",
        };
      }
      if (method === "vcsFileHistory") return [];
      throw new Error(`unexpected call ${targetId}.${method}(${JSON.stringify(args)})`);
    });
    const client = createVcsClient(
      async () => null as never,
      {
        call: async <T>(targetId: string, method: string, args: unknown[]) =>
          (await call(targetId, method, args)) as T,
        on: () => () => {},
      },
      { logHead: "ctx:context-1", pushSourceHead: "ctx:context-1" }
    );

    await expect(
      client.fileHistory({ repoPath: "projects/example", path: "note.txt" })
    ).resolves.toEqual([]);

    expect(call).toHaveBeenLastCalledWith(
      "do:workers/gad-store:GadWorkspaceDO:workspace",
      "vcsFileHistory",
      ["projects/example", "note.txt", "ctx:context-1", null]
    );
  });

  it("accepts a full workspace path for fileHistory", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    const rpc = {
      call: async <T>(targetId: string, method: string, args: unknown[]): Promise<T> => {
        calls.push({ targetId, method, args });
        if (method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "workers/gad-store",
            className: "GadWorkspaceDO",
            objectKey: "workspace",
            targetId: "do:gad",
          } as T;
        }
        return [] as T;
      },
      on: () => () => {},
    };
    const client = createVcsClient(async () => null as never, rpc, {
      logHead: "ctx:context-1",
    });

    await client.fileHistory({ path: "meta/provenance.txt" });

    expect(calls.at(-1)).toEqual({
      targetId: "do:gad",
      method: "vcsFileHistory",
      args: ["meta", "provenance.txt", "ctx:context-1", null],
    });
  });

  it("rejects a repo-relative path without guessing across repo logs", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    const rpc = {
      call: async <T>(targetId: string, method: string, args: unknown[]): Promise<T> => {
        calls.push({ targetId, method, args });
        if (method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "do:gad" } as T;
        }
        return [] as T;
      },
      on: () => () => {},
    };
    const client = createVcsClient(async () => null as never, rpc, {
      logHead: "ctx:context-1",
    });

    expect(() => client.fileHistory({ path: ".tmp-history.txt" })).toThrow(
      /full workspace file path/i
    );
    expect(calls).toEqual([]);
  });

  it("accepts an explicit repo-relative file address", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    const rpc = {
      call: async <T>(targetId: string, method: string, args: unknown[]): Promise<T> => {
        calls.push({ targetId, method, args });
        if (method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "do:gad" } as T;
        }
        return [] as T;
      },
      on: () => () => {},
    };
    const client = createVcsClient(async () => null as never, rpc, {
      logHead: "ctx:context-1",
    });

    await client.fileHistory({ path: "note.txt", repoPath: "meta" });

    expect(calls.at(-1)).toEqual({
      targetId: "do:gad",
      method: "vcsFileHistory",
      args: ["meta", "note.txt", "ctx:context-1", null],
    });
  });

  it("forwards a sole commit row's fields on the result array", async () => {
    const row = {
      repoPath: "meta",
      head: "ctx:one",
      stateHash: "state:one",
      eventId: "event-1",
      headHash: "head-1",
      editCount: 1,
      status: "committed" as const,
      changedPaths: ["a.txt"],
    };
    const client = createVcsClient(async (method) => {
      if (method === "vcs.commit") return [row] as never;
      return null as never;
    });

    const result = await client.commit({ message: "one", repoPaths: ["meta"] });

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toEqual(row);
    expect(result.eventId).toBe("event-1");
  });
});
