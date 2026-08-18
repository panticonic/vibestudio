import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ImportBatchSink } from "@vibestudio/browser-data";
import { ServerBrowserImportHostRegistry } from "./serverBrowserImportHostRegistry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function browserExtensionCaller(version = "ev-browser-data") {
  const caller = createVerifiedCaller(
    "@workspace-extensions/browser-data",
    "extension",
    {
      callerId: "@workspace-extensions/browser-data",
      callerKind: "extension",
      repoPath: "extensions/browser-data",
      effectiveVersion: version,
      executionDigest: version.padEnd(64, "b").slice(0, 64),
      requested: [],
    },
    null,
    { userId: "system", handle: "system" }
  );
  caller.codeApproved = true;
  return caller;
}

function initiatingContext() {
  return {
    caller: browserExtensionCaller(),
    authorizingCaller: createVerifiedCaller("shell:alice", "shell", null, null, {
      userId: "user-a",
      handle: "alice",
    }),
  } as never;
}

function detachedContext(version?: string) {
  return { caller: browserExtensionCaller(version) } as never;
}

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
        openImport: vi.fn(async (sourceId, dataTypes) => ({
          consume: async (sink: ImportBatchSink) => {
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
          },
        })),
      }),
    });
    const context = initiatingContext();

    registry.startSensitiveImport(context, "firefox-source", ["cookies"], "operation-a");
    await vi.waitFor(() => {
      expect(registry.observeSensitiveImport(detachedContext(), "operation-a").state).toBe(
        "complete"
      );
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
    expect(registry.observeSensitiveImport(detachedContext(), "operation-a")).toEqual({
      operationId: "operation-a",
      state: "complete",
      counts: [{ dataType: "cookies", read: 1, stored: 1, skipped: 0, errors: 0 }],
    });
    registry.stop();
  });

  it("consumes and cancels an opaque read after the verified parent invocation is gone", async () => {
    const statePath = mkdtempSync(path.join(tmpdir(), "server-browser-import-"));
    roots.push(statePath);
    const registry = new ServerBrowserImportHostRegistry({
      workspaceId: "workspace-a",
      statePath,
      doDispatch: { dispatch: vi.fn() } as never,
      createProvider: async () => ({
        listSources: vi.fn(async () => []),
        preview: vi.fn(),
        listOpenTabs: vi.fn(async () => []),
        openImport: vi.fn(async (sourceId) => ({
          consume: async (sink: ImportBatchSink) => {
            await sink.store({
              jobId: "reader-job",
              sourceId,
              dataType: "bookmarks",
              batchIndex: 0,
              idempotencyKey: "reader-job:bookmarks:0",
              items: Array.from({ length: 60 }, (_, index) => ({ index })),
            });
            const progress = {
              dataType: "bookmarks" as const,
              itemsProcessed: 60,
              totalItems: 60,
              stored: 60,
              skipped: 0,
              errors: 0,
            };
            await sink.progress(progress);
            return { dataTypes: [progress], warnings: [] };
          },
        })),
      }),
    });

    const handle = registry.startImportRead(initiatingContext(), "chromium-source", ["bookmarks"]);
    expect(handle).toMatch(/^bir_[A-Za-z0-9_-]{32}$/);

    const detached = detachedContext();
    await expect(registry.nextImportFrame(detached, handle)).resolves.toMatchObject({
      type: "batch",
      batchIndex: 0,
      items: expect.arrayContaining([{ index: 0 }]),
    });
    await expect(registry.nextImportFrame(detached, handle)).resolves.toMatchObject({
      type: "batch",
      batchIndex: 1,
      items: expect.arrayContaining([{ index: 59 }]),
    });
    await expect(registry.nextImportFrame(detached, handle)).resolves.toMatchObject({
      type: "progress",
    });
    await expect(registry.nextImportFrame(detached, handle)).resolves.toMatchObject({
      type: "complete",
    });
    await expect(registry.nextImportFrame(detached, handle)).rejects.toMatchObject({
      code: "EACCES",
    });

    const cancelled = registry.startImportRead(initiatingContext(), "chromium-source", ["history"]);
    expect(() => registry.cancelImportRead(detachedContext("ev-other"), cancelled)).toThrow(
      "invalid or expired"
    );
    registry.cancelImportRead(detached, cancelled);
    await expect(registry.nextImportFrame(detached, cancelled)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(() => registry.cancelImportRead(detached, "bir_unknown")).toThrow("invalid or expired");
    registry.stop();
  });
});
