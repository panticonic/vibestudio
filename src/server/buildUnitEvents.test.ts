import { describe, expect, it, vi } from "vitest";
import { isValidEventName } from "@vibestudio/shared/events";
import { forwardUnitChanges } from "./buildUnitEvents.js";

describe("forwardUnitChanges", () => {
  it("coalesces one publication's unit changes into one subscribable event", async () => {
    let listener: ((event: never) => void) | null = null;
    const unsubscribe = vi.fn();
    const emit = vi.fn();
    const off = forwardUnitChanges(
      {
        onUnitChange: (callback) => {
          listener = callback as never;
          return unsubscribe;
        },
      },
      emit
    );
    listener!({ name: "@w/agent", relativePath: "workers/agent", kind: "worker" } as never);
    listener!({ name: "@w/chat", relativePath: "panels/chat", kind: "panel" } as never);
    expect(emit).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      units: [
        { name: "@w/agent", relativePath: "workers/agent", kind: "worker" },
        { name: "@w/chat", relativePath: "panels/chat", kind: "panel" },
      ],
    });
    off();
    expect(unsubscribe).toHaveBeenCalled();
    expect(isValidEventName("workspace:units-changed")).toBe(true);
  });
});
