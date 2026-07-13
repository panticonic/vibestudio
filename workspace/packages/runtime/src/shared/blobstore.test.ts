import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { createBlobstoreClient } from "./blobstore.js";

describe("createBlobstoreClient", () => {
  it("provides a portable readText alias over the canonical text read", async () => {
    const digest = "a".repeat(64);
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        expect(method).toBe("blobstore.getText");
        expect(args).toEqual([digest]);
        return "hello";
      }),
    };
    const client = createBlobstoreClient(rpc as never);

    await expect(client.readText(digest)).resolves.toBe("hello");
  });

  it("materializes through caller-scoped fs without invoking the admin host materializer", async () => {
    const firstDigest = "a".repeat(64);
    const secondDigest = "b".repeat(64);
    const files = new Map<string, Buffer>([["/checkout/same.txt", Buffer.from("same")]]);
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "blobstore.listTree") {
          return [
            { path: "nested", kind: "dir", treeHash: `manifest:${"c".repeat(64)}` },
            { path: "same.txt", kind: "file", contentHash: firstDigest, mode: 33188 },
            { path: "nested/run.sh", kind: "file", contentHash: secondDigest, mode: 33261 },
          ];
        }
        if (method === "blobstore.getBase64") {
          return Buffer.from(args[0] === firstDigest ? "same" : "#!/bin/sh\n").toString("base64");
        }
        throw new Error(`Unexpected RPC method ${method}`);
      }),
    };
    const fs = {
      mkdir: vi.fn(async () => undefined),
      exists: vi.fn(async (path: string) => files.has(path)),
      readFile: vi.fn(async (path: string) => files.get(path)!),
      writeFile: vi.fn(async (path: string, value: Uint8Array) => {
        files.set(path, Buffer.from(value));
      }),
      chmod: vi.fn(async () => undefined),
    };

    const client = createBlobstoreClient(rpc as never, fs as never);
    await expect(
      client.materializeTree(`manifest:${"d".repeat(64)}`, "/checkout")
    ).resolves.toEqual({ written: 1, unchanged: 1 });
    expect(files.get("/checkout/nested/run.sh")?.toString()).toBe("#!/bin/sh\n");
    expect(fs.chmod).toHaveBeenCalledWith("/checkout/same.txt", 33188);
    expect(fs.chmod).toHaveBeenCalledWith("/checkout/nested/run.sh", 33261);
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "blobstore.materializeTree",
      expect.anything()
    );
  });

  it("rejects hardlink materialization because the scoped runtime fs cannot honor it", async () => {
    const rpc = { call: vi.fn() };
    const fs = { mkdir: vi.fn() };
    const client = createBlobstoreClient(rpc as never, fs as never);

    await expect(
      client.materializeTree(`manifest:${"d".repeat(64)}`, "/checkout", { link: true })
    ).rejects.toThrow(/link.*not supported.*runtime filesystem/i);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("rejects traversal paths even if a malformed service response contains one", async () => {
    const rpc = {
      call: vi.fn(async (_target: string, method: string) =>
        method === "blobstore.listTree"
          ? [{ path: "../escape", kind: "file", contentHash: "a".repeat(64), mode: 33188 }]
          : Buffer.from("bad").toString("base64")
      ),
    };
    const fs = { mkdir: vi.fn(async () => undefined) };
    const client = createBlobstoreClient(rpc as never, fs as never);

    await expect(client.materializeTree(`manifest:${"d".repeat(64)}`, "/checkout")).rejects.toThrow(
      /Unsafe tree path/
    );
  });
});
