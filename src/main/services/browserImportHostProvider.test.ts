import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserImportProvider } from "@vibestudio/browser-data";
import type { BrowserVaultNativeClient } from "./browserVaultNativeClient.js";
import { SensitiveBrowserImportLedger } from "./sensitiveBrowserImportLedger.js";
import {
  BrowserImportHostProvider,
  frameChunks,
  MAX_QUEUED_IMPORT_FRAMES,
} from "./browserImportHostProvider.js";

function batchProvider(onStoreComplete: () => void): BrowserImportProvider {
  return {
    listSources: vi.fn(async () => []),
    preview: vi.fn(async () => ({
      dataTypes: [],
      breakdowns: [],
      warnings: [],
      openTabCount: 0,
      localDataSetCount: 0,
    })),
    import: vi.fn(async (sourceId, _types, sink) => {
      await sink.store({
        jobId: "job",
        sourceId,
        dataType: "bookmarks",
        batchIndex: 0,
        idempotencyKey: "batch",
        items: Array.from({ length: (MAX_QUEUED_IMPORT_FRAMES + 2) * 50 }, (_, index) => ({
          index,
        })),
      });
      onStoreComplete();
      return { dataTypes: [], warnings: [] };
    }),
    listOpenTabs: vi.fn(async () => []),
  };
}

function queuedFrames(provider: BrowserImportHostProvider, operationId: string): number {
  return (
    (
      provider as unknown as {
        operations: Map<string, { frames: unknown[] }>;
      }
    ).operations.get(operationId)?.frames.length ?? 0
  );
}

function ledger(): SensitiveBrowserImportLedger {
  return new SensitiveBrowserImportLedger(
    path.join(mkdtempSync(path.join(tmpdir(), "vibestudio-sensitive-import-")), "ledger.json")
  );
}

describe("frameChunks", () => {
  it("splits by item count for small items", () => {
    const frames = frameChunks(Array.from({ length: 120 }, (_, index) => ({ index })));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toHaveLength(50);
    expect(frames[2]).toHaveLength(20);
  });

  it("splits by encoded size when items are large", () => {
    // A favicon-sized base64 payload: a handful of these must not share a frame
    // with 49 others, or the frame exceeds the websocket ingress cap.
    const heavy = { data: "A".repeat(1_500_000) };
    const frames = frameChunks(Array.from({ length: 8 }, () => heavy));
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(JSON.stringify(frame).length).toBeLessThan(16 * 1024 * 1024);
    }
  });

  it("never drops an item and never emits an empty frame", () => {
    const items = Array.from({ length: 37 }, (_, index) => ({
      index,
      pad: "x".repeat(index * 997),
    }));
    const frames = frameChunks(items);
    expect(frames.flat()).toEqual(items);
    expect(frames.every((frame) => frame.length > 0)).toBe(true);
  });

  it("keeps an oversized single item in its own frame rather than dropping it", () => {
    const frames = frameChunks([{ pad: "A".repeat(5_000_000) }, { small: true }]);
    expect(frames[0]).toHaveLength(1);
    expect(frames.flat()).toHaveLength(2);
  });

  it("handles an empty batch", () => {
    expect(frameChunks([])).toEqual([]);
  });
});

