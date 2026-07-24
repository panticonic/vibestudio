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
    // the shell app, a view host) with a consequential agent approval. This is
    // the real subject shape produced by authority acquisition: one reviewed
    // row, one prepared-state substance block, and the eligible scope ladder.
    const approval = {
      kind: "capability",
      approvalId: "e2e-cap",
      callerId: "agent:news",
      callerKind: "agent",
      callerTitle: "News",
      requesterCategory: "agent",
      repoPath: "workers/news-agent",
      effectiveVersion: "ev",
      requestedAt: 0,
      capability: "push.send",
      severity: "severe",
      title: "Send the nightly briefing",
      description: "News wants to send its prepared workspace summary.",
      resource: { type: "channel", label: "Recipient", value: "Briefings" },
      allowedDecisions: ["once", "task", "agent", "deny", "lock"],
      snapshot: { agentName: "News" },
      authorityRow: {
        capability: "push.send",
        domain: "sharing",
        verb: "act",
        action: "send a notification",
        resource: "Briefings",
        resourceScope: { kind: "exact", key: "channel:briefings" },
        tier: "gated",
        statement: "prospective",
        provenance: { source: "receiver" },
        flags: {},
      },
      operationSubstance: {
        kind: "send",
        summary: "Send 1 briefing to Briefings",
        detail: "Subject: Overnight workspace summary",
        digest: "prepared:e2e-briefing",
      },
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
    expect(probe?.text).toContain("Send the nightly briefing");
    expect(probe?.text).toContain("Publishing & sending");
    expect(probe?.text).toContain("What exactly");
    expect(probe?.text).toContain("Send 1 briefing to Briefings");
    expect(probe?.text).toContain("Subject: Overnight workspace summary");
    expect(probe?.card?.height ?? 0).toBeGreaterThan(120);
    // The dynamic-agent scope ladder rendered and contains no installed-code
    // trust decision.
    expect(probe?.text).toContain("Allow once");
    expect(probe?.text).toContain("Allow for this task");
    expect(probe?.text).toContain("Always for News");
    expect(probe?.text).toContain("Don't allow");
    expect(probe?.text).not.toContain("Trust this version");

    // Panels were NOT blanked — at least one panel remains in the live tree.
    await expect
      .poll(
        () =>
          testApp!.app.evaluate(async () => {
            const api = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } })
              .__testApi;
            const tree = api?.getPanelTree?.() ?? [];
            return Array.isArray(tree) ? tree.length : 0;
          }),
        { timeout: 30_000, intervals: [300, 600, 1000] }
      )
      .toBeGreaterThan(0);

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

    // Mission review uses the same overlay/card shell and the same authority
    // row vocabulary, with charter side-sections and a mission-specific
    // decision row.
    const missionRow = {
      capability: "push.send",
      domain: "sharing",
      verb: "act",
      action: "send a notification",
      resource: "Briefings",
      resourceScope: { kind: "exact", key: "channel:briefings" },
      tier: "gated",
      statement: "snapshot",
      provenance: { source: "mission" },
      flags: { newInDiff: true },
    };
    const missionApproval = {
      kind: "mission-review",
      approvalId: "e2e-mission",
      callerId: "mission:nightly",
      callerKind: "system",
      repoPath: "workers/system-agent",
      effectiveVersion: "ev",
      requestedAt: 1,
      missionId: "mission:nightly",
      revision: 1,
      closureDigest: "b".repeat(64),
      reviewKind: "draft",
      title: "Nightly workspace briefing",
      taskSummary: "Summarize today’s workspace changes and send one briefing.",
      triggerSummary: "Every day at 02:00",
      authority: {
        rows: [missionRow],
        diff: { added: [missionRow], removed: [], unchanged: [], retiered: [] },
      },
      toolkitDomains: ["files", "sharing"],
      networkSummary: "No websites",
      lineageSummary: "your workspace and its own work",
      charter: {
        agentBindingId: "binding:news",
        taskSpec: "Summarize today’s workspace changes and send one briefing.",
        harness: { unit: "workers/system-agent", ev: "a".repeat(64) },
        skills: [],
        toolExposure: {
          services: ["push.send"],
          userlandServices: [],
          workspaceServiceDiscovery: "bound",
          evalNetwork: "none",
          declaredOrigins: [],
        },
        model: { modelId: "openai-codex:gpt-5.4-mini", params: {} },
        declaredLineageClasses: ["none"],
        trigger: { kind: "cron", cron: "0 2 * * *" },
      },
      charterChanges: [],
    };
    await callShellView(testApp, "showContentOverlay", {
      surface: "approval-card",
      bounds: { x: 200, y: 120, width: 700, height: 620 },
      props: { approval: missionApproval, queue: null, decisionError: null },
      theme: { appearance: "light" },
    });
    await expect
      .poll(async () => (await probeOverlay(testApp!))?.text ?? "", {
        timeout: 15_000,
        intervals: [200, 400],
      })
      .toContain("Approve mission");
    const missionProbe = await probeOverlay(testApp);
    expect(missionProbe?.text).toContain("What it’s allowed to do without asking");
    expect(missionProbe?.text).toContain("Publishing & sending");
    expect(missionProbe?.text).toContain("Every day at 02:00");
    expect(missionProbe?.text).toContain("Actions that can’t be undone always wait for you");

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
