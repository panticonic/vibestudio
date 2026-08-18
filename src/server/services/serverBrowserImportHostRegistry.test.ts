import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { ServerBrowserImportHostRegistry } from "./serverBrowserImportHostRegistry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ServerBrowserImportHostRegistry", () => {
  it("reads protected cookies in the host and writes them directly to the caller vault", async () => {
    const statePath = mkdtempSync(path.join(tmpdir(), "server-browser-import-"));
    roots.push(statePath);
    const dispatch = vi.fn(async () => ({ revision: 1 }));
    const registry = new ServerBrowserImportHostRegistry({
      workspaceId: "workspace-a",
      statePath,
      doDispatch: { dispatch } as never,
      createProvider: async () => ({
        listSources: vi.fn(async () => []),
        preview: vi.fn(),
        listOpenTabs: vi.fn(async () => []),
        import: vi.fn(async (sourceId, dataTypes, sink) => {
          expect(sourceId).toBe("firefox-source");
          expect(dataTypes).toEqual(["cookies"]);
          await sink.store({
            jobId: "reader-job",
            sourceId,
            dataType: "cookies",
            batchIndex: 0,
            idempotencyKey: "reader-job:cookies:0",
            items: [
              {
                name: "sid",
                value: "protected-value",
                domain: "example.com",
                hostOnly: true,
                path: "/",
                secure: true,
                httpOnly: true,
                sameSite: "lax",
              },
            ],
          });
          const progress = {
            dataType: "cookies" as const,
            itemsProcessed: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          };
          await sink.progress(progress);
          return { dataTypes: [progress], warnings: [] };
        }),
      }),
    });
    const provider = registry.forContext({
      caller: createVerifiedCaller("extension:browser-data", "extension", null, null, {
        userId: "system",
        handle: "system",
      }),
      authorizingCaller: createVerifiedCaller("shell:alice", "shell", null, null, {
        userId: "user-a",
        handle: "alice",
      }),
    } as never);

    provider.startSensitiveImport("firefox-source", ["cookies"], "operation-a");
    await vi.waitFor(() => {
      expect(provider.observeSensitiveImport("operation-a").state).toBe("complete");
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "vibestudio/internal",
        className: "BrowserVaultDO",
        objectKey: expect.stringMatching(/^v1_/),
      }),
      "addCookiesBatch",
      {
        jobId: "operation-a",
        batchIndex: 0,
        cookies: [expect.objectContaining({ name: "sid", value: "protected-value" })],
      }
    );
    expect(provider.observeSensitiveImport("operation-a")).toEqual({
      operationId: "operation-a",
      state: "complete",
      counts: [{ dataType: "cookies", read: 1, stored: 1, skipped: 0, errors: 0 }],
    });
    registry.stop();
  });
});