describe("BrowserImportHostProvider", () => {
  it("classifies native source and tab discovery failures", async () => {
    const importProvider = batchProvider(() => {});
    importProvider.listSources = vi.fn(async () => {
      throw new Error("Could not scan /private/profile/browser-secret");
    });
    importProvider.listOpenTabs = vi.fn(async () => {
      throw new Error("Could not parse /private/profile/session-secret");
    });
    const nativeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, sensitiveImportLedger: ledger() }
    );

    await expect(provider.listSources()).rejects.toThrow(
      "Browser profiles could not be discovered. Check operating-system browser-data access, then try again."
    );
    await expect(provider.listOpenTabs("source")).rejects.toThrow(
      "Open browser tabs could not be read. Check that the selected browser is available, then try again."
    );
    expect(nativeLog).toHaveBeenCalledTimes(2);
    nativeLog.mockRestore();
  });

  it("keeps native preview diagnostics out of aggregate review results", async () => {
    const importProvider = batchProvider(() => {});
    importProvider.preview = vi.fn(async () => ({
      dataTypes: [],
      breakdowns: [],
      warnings: ["Could not read /private/profile: record fragment secret-value"],
      openTabCount: 0,
      localDataSetCount: 1,
    }));
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, sensitiveImportLedger: ledger() }
    );

    await expect(provider.preview("source", ["passwords"])).resolves.toEqual({
      dataTypes: [],
      breakdowns: [],
      warnings: [
        "Some browser data could not be read. Review the available counts before importing.",
      ],
      openTabCount: 0,
      localDataSetCount: 1,
    });
  });

  it("classifies a native preview failure without exposing its diagnostic", async () => {
    const diagnostic = "Could not open /private/profile: record fragment secret-value";
    const importProvider = batchProvider(() => {});
    importProvider.preview = vi.fn(async () => {
      throw new Error(diagnostic);
    });
    const nativeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, sensitiveImportLedger: ledger() }
    );

    await expect(provider.preview("source", ["passwords"])).rejects.toThrow(
      "Browser data could not be reviewed. Check that the selected browser profile is available, then try again."
    );
    expect(nativeLog).toHaveBeenCalledWith(
      "[BrowserImportHostProvider] Browser import preview failed",
      expect.objectContaining({ message: diagnostic })
    );
    nativeLog.mockRestore();
  });

  it("backpressures the producer until bounded frames are consumed", async () => {
    let storeComplete = false;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      {
        sensitiveImportLedger: ledger(),
        createProvider: async () =>
          batchProvider(() => {
            storeComplete = true;
          }),
      }
    );
    const operationId = provider.startImport("source", ["bookmarks"]);

    await vi.waitFor(() => {
      expect(queuedFrames(provider, operationId)).toBe(MAX_QUEUED_IMPORT_FRAMES);
    });
    expect(storeComplete).toBe(false);

    for (let index = 0; index < MAX_QUEUED_IMPORT_FRAMES + 2; index += 1) {
      await expect(provider.nextFrame(operationId)).resolves.toMatchObject({
        type: "batch",
      });
    }
    await expect(provider.nextFrame(operationId)).resolves.toMatchObject({
      type: "complete",
    });
    expect(storeComplete).toBe(true);
  });

  it("releases a backpressured producer when an import is cancelled", async () => {
    let storeComplete = false;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      {
        sensitiveImportLedger: ledger(),
        createProvider: async () =>
          batchProvider(() => {
            storeComplete = true;
          }),
      }
    );
    const operationId = provider.startImport("source", ["bookmarks"]);
    await vi.waitFor(() => {
      expect(queuedFrames(provider, operationId)).toBe(MAX_QUEUED_IMPORT_FRAMES);
    });

    provider.cancel(operationId);
    await expect(provider.nextFrame(operationId)).resolves.toEqual({
      type: "error",
      message: "Import cancelled",
    });
    await vi.waitFor(() => expect(storeComplete).toBe(true));
  });

  it("keeps native public-import diagnostics out of workspace frames", async () => {
    const diagnostic = "Could not open /private/profile/History: record fragment secret-value";
    const importProvider = batchProvider(() => {});
    importProvider.import = vi.fn(async () => {
      throw new Error(diagnostic);
    });
    const nativeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, sensitiveImportLedger: ledger() }
    );

    const operationId = provider.startImport("source", ["history"]);
    await expect(provider.nextFrame(operationId)).resolves.toEqual({
      type: "error",
      message:
        "Browser data could not be imported. Check that the selected browser profile is available, then try again.",
    });
    expect(nativeLog).toHaveBeenCalledWith(
      "[BrowserImportHostProvider] Browser import failed",
      expect.objectContaining({ message: diagnostic })
    );
    nativeLog.mockRestore();
  });

  it("writes sensitive batches only to the native vault and returns aggregate counts", async () => {
    const importProvider: BrowserImportProvider = {
      listSources: vi.fn(async () => []),
      preview: vi.fn(async () => ({
        dataTypes: [],
        breakdowns: [],
        warnings: [],
        openTabCount: 0,
        localDataSetCount: 0,
      })),
      import: vi.fn(async (sourceId, _types, sink) => {
        await sink.store({
          jobId: "provider-generated-id",
          sourceId,
          dataType: "cookies",
          batchIndex: 0,
          idempotencyKey: "provider-cookie-key",
          items: [
            {
              name: "session",
              value: "cookie-secret",
              domain: "example.com",
              path: "/",
              hostOnly: true,
              secure: true,
              httpOnly: true,
              sameSite: "lax",
            },
          ],
        });
        await sink.store({
          jobId: "provider-generated-id",
          sourceId,
          dataType: "passwords",
          batchIndex: 0,
          idempotencyKey: "provider-password-key",
          items: [
            {
              url: "https://example.com",
              username: "secret-user",
              password: "password-secret",
            },
          ],
        });
        await sink.store({
          jobId: "provider-generated-id",
          sourceId,
          dataType: "formFill",
          batchIndex: 0,
          idempotencyKey: "provider-form-key",
          items: [{ fieldName: "email", value: "form-secret" }],
        });
        return {
          dataTypes: [
            {
              dataType: "cookies" as const,
              itemsProcessed: 1,
              totalItems: 1,
              stored: 1,
              skipped: 2,
              errors: 0,
            },
            {
              dataType: "passwords" as const,
              itemsProcessed: 1,
              totalItems: 1,
              stored: 1,
              skipped: 0,
              errors: 0,
            },
            {
              dataType: "formFill" as const,
              itemsProcessed: 1,
              totalItems: 1,
              stored: 1,
              skipped: 0,
              errors: 0,
            },
          ],
          warnings: ["warning that must remain host-local"],
        };
      }),
      listOpenTabs: vi.fn(async () => []),
    };
    const browserVault = {
      addCookiesBatch: vi.fn(async () => ({ revision: 4 })),
      addPasswordsBatch: vi.fn(async () => 1),
      addFormFillBatch: vi.fn(async () => 1),
    } as unknown as BrowserVaultNativeClient;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, browserVault, sensitiveImportLedger: ledger() }
    );

    const started = provider.startSensitiveImport(
      "source",
      ["formFill", "cookies", "passwords"],
      "stable-operation-id"
    );
    expect(started).toEqual({
      operationId: "stable-operation-id",
      state: "running",
      counts: [
        { dataType: "cookies", read: 0, stored: 0, skipped: 0, errors: 0 },
        { dataType: "passwords", read: 0, stored: 0, skipped: 0, errors: 0 },
        { dataType: "formFill", read: 0, stored: 0, skipped: 0, errors: 0 },
      ],
    });
    await vi.waitFor(() => {
      expect(provider.observeSensitiveImport("stable-operation-id").state).toBe("complete");
    });
    const receipt = provider.observeSensitiveImport("stable-operation-id");

    expect(browserVault.addCookiesBatch).toHaveBeenCalledWith({
      jobId: "stable-operation-id",
      batchIndex: 0,
      cookies: [expect.objectContaining({ value: "cookie-secret" })],
    });
    expect(browserVault.addPasswordsBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ password: "password-secret" })],
      { sourceId: "source" }
    );
    expect(browserVault.addFormFillBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ value: "form-secret" })],
      { sourceId: "source" }
    );
    expect(receipt).toEqual({
      operationId: "stable-operation-id",
      state: "complete",
      counts: [
        { dataType: "cookies", read: 1, stored: 1, skipped: 2, errors: 0 },
        { dataType: "passwords", read: 1, stored: 1, skipped: 0, errors: 0 },
        { dataType: "formFill", read: 1, stored: 1, skipped: 0, errors: 0 },
      ],
    });
    expect(JSON.stringify(receipt)).not.toMatch(/secret|warning/i);
  });

  it("coalesces retries by operation id and rejects reuse with different inputs", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importProvider = batchProvider(() => {});
    importProvider.import = vi.fn(async (sourceId, _types, sink) => {
      await blocked;
      await sink.store({
        jobId: "provider-id",
        sourceId,
        dataType: "passwords",
        batchIndex: 0,
        idempotencyKey: "provider-key",
        items: [{ url: "https://example.com", username: "same-user", password: "same-secret" }],
      });
      return {
        dataTypes: [
          {
            dataType: "passwords" as const,
            itemsProcessed: 1,
            totalItems: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          },
        ],
        warnings: [],
      };
    });
    const browserVault = {
      addCookiesBatch: vi.fn(),
      addPasswordsBatch: vi.fn(async () => 1),
      addFormFillBatch: vi.fn(),
    } as unknown as BrowserVaultNativeClient;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { createProvider: async () => importProvider, browserVault, sensitiveImportLedger: ledger() }
    );

    const first = provider.startSensitiveImport("source", ["passwords"], "retry-id");
    const retry = provider.startSensitiveImport("source", ["passwords"], "retry-id");
    expect(() => provider.startSensitiveImport("other-source", ["passwords"], "retry-id")).toThrow(
      "different inputs"
    );
    release();

    expect(first).toEqual(retry);
    await vi.waitFor(() =>
      expect(provider.observeSensitiveImport("retry-id").state).toBe("complete")
    );
    expect(provider.startSensitiveImport("source", ["passwords"], "retry-id")).toEqual({
      operationId: "retry-id",
      state: "complete",
      counts: [{ dataType: "passwords", read: 1, stored: 1, skipped: 0, errors: 0 }],
    });
    expect(importProvider.import).toHaveBeenCalledOnce();
    expect(browserVault.addPasswordsBatch).toHaveBeenCalledOnce();
  });

  it("keeps native sensitive-import diagnostics out of workspace-visible status", async () => {
    const diagnostic =
      "Could not parse /private/profile/Login Data: record contained password-secret";
    const importProvider = batchProvider(() => {});
    importProvider.import = vi.fn(async () => {
      throw new Error(diagnostic);
    });
    const nativeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      {
        createProvider: async () => importProvider,
        browserVault: {} as BrowserVaultNativeClient,
        sensitiveImportLedger: ledger(),
      }
    );

    provider.startSensitiveImport("source", ["passwords"], "failed-operation");
    await vi.waitFor(() =>
      expect(provider.observeSensitiveImport("failed-operation").state).toBe("failed")
    );

    const status = provider.observeSensitiveImport("failed-operation");
    expect(status).toEqual({
      operationId: "failed-operation",
      state: "failed",
      counts: [{ dataType: "passwords", read: 0, stored: 0, skipped: 0, errors: 0 }],
      error:
        "Protected browser data could not be imported. Check that the selected browser profile is available, then try again.",
    });
    expect(JSON.stringify(status)).not.toContain("/private/profile");
    expect(JSON.stringify(status)).not.toContain("password-secret");
    expect(nativeLog).toHaveBeenCalledWith(
      "[BrowserImportHostProvider] Sensitive import failed-operation failed",
      expect.objectContaining({ message: diagnostic })
    );
    nativeLog.mockRestore();
  });

  it("bounds completed sensitive-import receipt replay", async () => {
    const nativeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const importProvider = batchProvider(() => {});
    importProvider.import = vi.fn(async () => ({ dataTypes: [], warnings: [] }));
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      {
        createProvider: async () => importProvider,
        browserVault: {} as BrowserVaultNativeClient,
        sensitiveImportLedger: ledger(),
      }
    );

    for (let index = 0; index < 35; index += 1) {
      provider.startSensitiveImport("source", ["passwords"], `operation-${index}`);
      await vi.waitFor(() =>
        expect(provider.observeSensitiveImport(`operation-${index}`).state).not.toBe("running")
      );
    }

    expect(() => provider.observeSensitiveImport("operation-2")).toThrow("not found");
    expect(provider.observeSensitiveImport("operation-3").state).toBe("failed");
    expect(provider.observeSensitiveImport("operation-34").state).toBe("failed");
    nativeLog.mockRestore();
  });

  it("rejects sensitive data on the plaintext frame path", () => {
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      { sensitiveImportLedger: ledger() }
    );
    expect(() => provider.startImport("source", ["passwords"] as never)).toThrow(
      "sealed vault import"
    );
  });
});
