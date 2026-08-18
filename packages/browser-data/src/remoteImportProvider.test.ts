import { describe, expect, it, vi } from "vitest";
import { RemoteBrowserImportProvider } from "./remoteImportProvider.js";

describe("RemoteBrowserImportProvider", () => {
  it("acquires the host read before returning background consumption", async () => {
    const calls: string[] = [];
    const call = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "startImportRead") return "operation-1";
      if (method === "nextImportFrame") {
        return { type: "complete", summary: { dataTypes: [], warnings: [] } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const provider = new RemoteBrowserImportProvider(
      call as unknown as <T>(method: string, ...args: unknown[]) => Promise<T>
    );

    const read = await provider.openImport(
      "firefox:default",
      ["bookmarks"],
      new AbortController().signal
    );
    expect(calls).toEqual(["startImportRead"]);

    await expect(read.consume({ store: vi.fn(), progress: vi.fn() })).resolves.toEqual({
      dataTypes: [],
      warnings: [],
    });
    expect(calls).toEqual(["startImportRead", "nextImportFrame"]);
  });
});
