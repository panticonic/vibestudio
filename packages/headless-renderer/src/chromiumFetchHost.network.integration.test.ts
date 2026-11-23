import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Ownership } from "@vibestudio/shared/ownership";
import { launchChromium } from "./browser/launch.js";
import { CdpConnection } from "./browser/cdpConnection.js";
import { ChromiumFetchHost } from "./chromiumFetchHost.js";

// Opt in on an equipped native host; this exercises Chromium's actual context proxy rather than a fake CDP.
describe("Chromium network boundary", () => {
  it.runIf(Boolean(process.env.VIBESTUDIO_TEST_CHROMIUM))(
    "blocks private navigation, redirects and subresources while allowing its exact local grant",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "vibe-chromium-network-"));
      const ownership = await Ownership.open({ profileDir: root, lifetime: "leased" });
      let forbiddenReads = 0;
      const forbidden = createServer((_req, res) => {
        forbiddenReads++;
        res.end("private");
      });
      const allowed = createServer((req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { location: forbiddenOrigin });
          res.end();
          return;
        }
        res.setHeader("content-type", "text/html");
        res.end(
          `<html><body>authorized source<img src="${forbiddenOrigin}/image"><script>fetch('${forbiddenOrigin}/script')</script></body></html>`
        );
      });
      await Promise.all([
        new Promise<void>((r) => forbidden.listen(0, "127.0.0.1", r)),
        new Promise<void>((r) => allowed.listen(0, "127.0.0.1", r)),
      ]);
      const forbiddenOrigin = `http://127.0.0.1:${(forbidden.address() as { port: number }).port}`;
      const origin = `http://127.0.0.1:${(allowed.address() as { port: number }).port}`;
      let cdp: CdpConnection | undefined;
      try {
        const chromium = await launchChromium({
          executablePath: process.env.VIBESTUDIO_TEST_CHROMIUM!,
          profileRoot: root,
          ownership,
        });
        cdp = await CdpConnection.connect(chromium.wsEndpoint);
        const attemptedUrls: string[] = [];
        cdp.onEvent((event) => {
          if (event.method === "Network.requestWillBeSent")
            attemptedUrls.push((event.params as { request: { url: string } }).request.url);
        });
        const transport = new ChromiumFetchHost(cdp, { prepare: async () => {} } as never);
        // Browser-generated error page or a rejected navigation are both allowed representations of a denied request.
        await transport.open(forbiddenOrigin, "public").catch(() => undefined);
        expect(forbiddenReads).toBe(0);
        const opened = await transport.open(origin, "public", {
          kind: "internal-loopback",
          origin,
        });
        expect(
          Buffer.from(transport.read(opened.responseId, 0, 10000).bytesBase64, "base64").toString()
        ).toContain("authorized source");
        expect(
          attemptedUrls.some(
            (url) => url === forbiddenOrigin + "/image" || url === forbiddenOrigin + "/script"
          )
        ).toBe(true);
        await transport
          .open(origin + "/redirect", "public", { kind: "internal-loopback", origin })
          .catch(() => undefined);
        expect(forbiddenReads).toBe(0);
        await chromium.stop();
      } finally {
        cdp?.close();
        await ownership.close();
        await Promise.all([
          new Promise<void>((r) => allowed.close(() => r())),
          new Promise<void>((r) => forbidden.close(() => r())),
        ]);
        await rm(root, { recursive: true, force: true });
      }
    },
    30000
  );
});
