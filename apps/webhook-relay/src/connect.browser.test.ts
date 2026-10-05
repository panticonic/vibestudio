import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import * as http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handleApexLanding } from "./oauthLanding";

const connectedRuntime = String.raw`
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
  export const contextId = "ctx-invention-test";
  const files = new Map();
  let notify;
  window.emitInventionEvent = event => notify({kind:"message",payload:{message:{kind:"log",event:{payload:event}}}});
  window.inventionCalls = [];
  export const rpc = { async call(target, method, args) {
    window.inventionCalls.push({ target, method, args });
    return { targetId: "do:channel:demo", contextId };
  } };
  export const fs = {
    async mkdir() {}, async writeFile(path, text) { files.set(path, text); },
    async readFile(path) { if (!files.has(path)) throw new Error("ENOENT"); return files.get(path); }
  };
  export async function launchAgentIntoChannel(rpc, input) {
    window.inventionCalls.push({ method: "launchAgentIntoChannel", input });
    return { subscription: { participantId: "agent:inventor" }, contextId };
  }
  export function createConversationClient() { return {
    async subscribe(target, participant, metadata, onRecord, options) { notify = onRecord; await new Promise(resolve => options.signal.addEventListener("abort", resolve)); },
    async history() { return { logEvents: [] }; },
    async send(target, text, options) {
      window.inventionCalls.push({ method: "send", text, options });
      const path = text.match(/projects\/impossible-inventions\/[a-z0-9-]+\/index.html/)[0];
      files.set(path, '<!doctype html><button id="ask">Consult the moon</button><output></output><script>document.getElementById("ask").onclick=async()=>{await parent.inventionWorkspace.rpc.call("main","docs.listSurfaces",[]);document.querySelector("output").textContent="Connected to the real SDK instance"}<\/script>');
      const complete = () => notify({ kind: "message", payload: { message: { kind: "log", event: { payload: { kind: "message.completed", causality: { messageId: crypto.randomUUID() }, payload: { role: "assistant", blocks: [{ type: "text", content: "Turn the moon dial." }] } } } } } });
      window.finishInvention = complete;
      if (!location.search.includes("hold")) setTimeout(complete, 30);
      return { messageId: options.idempotencyKey };
    }
  }; }

`;

