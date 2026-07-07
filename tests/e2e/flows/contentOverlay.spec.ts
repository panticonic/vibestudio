import { expect, test } from "@playwright/test";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

/**
 * Invoke a main-process `view.*` method from the hosted shell webContents (the
 * shell app is a view host). This goes through the app preload's `serviceCall`
 * bridge — the same dispatch path the real approval coordinator uses — unlike
 * `__testApi.rpcCall`, which targets the *server* services.
 */
async function callShellView(testApp: TestApp, method: string, arg?: unknown): Promise<unknown> {
  return testApp.app.evaluate(
    async ({ webContents }, request) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          // The hosted shell app is the one exposing the privileged app bridge
          // (the bootstrap gate does not).
          const isShell = await contents.executeJavaScript(
            `!!(globalThis.__vibestudioApp && globalThis.__vibestudioApp.serviceCall)`,
            true
          );
          if (!isShell) continue;
          const call =
            request.arg === undefined
              ? `globalThis.__vibestudioApp.serviceCall(${JSON.stringify("view." + request.method)})`
              : `globalThis.__vibestudioApp.serviceCall(${JSON.stringify("view." + request.method)}, ${JSON.stringify(request.arg)})`;
          return await contents.executeJavaScript(call, true);
        } catch {
          // Try the next webContents.
        }
      }
      throw new Error("hosted shell webContents not found");
    },
    { method, arg }
  );
}

/** Wait for the hosted shell chrome, approving the bootstrap launch gate if shown. */
async function waitHostedShellReady(testApp: TestApp): Promise<void> {
  await expect
    .poll(
      async () =>
        testApp.app.evaluate(async ({ webContents }) => {
          for (const contents of webContents.getAllWebContents()) {
            if (contents.isDestroyed()) continue;
            try {
              const result = await contents.executeJavaScript(
                `(() => {
                  if (document.querySelector(".titlebar-breadcrumb-scroll")
                    || document.querySelector('[aria-label="Menu"]')) return "ready";
                  const approve = Array.from(document.querySelectorAll("button"))
                    .find((b) => /^(Trust and start|Approve and start)$/.test((b.textContent ?? "").trim()));
                  if (approve) { approve.click(); return "approved"; }
                  return "waiting";
                })()`,
                true
              );
              // Only "ready" ends the wait — "approved" just clicks the gate and
              // keeps polling until the hosted shell chrome actually loads.
              if (result === "ready") return true;
            } catch {
              // Non-DOM webContents.
            }
          }
          return false;
        }),
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

/** Probe the content-overlay webContents, identified by its preload bridge
 *  (more robust than URL matching, since getURL() may omit the hash). */
async function probeOverlay(testApp: TestApp): Promise<{
  hasCard: boolean;
  tone: string | null;
  text: string;
  card: { width: number; height: number; clientHeight: number; scrollHeight: number } | null;
} | null> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const isOverlay = await contents.executeJavaScript(
          `!!globalThis.__vibestudioContentOverlay`,
          true
        );
        if (!isOverlay) continue;
        return (await contents.executeJavaScript(
          `(() => {
            const card = document.querySelector(".approval-card");
            const rect = card ? card.getBoundingClientRect() : null;
            return {
              hasCard: !!card,
              tone: card ? card.getAttribute("data-approval-tone") : null,
              text: document.body ? document.body.innerText : "",
              card: card && rect ? {
                width: rect.width,
                height: rect.height,
                clientHeight: card.clientHeight,
                scrollHeight: card.scrollHeight,
              } : null,
            };
          })()`,
          true
        )) as {
          hasCard: boolean;
          tone: string | null;
          text: string;
          card: {
            width: number;
            height: number;
            clientHeight: number;
            scrollHeight: number;
          } | null;
        };
      } catch {
        // Try the next webContents.
      }
    }
    return null;
  });
}

/** Drive a full drag gesture on the overlay via its `reportDrag` bridge (the
 *  same path the surface's pointer handlers use). Exercises main's drag handler
 *  + corner snap end-to-end. */
async function driveOverlayDrag(
  testApp: TestApp,
  steps: Array<{ phase: "start" | "move" | "end"; x: number; y: number }>
): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }, gesture) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const isOverlay = await contents.executeJavaScript(
          `!!(globalThis.__vibestudioContentOverlay && globalThis.__vibestudioContentOverlay.reportDrag)`,
          true
        );
        if (!isOverlay) continue;
        await contents.executeJavaScript(
          `(() => {
            for (const s of ${JSON.stringify(gesture)}) {
              globalThis.__vibestudioContentOverlay.reportDrag(s.phase, s.x, s.y);
            }
            return true;
          })()`,
          true
        );
        return true;
      } catch {
        // Try the next webContents.
      }
    }
    return false;
  }, steps);
}

