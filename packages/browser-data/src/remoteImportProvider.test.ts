import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { browserEnvironmentMethods } from "@vibestudio/service-schemas/browserEnvironment";
import { describe, expect, it, vi } from "vitest";
import { RemoteBrowserImportProvider } from "./remoteImportProvider.js";

describe("RemoteBrowserImportProvider", () => {
  it("acquires the host read before returning background consumption", async () => {
    const calls: string[] = [];
    const call = vi.fn(async (method: string, ..._args: unknown[]) => {
      calls.push(method);
      if (method === "startImportRead") return "operation-1";
      if (method === "nextImportFrame") {
        return { type: "complete", summary: { dataTypes: [], warnings: [] } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const provider = new RemoteBrowserImportProvider(
      "device:test",
      createTypedServiceClient(
        "browserEnvironment",
        browserEnvironmentMethods,
        (_service, method, args) => call(method, ...args)
      )
    );

    const read = await provider.openImport(
      "firefox:default",
      ["bookmarks"],
      new AbortController().signal
    );
    expect(calls).toEqual(["startImportRead"]);
    expect(call).toHaveBeenNthCalledWith(1, "startImportRead", "device:test", "firefox:default", [
      "bookmarks",
    ]);

    await expect(read.consume({ store: vi.fn(), progress: vi.fn() })).resolves.toEqual({
      dataTypes: [],
      warnings: [],
    });
    expect(calls).toEqual(["startImportRead", "nextImportFrame"]);
  });
});
