import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { buildWebsiteAssets } from "../../apps/webhook-relay/build-website-assets.mjs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { handleApexLanding } = createRequire(import.meta.url)(
  "../../apps/webhook-relay/src/oauthLanding.ts"
) as typeof import("../../apps/webhook-relay/src/oauthLanding");
import { launchManagedServerApp } from "../setup/managedServerApp";
import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  createBrowserPanel,
  getFocusedPanelId,
  reloadPanel,
  type TestApp,
} from "../setup/electronSetup";
import { findWorkspaceShellPage } from "../e2e/support/workspaceCreation";
import { clickNativeApproval } from "../e2e/support/nativeApproval";
import { hasOwnedX11Display } from "../setup/ownedXvfb";

/** Shared native acceptance flow. By default inference uses the configured provider;
 * smoke coverage supplies host-only scripted inference through the environment. */
export async function websiteInventionScenario(environment: Record<string, string> = {}) {
  test.setTimeout(1_200_000);
  test.skip(!hasOwnedX11Display(), "Requires the E2E-owned native display for approval input");
  const assets = path.join(process.env["VIBESTUDIO_E2E_TEMP_ROOT"]!, "website-assets");
  await buildWebsiteAssets(assets);
  // Freeze this run's built assets: another checkout build may replace dist.
  const assetNames = [
    "/runtime.js",
    "/connect.js",
    "/brand/favicon.svg",
    "/brand/vibestudio-symbol.svg",
    "/brand/vibestudio-symbol-dark.svg",
  ];
  const assetBytes = new Map(
    assetNames.map((name) => [name, fs.readFileSync(path.join(assets, name))])
  );
  const landing = handleApexLanding();
  const landingBody = await landing.text();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    if (pathname === "/") {
      res.writeHead(landing.status, Object.fromEntries(landing.headers));
      res.end(landingBody);
    } else if (assetBytes.has(pathname)) {
      res.writeHead(200, {
        "content-type": pathname.endsWith(".js") ? "text/javascript" : "image/svg+xml",
      });
      res.end(assetBytes.get(pathname));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local website listener");
  const url = `http://127.0.0.1:${address.port}/`;
  let app: TestApp | undefined;
  let website: Page | undefined;
  const approvals: unknown[] = [];
  const browserErrors: string[] = [];
  try {
    app = await launchManagedServerApp(environment);
    await approvePendingStartupUnits(app);
    const workspaces = await app.app.evaluate(() => globalThis.__testApi!.listWorkspaces());
    for (const workspace of workspaces) {
      await approvePendingWorkspaceCreationReview({
        app: app.app,
        workspaceId: workspace.workspaceId,
      });
    }
    const shell = await findWorkspaceShellPage(app);
    await shell.getByRole("button", { name: "Open System", exact: true }).click();
    await expect(shell.getByRole("button", { name: "Open System", exact: true })).toHaveAttribute(
      "aria-current",
      "location"
    );
    await expect.poll(() => getFocusedPanelId(app!)).toBeTruthy();
    const parentId = await getFocusedPanelId(app);
    const panel = await createBrowserPanel(app, parentId!, url, { focus: true });
    await expect
      .poll(() => {
        website = app!.app
          .context()
          .pages()
          .find((page) => page.url() === url);
        return Boolean(website);
      })
      .toBe(true);
    website!.on("pageerror", (error) => browserErrors.push(error.message));
    const page = website!;

    // Follow the visible native queue. Only this run's System requests are
    // accepted; incidental first-visit onboarding in its fresh Personal is denied.
    async function approvePending() {
      const shown = await app!.app.evaluate(async ({ BaseWindow }) => {
        const cards: Array<{ url: string; id: string }> = [];
        const visit = async (view: Electron.View) => {
          if (!view.getVisible()) return;
          if ("webContents" in view) {
            const wc = (view as Electron.WebContentsView).webContents;
            const id = await wc.executeJavaScript(`(() => {
              const card = document.querySelector('[data-approval-id]');
              return card && card.getBoundingClientRect().height > 0 ? card.getAttribute('data-approval-id') : null;
            })()`);
            if (id) cards.push({ url: wc.getURL(), id });
          }
          for (const child of view.children) await visit(child);
        };
        for (const window of BaseWindow.getAllWindows()) {
          if (window.isVisible()) await visit(window.contentView);
        }
        return cards;
      });
      if (!shown.length) return;
      expect(shown).toHaveLength(1);
      const target = shown[0]!;
      const item = await app!.app.evaluate(
        async (_electron, { ids, approvalId }) => {
          for (const workspaceId of ids) {
            const api = await globalThis.__testApi!.forWorkspace(workspaceId);
            const pending = (await api.rpcCall("shellApproval", "listPending", [])) as Array<{
              approvalId: string;
              kind: string;
            }>;
            const entry = pending.find((entry) => entry.approvalId === approvalId);
            if (entry) return { ...entry, workspaceId };
          }
          return null;
        },
        { ids: workspaces.map((workspace) => workspace.workspaceId), approvalId: target.id }
      );
      if (!item) return; // A resolved card can remain visible during its exit animation.
      const surface = app!.app
        .context()
        .pages()
        .find((surface) => surface.url() === target.url);
      if (!surface) throw new Error("Visible approval has no browser surface");
      const card = surface.locator(`[data-approval-id=${JSON.stringify(target.id)}]`);
      approvals.push({ ...item, text: await card.innerText() });
      const preferred =
        item.workspaceId === app!.workspaceId
          ? [
              "Connect this page",
              "Allow for this task",
              "Allow for this page",
              "Allow once",
              "Use for now",
              "Use once",
            ]
          : ["Don't allow"];
      for (const label of preferred) {
        const button = card.getByRole("button", { name: label, exact: true });
        if ((await button.count()) && (await button.isEnabled())) {
          await clickNativeApproval(app!, button);
          await expect
            .poll(async () =>
              app!.app.evaluate(
                async (_electron, item) => {
                  const api = await globalThis.__testApi!.forWorkspace(item.workspaceId);
                  const pending = (await api.rpcCall("shellApproval", "listPending", [])) as Array<{
                    approvalId: string;
                  }>;
                  return pending.some((entry) => entry.approvalId === item.approvalId);
                },
                { workspaceId: item.workspaceId, approvalId: item.approvalId }
              )
            )
            .toBe(false);
          return;
        }
      }
      throw new Error(
        `Unhandled approval ${item.kind}: ${(await card.getByRole("button").allTextContents()).join(" | ")}`
      );
    }
    async function untilReady(label: string, condition: () => Promise<boolean>, timeout = 300_000) {
      console.log(`[website-e2e] ${label}`);
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        await approvePending();
        if (browserErrors.length) throw new Error(browserErrors.join("\n"));
        const error = await page
          .locator("#lab-status")
          .evaluate((element) => (element.dataset.error === "true" ? element.textContent : null));
        if (error) throw new Error(`${label}: ${error}`);
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(
        `${label} timed out. ${await page.locator("#lab-status").textContent()}\n${await page.locator("#lab-transcript").innerText()}`
      );
    }
    await expect(page.locator("#workspace-connect-button")).toBeEnabled();
    await page.locator("#workspace-connect-button").click();
    await untilReady("connection", () => page.locator("#image-lab").isVisible(), 60_000);
    await page
      .locator("#lab-prompt")
      .fill(
        'A lunar bureaucracy that issues impossible permits. Build an ornate Moon Permit Office with an input labelled "Request" and a button named "Petition the moon". Clicking it must ask a real workspace agent to invent a unique permit for the typed request, quote that request verbatim in its response, and display the agent response in a region labelled "Moon verdict". Persist the conversation so it survives reopening. Keep the first version focused on this live text-agent interaction.'
      );
    await page.locator("#lab-generate").click();
    await untilReady(
      "generated invention",
      async () =>
        (await page.locator("#lab-invention").isVisible()) &&
        !(await page.locator("#lab-revise").isDisabled()),
      600_000
    );
    expect(await page.locator("#lab-invention").getAttribute("sandbox")).toBeNull();
    const frame = page.frameLocator("#lab-invention");
    await untilReady("embedded office ready", () =>
      frame.getByRole("button", { name: "Petition the moon", exact: true }).isEnabled()
    );
    const request = `Permit to teach clouds to whisper ${randomUUID()}`;
    await frame.getByRole("textbox", { name: "Request", exact: true }).fill(request);
    await frame.getByRole("button", { name: "Petition the moon", exact: true }).click();
    await untilReady("live embedded agent reply", async () =>
      (await frame.getByRole("region", { name: "Moon verdict", exact: true }).innerText()).includes(
        request
      )
    );
    const verdict = await frame
      .getByRole("region", { name: "Moon verdict", exact: true })
      .innerText();
    expect(verdict.length).toBeGreaterThan(request.length + 20);
    const channels = await app.app.evaluate(async (_electron, workspaceId) => {
      const api = await globalThis.__testApi!.forWorkspace(workspaceId);
      const entities = (await api.rpcCall("runtime", "listEntities", [{ kind: "do" }])) as Array<{
        id: string;
        source: string;
      }>;
      return entities
        .filter((entity) => entity.source === "workers/pubsub-channel")
        .map((entity) => entity.id);
    }, app.workspaceId);
    const modelReply = await page.evaluate(
      async ({ channels, request }) => {
        const runtime = (
          window as unknown as {
            inventionWorkspace: {
              rpc: { call(target: string, method: string, args: unknown[]): Promise<any> };
            };
          }
        ).inventionWorkspace;
        for (const channel of channels) {
          const history = await runtime.rpc.call(channel, "getReplayAfter", [{ after: 0 }]);
          for (const entry of history.logEvents ?? []) {
            const event = entry.payload;
            if (
              event?.kind !== "message.completed" ||
              event.payload?.role !== "assistant" ||
              !event.payload.model?.ref
            )
              continue;
            const text = (event.payload.blocks ?? [])
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.content)
              .join("\n");
            if (text.includes(request)) return { channel, model: event.payload.model.ref, text };
          }
        }
        return null;
      },
      { channels, request }
    );
    expect(
      modelReply,
      "The verdict must exist in the agent conversation, not just in the DOM"
    ).not.toBeNull();
    await test.info().attach("channel-agent-reply.json", {
      body: JSON.stringify(modelReply, null, 2),
      contentType: "application/json",
    });
    await test.info().attach("working-invention.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const original = await page.locator("#lab-invention").getAttribute("srcdoc");
    await page
      .locator("#lab-revision")
      .fill(
        'Add a visible heading "Department of Unlikely Permissions". Keep the working request input, petition button and live agent interaction.'
      );
    await page.locator("#lab-revise").click();
    await untilReady("conversational revision", async () => {
      const html = await page.locator("#lab-invention").getAttribute("srcdoc");
      return (
        html !== original &&
        (html?.includes("Department of Unlikely Permissions") ?? false) &&
        !(await page.locator("#lab-revise").isDisabled())
      );
    });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.locator("#lab-invention")).toBeHidden();
    await reloadPanel(app, panel.id);
    await expect(page.locator("#workspace-connect-button")).toBeEnabled();
    await page.locator("#workspace-connect-button").click();
    await untilReady(
      "reconnected invention",
      () => page.locator("#lab-invention").isVisible(),
      60_000
    );
    await expect(
      page
        .frameLocator("#lab-invention")
        .getByRole("heading", { name: "Department of Unlikely Permissions", exact: true })
    ).toBeVisible();
    expect(browserErrors).toEqual([]);
  } finally {
    if (website && !website.isClosed()) {
      await test
        .info()
        .attach("website-final.png", {
          body: await website.screenshot({ fullPage: true }),
          contentType: "image/png",
        })
        .catch(() => {});
      await test
        .info()
        .attach("website-state.txt", {
          body: await website.locator("body").innerText(),
          contentType: "text/plain",
        })
        .catch(() => {});
    }
    await test.info().attach("approval-decisions.json", {
      body: JSON.stringify(approvals, null, 2),
      contentType: "application/json",
    });
    try {
      await app?.cleanup();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
