import { expect, test } from "@playwright/test";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";
import {
  callWorkspaceService,
  captureShellConsole,
  clickOutsideCommandOverlay,
  clickInCommandOverlay,
  pressChordOnFocusedContents,
  readShellConsole,
  pressInCommandOverlay,
  probeCommandOverlay,
  typeIntoCommandOverlay,
  waitHostedShellReady,
} from "../support/commandOverlay";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

/**
 * The command overlay, end to end (quickfire-overlay-spec §1.3, §2.3, §4.1).
 *
 * Each assertion here stands in for a defect that shipped and could only be seen
 * by running the app: the accelerator swallowed by the shell's key forwarding,
 * Escape only working while the caret sat in the input, and the agent vessel
 * failing to activate because the host created it without an owner and could not
 * join it to its own channel. Unit tests could not see any of them — they live
 * between the main process, the server, and a userland Durable Object.
 *
 * Deliberately NOT asserted: a model reply. The e2e workspace has no provider
 * credentials, and the failures worth catching all happen before the first model
 * call — creating the channel, activating the vessel, joining it, and rendering
 * the conversation.
 */
test.describe("command overlay", () => {
  // A fresh e2e workspace compiles every unit on first use — `panels/chat` alone
  // takes ~35s in a cold run — and the conversation's harness worker is built
  // the first time anyone opens the agent scope. The budget is generous on
  // purpose: a slow build is not the failure this spec is looking for.
  test.describe.configure({ timeout: 420_000 });

  let testApp: TestApp;

  test.beforeAll(async () => {
    // The launch budget is separate from the readiness poll below, and on a
    // machine building several workspaces at once the default 120s expires
    // before the test API is exposed. Neither budget relaxes an assertion.
    testApp = await launchTestApp({ launchTimeout: 300_000 });
    await waitHostedShellReady(testApp);
    await captureShellConsole(testApp);
  });

  test.afterAll(async () => {
    await testApp?.cleanup();
  });

  test("opens on the command chord even while a panel holds focus", async () => {
    expect(await pressChordOnFocusedContents(testApp, "K", ["control"])).toBe(true);

    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, {
        timeout: 20_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);

    const snapshot = await probeCommandOverlay(testApp);
    // No conversation exists on a fresh workspace, so the chord lands on the
    // ranked palette rather than resuming (§1.3).
    expect(snapshot?.activeMode).toBe("All");
    expect(snapshot?.conversation).toBe(false);
  });

  test("closes on Escape when focus is not in the input", async () => {
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, { timeout: 20_000 })
      .toBe(true);

    expect(await pressInCommandOverlay(testApp, "Escape", { blurInput: true })).toBe(true);

    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, {
        timeout: 10_000,
        intervals: [250, 500],
      })
      .toBe(false);
  });

  test("closes when the user clicks a sibling panel or shell surface", async () => {
    expect(await pressChordOnFocusedContents(testApp, "K", ["control"])).toBe(true);
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, { timeout: 20_000 })
      .toBe(true);

    expect(await clickOutsideCommandOverlay(testApp)).toBe(true);

    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, {
        timeout: 10_000,
        intervals: [250, 500],
      })
      .toBe(false);
  });

  test("routes typed prose to the panel's agent and binds a conversation", async () => {
    expect(await pressChordOnFocusedContents(testApp, "K", ["control"])).toBe(true);
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, { timeout: 20_000 })
      .toBe(true);

    expect(await typeIntoCommandOverlay(testApp, "why is this panel laid out this way?")).toBe(
      true
    );

    // The ask row is the mixed scope's answer to prose, and it must be the Enter
    // target — the first rendered row (§4.1).
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.rows[0] ?? "", { timeout: 10_000 })
      .toMatch(/Ask about/i);

    expect(await pressInCommandOverlay(testApp, "Enter")).toBe(true);

    // The overlay runs in the shell CHROME, not in a panel. A `context:
    // "creator"` workspace service (which is how `channel` is declared) resolves
    // through `entityCache.resolveContext(callerId)` and refuses a caller with
    // no runtime context — so whether the shell app has an entity at all decides
    // whether it can ever reach the conversation's channel. Recorded here
    // because it is the difference between "delivery is broken" and "this
    // caller was never able to subscribe".
    const entities = await callWorkspaceService(testApp, "runtime", "listEntities", [
      { kind: "app" },
    ]);
    const appRows = (entities.ok ? (entities.value as Array<Record<string, unknown>>) : []) ?? [];
    console.log(
      "[diagnostic] app entities:",
      entities.ok
        ? JSON.stringify(appRows.map((row) => ({ id: row["id"], contextId: row["contextId"] })))
        : `refused: ${entities.error}`
    );

    // Whatever the chrome's channel client said about this conversation. Empty
    // output here is itself a finding: it means the subscription neither failed
    // nor warned, and the messages simply never arrived.
    const consoleLines = await readShellConsole(testApp);
    console.log(
      "[diagnostic] shell console:",
      consoleLines
        .filter((line) => /channel|subscri|quickfire|replay|participant/i.test(line))
        .slice(-20)
        .join("\n") || "(nothing matched)"
    );

    // Assert on the TRANSCRIPT, never on the surface text: the Base service is
    // deliberately not exposed as a host schema, and the ask row quotes
    // the query back, so a whole-surface match passes the moment you type and
    // says nothing about the conversation. A rendered message has been through
    // createEntity, vessel activation, subscribeChannel and the channel's own
    // delivery — the exact chain that failed with 403s, a 500, and a closure
    // missing its plumbing.
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.transcript ?? [], {
        timeout: 300_000,
        intervals: [1000, 2000, 5000],
      })
      .toContain("why is this panel laid out this way?");

    const snapshot = await probeCommandOverlay(testApp);
    expect(snapshot?.conversation).toBe(true);
    expect(snapshot?.text).not.toMatch(/no authority branch admits/i);
    expect(snapshot?.text).not.toMatch(/DO dispatch failed/i);
    expect(snapshot?.text).not.toMatch(/Not a member of this workspace/i);
  });

  test("offers both conversation exits once a conversation exists", async () => {
    const snapshot = await probeCommandOverlay(testApp);
    expect(snapshot?.conversation).toBe(true);
    // Clearing and promoting are the two ways a conversation ends; an
    // unlabelled glyph made the second invisible, so both are asserted by name.
    expect(snapshot?.text).toMatch(/Clear/);
    expect(snapshot?.text).toMatch(/Move to chat panel/);
  });

  test("resumes into the existing conversation on the next chord", async () => {
    expect(await pressInCommandOverlay(testApp, "Escape", { blurInput: true })).toBe(true);
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, { timeout: 10_000 })
      .toBe(false);

    expect(await pressChordOnFocusedContents(testApp, "K", ["control"])).toBe(true);

    // One key, resume-aware: the panel now has a conversation, so the same chord
    // that opened the palette above lands in the conversation instead.
    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.conversation === true, {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
  });

  test("promotes the same conversation into a ready chat panel", async () => {
    expect(await clickInCommandOverlay(testApp, "Move to chat panel")).toBe(true);

    await expect
      .poll(async () => (await probeCommandOverlay(testApp))?.open === true, {
        timeout: 120_000,
        intervals: [500, 1000, 2000],
      })
      .toBe(false);

    await expect
      .poll(
        async () =>
          testApp.app.evaluate(async ({ webContents }) => {
            const texts: string[] = [];
            for (const contents of webContents.getAllWebContents()) {
              if (contents.isDestroyed() || contents.getTitle() !== "Agentic Chat") continue;
              try {
                texts.push(
                  String(await contents.executeJavaScript("document.body?.innerText ?? ''", true))
                );
              } catch {
                // A view can disappear while the panel tree is settling.
              }
            }
            return texts;
          }),
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toEqual(
        expect.arrayContaining([expect.stringContaining("why is this panel laid out this way?")])
      );
  });
});