describe.skipIf(!existsSync(chromium.executablePath()))("apex connected experience", () => {
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
      } else if (request.url?.startsWith("/site/")) {
        const file = request.url.slice("/site/".length);
        if (!["regency-game.webp", "approval-prompt.webp"].includes(file)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "image/webp" });
        response.end(readFileSync(resolve(import.meta.dirname, "../site", file)));
      } else if (request.url?.startsWith("/brand/")) {
        const file = request.url.slice("/brand/".length);
        if (
          !["favicon.svg", "vibestudio-symbol.svg", "vibestudio-symbol-dark.svg"].includes(file)
        ) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end(
          readFileSync(resolve(import.meta.dirname, "../../../build-resources/brand", file))
        );
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
  ])(
    "creates, plays, revises and restores an invention on $viewport",
    async ({ width, height }) => {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(origin);
        await expect.poll(() => page.locator("#image-lab").isVisible()).toBe(false);
        await page.getByRole("button", { name: "Connect to workspace", exact: true }).click();
        await page.getByRole("button", { name: "Invent the impossible", exact: true }).click();
        await expect.poll(() => page.locator("#lab-invention").isVisible()).toBe(true);
        await expect.poll(() => page.locator("#lab-status").textContent()).toContain("is ready");
        await page
          .frameLocator("#lab-invention")
          .getByRole("button", { name: "Consult the moon" })
          .click();
        await expect
          .poll(() => page.frameLocator("#lab-invention").locator("output").textContent())
          .toBe("Connected to the real SDK instance");
        expect(await page.locator("#lab-invention").getAttribute("sandbox")).toBeNull();
        expect(
          await page.evaluate(() =>
            (
              window as unknown as { inventionCalls: Array<{ method: string }> }
            ).inventionCalls.some((call) => call.method === "docs.listSurfaces")
          )
        ).toBe(true);
        await page.getByRole("button", { name: "Make it weirder" }).click();
        await expect
          .poll(() => page.locator("#lab-transcript").textContent())
          .toContain("Make it weirder");
        await expect.poll(() => page.locator("#lab-status").textContent()).toContain("is ready");
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
            )
          )
          .toBe(true);
        const calls = await page.evaluate(
          () => (window as unknown as { inventionCalls: Array<{ method: string }> }).inventionCalls
        );
        expect(calls.filter((call) => call.method === "launchAgentIntoChannel")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "send")).toHaveLength(2);
        const screenshotPath = process.env["VIBESTUDIO_APEX_SCREENSHOT"];
        if (screenshotPath)
          await page.screenshot({
            path: screenshotPath.replace(/(\.[^./]+)$/u, `-${width}x${height}$1`),
            fullPage: true,
          });
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        await expect.poll(() => page.locator("#image-lab").isVisible()).toBe(false);
        await page.getByRole("button", { name: "Connect to workspace", exact: true }).click();
        await expect.poll(() => page.locator("#lab-status").textContent()).toContain("is back");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  );

  it.each([390, 1280])("animates the invention workshop accessibly at %ipx", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`${origin}?hold`);
      await page.getByRole("button", { name: "Connect to workspace", exact: true }).click();
      await page.getByRole("button", { name: "Invent the impossible", exact: true }).click();
      const machine = page.locator("#lab-machine");
      await expect.poll(() => machine.isVisible()).toBe(true);
      await expect.poll(() => page.locator("#lab-elapsed").textContent()).not.toBe("00:00");
      await page.evaluate(() =>
        (window as any).emitInventionEvent({
          kind: "invocation.started",
          causality: { invocationId: "write-1" },
          payload: { name: "write" },
        })
      );
      await expect
        .poll(() => page.locator("#lab-activity").textContent())
        .toBe("Writing the invention");
      await page.evaluate(() =>
        (window as any).emitInventionEvent({
          kind: "invocation.progress",
          causality: { invocationId: "write-1" },
          payload: { data: { eval: { activity: "authority-pending" } } },
        })
      );
      await expect
        .poll(() => page.locator("#lab-activity").textContent())
        .toContain("Waiting for your approval");
      const launch = await page.evaluate(() =>
        (window as any).inventionCalls.find((call: any) => call.method === "launchAgentIntoChannel")
      );
      expect(launch.input.stateArgs.agentConfig).toEqual({
        model: "openai-codex:gpt-6-astra",
        thinkingLevel: "medium",
      });
      await page.getByRole("button", { name: "Pause animation" }).click();
      expect(
        await page
          .locator(".machine-brain")
          .evaluate((el) => getComputedStyle(el).animationPlayState)
      ).toBe("paused");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await machine.screenshot({ path: `/tmp/invention-progress-${width}.png` });
      await page.getByRole("button", { name: "Resume animation" }).click();
      expect(
        await page
          .locator(".machine-brain")
          .evaluate((el) => getComputedStyle(el).animationPlayState)
      ).toBe("running");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page.locator(".machine-brain").evaluate((el) => getComputedStyle(el).animationName)
      ).toBe("none");
      await page.evaluate(() => (window as any).finishInvention());
      await expect.poll(() => machine.isVisible()).toBe(false);
      await expect.poll(() => page.locator("#lab-invention").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Make it weirder" }).click();
      await expect.poll(() => machine.isVisible()).toBe(true);
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect.poll(() => machine.isVisible()).toBe(false);
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
        const body = page.locator("body");
        await expect
          .poll(() => headerLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol.svg");
        await expect
          .poll(() => body.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe("rgb(246, 242, 234)");
        await expect
          .poll(() =>
            page
              .locator(".primary")
              .first()
              .evaluate((element) => getComputedStyle(element).color)
          )
          .toBe("rgb(255, 255, 255)");

        await page.emulateMedia({ colorScheme: "dark" });
        await expect
          .poll(() => headerLogo.evaluate((image: HTMLImageElement) => image.currentSrc))
          .toContain("vibestudio-symbol-dark.svg");
        await expect
          .poll(() => body.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe("rgb(26, 32, 42)");
        await expect
          .poll(() =>
            page
              .locator(".nav a")
              .first()
              .evaluate((element) => getComputedStyle(element).color)
          )
          .toBe("rgb(175, 200, 240)");
        await expect
          .poll(() =>
            page.locator('meta[name="theme-color"][media*="dark"]').getAttribute("content")
          )
          .toBe("#1A202A");
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
            )
          )
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
