import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { launchChromium } from "../../apps/headless-host/src/browser/launch";
import { CdpConnection } from "../../apps/headless-host/src/browser/cdpConnection";
import { PageHost } from "../../apps/headless-host/src/pageHost";
import { ConsoleHistoryStore } from "../../apps/headless-host/src/consoleHistory";
import { HeadlessBrowserDownloads } from "../../apps/headless-host/src/browserDownloads";
import { BrowserImpl } from "@exact-userland/packages/cdp-client/src/worker";

// Native browser evidence is explicit opt-in; ordinary unit runs need no installed browser.
describe.runIf(process.env["VIBESTUDIO_RUN_CDP_SDK_NATIVE"] === "1")(
  "CDP SDK native lifecycle",
  () => {
    it("uploads bytes, observes network, targets same-origin and cross-origin frames, and owns downloads/popups", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "vibestudio-cdp-sdk-"));
      const peers = new Set<WebSocket>();
      let pages: PageHost | undefined;
      const server = createServer((request, response) => {
        if (request.url === "/file") {
          response.writeHead(200, {
            "Content-Disposition": 'attachment; filename="evidence.txt"',
            "Content-Type": "text/plain",
          });
          response.end("native download bytes");
          return;
        }
        if (request.url === "/api") {
          response.setHeader("Content-Type", "application/json");
          response.end('{"ok":true}');
          return;
        }
        response.setHeader("Content-Type", "text/html");
        if (request.url === "/nested") {
          response.end(
            "<button onclick=\"document.body.dataset.clicked='yes'\">Nested action</button>"
          );
          return;
        }
        if (request.url === "/frame") {
          response.end(
            '<button onclick="document.body.dataset.clicked=\'yes\'">Frame action</button><iframe id="nested" src="/nested"></iframe>'
          );
          return;
        }
        const address = server.address() as { port: number };
        response.end(
          `<h1>SDK evidence</h1><input type="file" hidden id="upload"><a download href="/file">Download</a><button onclick="window.open('/popup')">Popup</button><iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://localhost:${address.port}/frame"></iframe>`
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
      const port = (server.address() as { port: number }).port;
      const sockets = new WebSocketServer({ server });
      sockets.on("connection", (socket) => {
        peers.add(socket);
        socket.on("close", () => peers.delete(socket));
        socket.on("message", async (raw) => {
          const command = JSON.parse(String(raw));
          try {
            const result = await pages!.relaySend(
              "panel-main",
              command.method,
              command.params,
              command.sessionId
            );
            socket.send(
              JSON.stringify({
                id: command.id,
                result,
                ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              })
            );
          } catch (error) {
            socket.send(
              JSON.stringify({
                id: command.id,
                error: { message: String(error) },
                ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              })
            );
          }
        });
      });
      const event = (method: string, params: unknown, sessionId?: string) => {
        for (const peer of peers)
          peer.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
      };
      const investigation = AbortSignal.timeout(50000);
      let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
      let native: CdpConnection | undefined;
      let sdk: Awaited<ReturnType<typeof BrowserImpl.connect>> | undefined;
      let downloads: HeadlessBrowserDownloads | undefined;
      try {
        browser = await launchChromium({
          executablePath: process.env["VIBESTUDIO_CDP_CHROMIUM"] ?? "/usr/bin/google-chrome",
          profileRoot: root,
        });
        native = await CdpConnection.connect(browser.wsEndpoint);
        downloads = new HeadlessBrowserDownloads(native, {
          ownerForFrame: (id) => pages?.ownerForFrame(id),
          approve: async () => true,
          activity: (_id, payload) => event("Vibestudio.download", payload),
        });
        await downloads.start(browser.profileDir);
        pages = new PageHost(native, new ConsoleHistoryStore(), undefined, {
          configureContext: (id) => downloads!.configureContext(id),
          popup: async (id, url) => {
            await pages!.loadPanel({
              slotId: "panel-popup",
              contextId: "test-context",
              panelUrl: new URL(url, `http://127.0.0.1:${port}`).href,
              panelInit: {},
              tabId: 2,
            });
            event("Vibestudio.popup", { popup: { panelId: "panel-popup", url } });
          },
          popupFailed: (_id, error) => event("Vibestudio.popup", { error: error.message }),
        });
        await pages.initializeBrowserActivities();
        pages.onRelayEvent((id, method, params, sessionId) => {
          if (id === "panel-main") event(method, params, sessionId);
        });
        await pages.loadPanel({
          slotId: "panel-main",
          contextId: "test-context",
          panelUrl: `http://127.0.0.1:${port}/`,
          panelInit: {},
          tabId: 1,
        });
        sdk = await BrowserImpl.connect(`ws://127.0.0.1:${port}`, {
          operationSignal: () => investigation,
          browserOperation: (request, signal) =>
            downloads!.operation("panel-main", request, signal ?? new AbortController().signal),
        });
        const page = sdk.contexts()[0]!.pages()[0]!;
        console.info("native SDK stage: upload");
        await page.locator("#upload").setInputFiles({
          name: "upload.txt",
          mimeType: "text/plain",
          buffer: new Uint8Array([0, 255, 65]),
        });
        expect(
          await page.evaluate(async () =>
            Array.from(
              new Uint8Array(
                await (
                  document.querySelector("#upload") as HTMLInputElement
                ).files![0]!.arrayBuffer()
              )
            )
          )
        ).toEqual([0, 255, 65]);
        console.info("native SDK stage: network");
        const response = page.waitForResponse((value) => value.url().endsWith("/api"));
        await page.evaluate(() => fetch("/api"));
        expect(await (await response).json()).toEqual({ ok: true });
        console.info("native SDK stage: frames");
        for (const selector of ["#same", "#cross"]) {
          const frame = page.frameLocator(selector);
          expect(await frame.getByRole("button", { name: "Frame action" }).innerText()).toBe(
            "Frame action"
          );
          await frame.getByRole("button", { name: "Frame action" }).click();
          expect(await frame.evaluate(() => document.body.dataset.clicked)).toBe("yes");
          const nested = frame.frameLocator("#nested");
          await nested.getByRole("button", { name: "Nested action" }).click();
          expect(await nested.evaluate(() => document.body.dataset.clicked)).toBe("yes");
        }
        console.info("native SDK stage: download");
        const downloaded = page.waitForDownload();
        await page.getByRole("link", { name: "Download" }).click();
        const download = await downloaded;
        expect(download.suggestedFilename()).toBe("evidence.txt");
        expect(new TextDecoder().decode(await download.body())).toBe("native download bytes");
        console.info("native SDK stage: popup");
        const popup = page.waitForPopup();
        await page.getByRole("button", { name: "Popup" }).click();
        expect((await popup).panelId).toBe("panel-popup");
      } finally {
        const failures: unknown[] = [];
        const release = async (cleanup: () => unknown) => {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        };
        await release(() => sdk?.close());
        await release(() => downloads?.stop());
        await release(() => pages?.unloadPanel("panel-popup"));
        await release(() => pages?.unloadPanel("panel-main"));
        native?.close();
        await release(() => browser?.stop());
        for (const peer of peers) peer.close();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        await rm(root, { recursive: true, force: true });
        if (failures.length) throw new AggregateError(failures, "Native SDK test cleanup failed");
      }
    }, 60000); // Investigation containment only; finally owns browser/socket/file cleanup.
  }
);
