import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { buildWebsiteAssets } from "../../apps/webhook-relay/build-website-assets.mjs";
import { runWithOwnedCleanup } from "../../scripts/lib/owned-cleanup.mjs";
import { retireUserlandProjectionProcess } from "../../scripts/lib/userland-projection-process-owner.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { handleApexLanding } = createRequire(import.meta.url)(
  "../../apps/webhook-relay/src/oauthLanding.ts"
) as typeof import("../../apps/webhook-relay/src/oauthLanding");
import { launchManagedServerApp } from "../setup/managedServerApp";
import {
  approvePendingStartupUnits,
  approvePendingWorkspaceCreationReview,
  clickPanelSelector,
  clickPanelText,
  createBrowserPanel,
  ensureHostedShellReady,
  executePanelScript,
  getFocusedPanelId,
  reloadPanel,
  type TestApp,
} from "../setup/electronSetup";
import { declineFirstRunReporting, findWorkspaceShellPage } from "../e2e/support/workspaceCreation";
import { clickNativeApproval } from "../e2e/support/nativeApproval";
import { hasOwnedX11Display } from "../setup/ownedXvfb";
import { getChannelRpcReadBundle } from "../e2e/support/channelRpcReadBundle";
import type { readChannelReplay } from "../e2e/support/channelRpcReads";
import type { RpcCaller } from "@vibestudio/rpc";

const CHANNEL_READS_SYMBOL = "vibestudio.e2e.channelRpcReads.v1";
const TEST_MODEL_REF = "vibestudio-test:deterministic";

async function settleWorkspaceCreationReviews(app: TestApp) {
  const workspaces = await app.app.evaluate(() => globalThis.__testApi!.listWorkspaces());
  for (const workspace of workspaces) {
    await approvePendingWorkspaceCreationReview({
      app: app.app,
      workspaceId: workspace.workspaceId,
    });
  }
}

async function selectDeterministicTestModel(app: TestApp, workspaceId: string) {
  const launcherPanelId = (await ensureHostedShellReady(app, { panelSource: "about/new" })).panelId;
  let launcherRow = "";
  await expect
    .poll(async () => {
      launcherRow = await executePanelScript<string>(
        app,
        launcherPanelId,
        `Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.innerText.trim()).find((text) => text.includes("Agentic Chat") && text.includes("panels/chat")) ?? ""`
      );
      return launcherRow;
    })
    .not.toBe("");
  if (!(await clickPanelText(app, launcherPanelId, '[role="option"]', launcherRow))) {
    throw new Error("Could not open Agentic Chat from the System New Panel launcher");
  }
  const chatReadiness = await ensureHostedShellReady(app, { panelSource: "panels/chat" });
  if (chatReadiness.panelId !== launcherPanelId) {
    throw new Error("Agentic Chat replaced the launcher with a different panel identity");
  }
  await expect
    .poll(() =>
      executePanelScript<boolean>(
        app,
        launcherPanelId,
        `!!document.querySelector('.agent-setup-card [aria-label="Provider"]')`
      )
    )
    .toBe(true);
  const chatPanelId = launcherPanelId;
  const clickText = async (selector: string, text: string) => {
    if (!(await clickPanelText(app, chatPanelId, selector, text))) {
      throw new Error("Could not click " + JSON.stringify(text) + " in the System chat panel");
    }
  };
  const clickSelector = async (selector: string) => {
    if (!(await clickPanelSelector(app, chatPanelId, selector))) {
      throw new Error("Could not click " + JSON.stringify(selector) + " in the System chat panel");
    }
  };
  const selectedText = (label: "Provider" | "Model") =>
    executePanelScript<string>(
      app,
      chatPanelId,
      `document.querySelector('.agent-setup-card [aria-label="${label}"]')?.textContent?.trim() ?? ""`
    );
  const selectOptionIfNeeded = async (
    label: "Provider" | "Model",
    expected: string
  ): Promise<string> => {
    const current = await selectedText(label);
    if (current.includes(expected)) return current;
    await clickSelector(`[aria-label="${label}"]`);
    const option = await executePanelScript<string>(
      app,
      chatPanelId,
      `Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent?.trim() ?? "").find((text) => text.includes(${JSON.stringify(expected)})) ?? ""`
    );
    if (!option)
      throw new Error(`${expected} is not available in the ${label.toLowerCase()} picker`);
    await clickText('[role="option"]', option);
    return option;
  };
  const provider = await selectOptionIfNeeded("Provider", "Deterministic test provider");
  const model = await selectOptionIfNeeded("Model", "Deterministic test model");
  await clickText("button", "Save defaults");
  await expect
    .poll(() =>
      executePanelScript<boolean>(
        app,
        chatPanelId,
        `(() => {
          const setup = document.querySelector(".agent-setup-card");
          if (!setup) return false;
          const saved = Array.from(setup.querySelectorAll("*")).some((item) => item.textContent?.trim() === "Workspace defaults");
          const saveButton = Array.from(setup.querySelectorAll("button")).some((button) => button.innerText.trim() === "Save defaults");
          return saved && !saveButton;
        })()`
      )
    )
    .toBe(true);
  const selection = { workspaceId, model: TEST_MODEL_REF, provider, pickerModel: model };
  await test.info().attach("test-model-routing.json", {
    body: JSON.stringify(selection, null, 2),
    contentType: "application/json",
  });
}

