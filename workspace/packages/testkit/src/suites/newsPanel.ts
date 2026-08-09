/** End-to-end coverage for the News panel's agent-backed reader startup. */
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { audit, clearViewport, panelText, setViewport, waitForText, withPanel } from "../panels.js";

export const newsPanel = suite("news-panel", {
  timeoutMs: 120_000,
  usesPanelAutomation: true,
}).test("starts its agent and renders the persisted reader overview", async () =>
  withPanel("panels/news", async (handle) => {
    // This schedule comes from getOverview on the subscribed News agent. It
    // is the reader's positive readiness signal, independent of whether the
    // responsive layout currently presents the embedded chat transcript.
    await waitForText(handle, "polls every", { timeoutMs: 60_000 });
    const text = await panelText(handle);
    expect(text, "reader navigation").toContain("Inbox");
    expect(text, "saved navigation").toContain("Saved");
    expect(text, "briefing navigation").toContain("Briefings");
    // Reader-first means the expensive conversational surface is not mounted
    // until the user asks for it.
    expect(text, "assistant is closed by default").not.toContain("News assistant");
    expect(text, "News startup failure affordance").not.toContain("Retry startup");
    expect(text, "stored-value schema leakage").not.toContain("Expected string, received number");

    await setViewport(handle, { width: 390, height: 844, mobile: true });
    const mobile = await audit(handle);
    expect(mobile.horizontalOverflow, "mobile horizontal overflow").toBe(false);
    expect(mobile.consoleErrors, "mobile console errors").toBe(0);
    await clearViewport(handle);
  })
);
