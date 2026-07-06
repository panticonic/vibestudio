import { describe, expect, it } from "vitest";
import { createVerifiedCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { createPresenceService, createPresenceTracker } from "./presenceService.js";

describe("presenceService", () => {
  it("lets userland callers read active panel owners but not claim ownership", async () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createPresenceService({ presence: createPresenceTracker() }));
    dispatcher.markInitialized();

    await dispatcher.dispatch(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "presence",
      "markPanelActive",
      ["panel:nav-a"]
    );

    for (const kind of ["panel", "worker", "do"] as const) {
      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller(`${kind}:test`, kind) },
          "presence",
          "getPanelActiveOwner",
          ["panel:nav-a"]
        )
      ).resolves.toMatchObject({ ownerCallerId: "shell:desktop" });
    }

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("panel:test", "panel") },
        "presence",
        "markPanelActive",
        ["panel:nav-b"]
      )
    ).rejects.toThrow(/not accessible to panel callers/);
  });
});