async function captureAgentRoutingEvidence(page: Page, app: TestApp, workspaceId: string) {
  const entities = await app.app.evaluate(async (_electron, id) => {
    const api = await globalThis.__testApi!.forWorkspace(id);
    return (await api.rpcCall("runtime", "listEntities", [{ kind: "do" }])) as Array<{
      id: string;
      source: string;
    }>;
  }, workspaceId);
  const channels = entities
    .filter((entity) => entity.source === "workers/pubsub-channel")
    .map((entity) => entity.id)
    .slice(-20);
  await page.addScriptTag({ content: await getChannelRpcReadBundle() });
  const evidence = await page.evaluate(
    async ({ channelIds, readerSymbol }) => {
      type Runtime = typeof globalThis & { inventionWorkspace?: { rpc: RpcCaller } };
      const reader = (globalThis as unknown as Record<PropertyKey, unknown>)[
        Symbol.for(readerSymbol)
      ];
      if (!reader || typeof reader !== "object")
        throw new Error("Channel replay reader is unavailable");
      const readReplay = (reader as { readChannelReplay: typeof readChannelReplay })
        .readChannelReplay;
      const rpc = (globalThis as Runtime).inventionWorkspace?.rpc;
      if (!rpc) throw new Error("Connected website workspace RPC is unavailable");
      const evidence = [];
      for (const channel of channelIds) {
        const replay = await readReplay(rpc, channel, 0);
        const entries =
          replay &&
          typeof replay === "object" &&
          Array.isArray((replay as { logEvents?: unknown }).logEvents)
            ? (replay as { logEvents: Array<{ payload?: unknown }> }).logEvents
            : [];
        const events = entries.slice(-20).map(({ payload: event }) => {
          if (!event || typeof event !== "object") return { malformed: true };
          const record = event as { kind?: unknown; payload?: unknown; failure?: unknown };
          const payload = record.payload as
            | { role?: unknown; model?: { ref?: unknown }; failure?: unknown }
            | undefined;
          return {
            kind: record.kind ?? null,
            role: payload?.role ?? null,
            modelRef: payload?.model?.ref ?? null,
            failure: payload?.failure ?? record.failure ?? null,
          };
        });
        evidence.push({ channel, events });
      }
      return evidence;
    },
    { channelIds: channels, readerSymbol: CHANNEL_READS_SYMBOL }
  );
  return evidence;
}

/** Shared native acceptance flow. By default inference uses the configured provider;
 * smoke coverage supplies host-only scripted inference through the environment. */