/** Diagnostic: dump every webContents (url + whether it's the overlay surface). */
async function dumpWebContents(testApp: TestApp): Promise<unknown> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const out: Array<{ url: string; overlay: boolean; cardLen: number }> = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const info = (await contents.executeJavaScript(
          `(() => ({
            overlay: !!globalThis.__vibestudioContentOverlay,
            cardLen: document.querySelectorAll(".approval-card").length,
          }))()`,
          true
        )) as { overlay: boolean; cardLen: number };
        out.push({ url: contents.getURL(), overlay: info.overlay, cardLen: info.cardLen });
      } catch {
        out.push({ url: contents.getURL(), overlay: false, cardLen: -1 });
      }
    }
    return out;
  });
}

test.describe("Content overlay", () => {
  test.setTimeout(240_000);

  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("floats the approval card in a native overlay above a live panel", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });
    await waitHostedShellReady(testApp);

    // Drive the reusable content overlay directly (the test API authenticates as
    // the shell app, a view host) with a synthetic severe-capability approval.
    const approval = {
      kind: "capability",
      approvalId: "e2e-cap",
      callerId: "panel:e2e",
      callerKind: "panel",
      repoPath: "panels/e2e",
      effectiveVersion: "ev",
      requestedAt: 0,
      capability: "panel.automate",
      severity: "severe",
      title: "E2E drive panel",
      description: "Synthetic approval for the content-overlay e2e.",
      resource: { type: "panel", label: "Panel", value: "Shell" },
    };
    await callShellView(testApp, "showContentOverlay", {
      surface: "approval-card",
      bounds: { x: 200, y: 120, width: 700, height: 480 },
      props: { approval, queue: null, decisionError: null },
      theme: { appearance: "light" },
    });

    // The card renders in its OWN overlay webContents, with the danger tone —
    // proving the rich React surface composited above the panels.
    try {
      await expect
        .poll(async () => (await probeOverlay(testApp!))?.hasCard ?? false, {
          timeout: 30_000,
          intervals: [300, 600, 1000],
        })
        .toBe(true);
    } catch (error) {
      console.log(
        "[e2e] webContents dump:",
        JSON.stringify(await dumpWebContents(testApp), null, 2)
      );
      console.log("[e2e] overlay probe:", JSON.stringify(await probeOverlay(testApp)));
      throw error;
    }
    const probe = await probeOverlay(testApp);
    expect(probe?.tone).toBe("red");
    expect(probe?.text).toContain("E2E drive panel");
    expect(probe?.card?.height ?? 0).toBeGreaterThan(120);
    // The full severe-capability action set rendered.
    expect(probe?.text).toContain("Allow once");
    expect(probe?.text).toContain("Allow this session");
    expect(probe?.text).toContain("Trust repo");
    expect(probe?.text).toContain("Trust version");
    expect(probe?.text).toContain("Deny");

    // Panels were NOT blanked — at least one panel remains in the live tree.
    const panelCount = await testApp.app.evaluate(async () => {
      const api = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
      const tree = api?.getPanelTree?.() ?? [];
      return Array.isArray(tree) ? tree.length : 0;
    });
    expect(panelCount).toBeGreaterThan(0);

    // The card is draggable: driving a full start→move→end gesture through the
    // overlay's reportDrag bridge (the same path the surface uses) snaps it to a
    // corner in the main process and leaves the card live (no teardown/crash).
    const dragged = await driveOverlayDrag(testApp, [
      { phase: "start", x: 900, y: 200 },
      { phase: "move", x: 700, y: 600 },
      { phase: "move", x: 400, y: 700 },
      { phase: "end", x: 400, y: 700 },
    ]);
    expect(dragged).toBe(true);
    await expect
      .poll(async () => (await probeOverlay(testApp!))?.hasCard ?? false, {
        timeout: 10_000,
        intervals: [200, 400],
      })
      .toBe(true);

    // Hiding the overlay tears the card down.
    await callShellView(testApp, "hideContentOverlay");
    await expect
      .poll(async () => (await probeOverlay(testApp!))?.hasCard ?? false, {
        timeout: 15_000,
        intervals: [300, 600],
      })
      .toBe(false);
  });
});
