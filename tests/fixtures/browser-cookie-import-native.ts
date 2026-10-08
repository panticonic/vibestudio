import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";
import type { BrowserCookieInput, ImportBatchSink } from "@vibestudio/browser-data";
import { browserEnvironmentPartition } from "@vibestudio/shared/panelInterfaces";
import { scopedNativePartition } from "../../src/main/nativeStorageScope";
import {
  createBrowserCookieProjectionService,
  cookieContentHash,
} from "../../src/main/services/browserCookieProjection";
import { BrowserImportHostProvider } from "../../src/main/services/browserImportHostProvider";
import { SensitiveBrowserImportLedger } from "../../src/main/services/sensitiveBrowserImportLedger";

const root = process.env["VIBESTUDIO_COOKIE_NATIVE_ROOT"]!;
const phase = process.env["VIBESTUDIO_COOKIE_NATIVE_PHASE"]!;
app.setPath("userData", path.join(root, "profile"));

void app
  .whenReady()
  .then(async () => {
    const canonicalPath = path.join(root, "canonical.json");
    let canonical: BrowserCookieInput[] =
      phase === "restart" ? JSON.parse(await readFile(canonicalPath, "utf8")) : [];
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.end(
        request.headers.cookie?.includes("sid=fixture-session") ? "logged in" : "logged out"
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const identity = {
      workspaceId: "fixture",
      ownerUserId: "fixture-user",
      environmentKey: "fixture-environment",
    };
    const partition = scopedNativePartition(
      "fixture-account",
      browserEnvironmentPartition(identity.environmentKey)
    );
    const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } });
    let provider: BrowserImportHostProvider | undefined;
    const vault = {
      listCookieOrigins: async () => ({
        revision: canonical.length,
        origins: canonical.length ? [url] : [],
      }),
      getCookiesForOrigin: async () =>
        canonical.map((cookie) => ({
          ...cookie,
          revision: canonical.length,
          encryptedValue: "fixture",
          contentHash: cookieContentHash(cookie),
          createdAt: 1,
        })),
      addCookiesBatch: async ({ cookies }: { cookies: BrowserCookieInput[] }) => {
        canonical = cookies;
        await writeFile(canonicalPath, JSON.stringify(canonical));
        return { revision: canonical.length };
      },
      applyCookieMutations: async () => {
        throw new Error("Canonical fixture must not be overwritten by rejected projection");
      },
    };
    const projection = createBrowserCookieProjectionService({
      nativeStorageScope: "fixture-account",
      hostId: "fixture",
      outboxRoot: root,
      browserVault: vault as never,
      browserDataClient: { getBrowserEnvironment: async () => identity } as never,
      serverClient: {
        onRecovery: () => () => {},
        onConnectionStatusChange: () => () => {},
        call: async () => null,
        stream: async (
          _service: string,
          _method: string,
          _args: unknown[],
          options: { signal: AbortSignal }
        ) =>
          new ReadableStream({
            start(controller) {
              options.signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
      } as never,
    });
    try {
      if (phase === "import") {
        await window.loadURL(url);
        assert.equal(
          await window.webContents.executeJavaScript("document.body.textContent"),
          "logged out"
        );
      }
      await projection.start?.(() => undefined);
      await projection.recover();
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      class FixtureLedger extends SensitiveBrowserImportLedger {
        override complete(...args: Parameters<SensitiveBrowserImportLedger["complete"]>) {
          const status = super.complete(...args);
          complete();
          return status;
        }
      }
      const ledger = new FixtureLedger(path.join(root, "import-ledger.json"));
      let sourceReads = 0;
      provider = new BrowserImportHostProvider(
        { hostId: "fixture", displayName: "Fixture" },
        {
          browserVault: vault as never,
          sensitiveImportLedger: ledger,
          applyCookies: (signal) => projection.applyCookies(signal),
          createProvider: async () =>
            ({
              openImport: async (sourceId: string) => ({
                consume: async (sink: ImportBatchSink) => {
                  assert.equal(phase, "import", "Restart must not reread an imported source");
                  sourceReads += 1;
                  await sink.store({
                    jobId: "fixture",
                    sourceId,
                    dataType: "cookies",
                    batchIndex: 0,
                    idempotencyKey: "fixture:0",
                    items: [
                      {
                        name: "sid",
                        value: "fixture-session",
                        domain: "127.0.0.1",
                        hostOnly: true,
                        path: "/",
                        secure: false,
                        httpOnly: true,
                        sameSite: "lax",
                        sourceScheme: "nonsecure",
                        sourcePort: address.port,
                      },
                    ],
                  });
                  return {
                    dataTypes: [
                      { dataType: "cookies", itemsProcessed: 1, stored: 1, skipped: 0, errors: 0 },
                    ],
                    warnings: [],
                  };
                },
              }),
            }) as never,
        }
      );
      if (phase === "import") {
        const before = requests;
        provider.startSensitiveImport("fixture-source", ["cookies"], "fixture-operation");
        await completed;
        assert.equal(requests, before, "Applying cookies must not reload a page with unsaved work");
        assert.equal(
          await window.webContents.executeJavaScript("document.body.textContent"),
          "logged out"
        );
      } else {
        assert.equal(ledger.observe("fixture-operation").state, "complete");
        await projection.applyCookies(new AbortController().signal);
      }
      await window.loadURL(url);
      assert.equal(
        await window.webContents.executeJavaScript("document.body.textContent"),
        "logged in"
      );
      assert.equal(sourceReads, phase === "import" ? 1 : 0);
      assert.equal(
        (await session.fromPartition("persist:fixture-unrelated").cookies.get({})).length,
        0
      );
      console.log(JSON.stringify({ phase, authenticated: true, sourceReads, isolated: true }));
    } finally {
      await provider?.stop();
      await projection.stop?.(undefined);
      window.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
