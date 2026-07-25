import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createDurableWorkService } from "./durableWorkService.js";
import type { DurableWorkDriver } from "./durableWorkDriver.js";

describe("durableWork service", () => {
  it("returns the bounded driver inspection without transforming it", async () => {
    const inspection = {
      workerId: "driver:test",
      accepting: true,
      active: 0,
      pendingHints: 0,
      activeLanes: [],
      duplicateHints: 1,
      staleSettlements: 0,
      recoveryScans: 2,
      recoveryHits: 1,
      claimsByTrigger: { hint: 3, recovery: 1, continuation: 2 },
      recentTrace: [],
    };
    const driver = {
      inspect: vi.fn(() => inspection),
    } as unknown as DurableWorkDriver;
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createDurableWorkService(driver));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("shell:test", "shell") },
        "durableWork",
        "inspect",
        []
      )
    ).resolves.toEqual(inspection);
    expect(driver.inspect).toHaveBeenCalledOnce();
  });
});