export async function websiteInventionScenario(environment: Record<string, string> = {}) {
  test.setTimeout(1_200_000);
  const expectsDeterministicModel = typeof environment["VIBESTUDIO_TEST_MODEL_SCRIPT"] === "string";
  test.skip(!hasOwnedX11Display(), "Requires the E2E-owned native display for approval input");
  const assets = path.join(process.env["VIBESTUDIO_E2E_TEMP_ROOT"]!, "website-assets");
  await runWithOwnedCleanup(
    () => buildWebsiteAssets(assets),
    () => retireUserlandProjectionProcess(),
    "Website invention fixture projection cleanup failed"
  );
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
  const browserErrors: Error[] = [];
  try {
    app = await launchManagedServerApp(environment);
    await declineFirstRunReporting(app);
    await approvePendingStartupUnits(app);
    await settleWorkspaceCreationReviews(app);
    const workspaces = await app.app.evaluate(() => globalThis.__testApi!.listWorkspaces());
    const shell = await findWorkspaceShellPage(app);
    await shell.getByRole("button", { name: "Open System", exact: true }).click();
    await expect(shell.getByRole("button", { name: "Open System", exact: true })).toHaveAttribute(
      "aria-current",
      "location"
    );
    await expect.poll(() => getFocusedPanelId(app!)).toBeTruthy();
    if (expectsDeterministicModel) {
      // Personal's extension review can arrive after the initial workspace pass.
      await settleWorkspaceCreationReviews(app);
      await selectDeterministicTestModel(app, app.workspaceId);
    }
    const observedPages = new WeakSet<Page>();
    const observePageErrors = (candidate: Page) => {
      if (observedPages.has(candidate)) return;
      observedPages.add(candidate);
      candidate.on("pageerror", (error) => {
        if (candidate.url() === url) browserErrors.push(error);
      });
    };
    for (const candidate of app.app.context().pages()) observePageErrors(candidate);
    app.app.context().on("page", observePageErrors);
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
      if (item.kind === "unit-install-review") {
        await approvePendingWorkspaceCreationReview(
          { app: app!.app, workspaceId: item.workspaceId },
          [item.approvalId]
        );
        return;
      }
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
        if (browserErrors.length) {
          throw new AggregateError(browserErrors, `${label}: connected website script failed`);
        }
        const error = await page
          .locator("#lab-status")
          .evaluate((element) =>
            element.dataset["error"] === "true" ? element.textContent : null
          );
        if (error) throw new Error(`${label}: ${error}`);
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const failure = `${label} timed out. ${await page.locator("#lab-status").textContent()}\n${await page.locator("#lab-transcript").innerText()}`;
      try {
        const evidence = await captureAgentRoutingEvidence(page, app!, app!.workspaceId);
        await test.info().attach("channel-model-routing-at-timeout.json", {
          body: JSON.stringify(evidence, null, 2),
          contentType: "application/json",
        });
      } catch (error) {
        await test.info().attach("channel-model-routing-diagnostic-error.txt", {
          body: error instanceof Error ? (error.stack ?? error.message) : String(error),
          contentType: "text/plain",
        });
      }
      throw new Error(failure);
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
    await untilReady("live embedded agent reply", async () => {
      const verdict = await frame
        .getByRole("region", { name: "Moon verdict", exact: true })
        .innerText();
      if (verdict.includes(request)) return true;
      const embeddedStatus = frame.locator("#status");
      const state = await embeddedStatus.getAttribute("data-state");
      if (state === "failed")
        throw new Error(`live embedded agent reply: ${await embeddedStatus.innerText()}`);
      if (state === "complete")
        throw new Error(`live embedded agent reply did not include the request: ${verdict}`);
      return false;
    });
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
    await page.addScriptTag({ content: await getChannelRpcReadBundle() });
    const modelReply = await page.evaluate(
      async ({ channels, request, readerSymbol }) => {
        type WorkspaceRuntime = typeof globalThis & {
          inventionWorkspace: { rpc: RpcCaller };
        };
        const reader = (globalThis as unknown as Record<PropertyKey, unknown>)[
          Symbol.for(readerSymbol)
        ];
        if (!reader || typeof reader !== "object") {
          throw new Error("Channel replay reader is unavailable");
        }
        const readReplay = (reader as { readChannelReplay: typeof readChannelReplay })
          .readChannelReplay;
        for (const channel of channels) {
          const history = await readReplay(
            (globalThis as WorkspaceRuntime).inventionWorkspace.rpc,
            channel,
            0
          );
          if (!history || typeof history !== "object") continue;
          const logEvents = (history as { logEvents?: unknown }).logEvents;
          if (!Array.isArray(logEvents)) continue;
          for (const entry of logEvents) {
            if (!entry || typeof entry !== "object") continue;
            const event = (entry as { payload?: unknown }).payload;
            if (!event || typeof event !== "object") continue;
            const payload = (event as { payload?: unknown }).payload;
            if (!payload || typeof payload !== "object") continue;
            const model = (payload as { model?: unknown }).model;
            if (!model || typeof model !== "object") continue;
            const modelRef = (model as { ref?: unknown }).ref;
            if (
              (event as { kind?: unknown }).kind !== "message.completed" ||
              (payload as { role?: unknown }).role !== "assistant" ||
              typeof modelRef !== "string"
            )
              continue;
            const blocks = (payload as { blocks?: unknown }).blocks;
            const text = (Array.isArray(blocks) ? blocks : [])
              .filter(
                (block): block is { type: string; content: string } =>
                  !!block &&
                  typeof block === "object" &&
                  (block as { type?: unknown }).type === "text" &&
                  typeof (block as { content?: unknown }).content === "string"
              )
              .map((block) => block.content)
              .join("\n");
            if (text.includes(request)) return { channel, model: modelRef, text };
          }
        }
        return null;
      },
      { channels, request, readerSymbol: CHANNEL_READS_SYMBOL }
    );
    expect(
      modelReply,
      "The verdict must exist in the agent conversation, not just in the DOM"
    ).not.toBeNull();
    if (expectsDeterministicModel) {
      expect(modelReply?.model, "The reply must come from the scripted test provider").toBe(
        TEST_MODEL_REF
      );
    }
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
