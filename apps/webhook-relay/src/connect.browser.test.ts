import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handleApexLanding } from "./oauthLanding";

const connectedRuntime = `
  const listeners = new Set();
  export const workspaceConnection = {
    available: true, connected: false, status: "disconnected", error: null,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  export async function connectWorkspace() {
    workspaceConnection.connected = true;
    workspaceConnection.status = "connected";
    for (const listener of listeners) listener();
  }
  export async function disconnectWorkspace() {
    workspaceConnection.connected = false;
    workspaceConnection.status = "disconnected";
    for (const listener of listeners) listener();
  }
  export const services = { docs: {
    async listSurfaces() {
      return [
        { surface: "service", count: 28 },
        { surface: "runtime", count: 14 },
        { surface: "workspace", count: 5 },
      ];
    }
  } };
`;

describe("apex connected experience", () => {
  let browser: Browser;
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer(async (request, response) => {
      if (request.url === "/runtime.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(connectedRuntime);
      } else if (request.url === "/connect.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(readFileSync(join(import.meta.dirname, "connect.js")));
      } else if (request.url?.startsWith("/brand/")) {
        const file = request.url.slice("/brand/".length);
        if (!["favicon.svg", "vibestudio-symbol.svg", "vibestudio-symbol-dark.svg"].includes(file)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end(readFileSync(resolve(import.meta.dirname, "../../../build-resources/brand", file)));
      } else {
        const landing = handleApexLanding();
        response.writeHead(landing.status, Object.fromEntries(landing.headers));
        response.end(await landing.text());
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local test address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
  });

  it.each([
    { viewport: "desktop", width: 1280, height: 900 },
    { viewport: "mobile", width: 390, height: 844 },
  ])("opens the studio on $viewport and draws a downloadable poster", async ({ width, height }) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.goto(origin);
      const logo = page.locator(".brand .mark");
      await expect.poll(() => logo.isVisible()).toBe(true);
      await expect
        .poll(() => logo.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true);
      await expect.poll(() => page.locator("#image-lab").isVisible()).toBe(false);
      await page.getByRole("button", { name: "Connect to workspace" }).click();
      await expect.poll(() => page.locator("#image-lab").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Sea" }).click();
      await page.getByRole("button", { name: "Draw my workspace" }).click();
      await expect.poll(() => page.locator("#lab-image").getAttribute("src")).toMatch(
        /^data:image\/png;base64,/
      );
      await expect.poll(() => page.locator("#lab-download").isVisible()).toBe(true);
      await expect.poll(() => page.locator("#lab-status").textContent()).toContain("A snapshot of what this page can see");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true);
      const screenshotPath = process.env["VIBESTUDIO_APEX_SCREENSHOT"];
      if (screenshotPath) {
        const sizedScreenshotPath = screenshotPath.replace(/(\.[^./]+)$/u, `-${width}x${height}$1`);
        await page.screenshot({ path: sizedScreenshotPath, fullPage: true });
      }
      await page.getByRole("button", { name: "Disconnect" }).click();
      await expect.poll(() => page.locator("#image-lab").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it.each([390, 900])(
    "switches the live landing palette and logos with the system appearance at %ipx",
    async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: "light",
      });
      try {
        await page.goto(origin);
        const headerLogo = page.locator(".brand-mark img");
        const heroLogo = page.locator(".hero-art img");
        const hero = page.locator(".hero-art");
        await expect
          .poll(() => headerLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol.svg");
        await expect
          .poll(() => heroLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol.svg");
        await expect
          .poll(() => hero.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe("rgb(241, 243, 247)");
        await expect
          .poll(() => page.locator(".primary").first().evaluate((element) => getComputedStyle(element).color))
          .toBe("rgb(255, 255, 255)");

        await page.emulateMedia({ colorScheme: "dark" });
        await expect
          .poll(() => headerLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol-dark.svg");
        await expect
          .poll(() => heroLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol-dark.svg");
        await expect
          .poll(() => hero.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe("rgb(50, 62, 78)");
        await expect
          .poll(() => page.locator(".nav a").first().evaluate((element) => getComputedStyle(element).color))
          .toBe("rgb(175, 200, 240)");
        await expect
          .poll(() => page.locator('meta[name="theme-color"][media*="dark"]').getAttribute("content"))
          .toBe("#1A202A");
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
          .toBe(true);

        await page.emulateMedia({ colorScheme: "light" });
        await expect
          .poll(() => headerLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol.svg");
      } finally {
        await page.close();
      }
    }
  );
});
