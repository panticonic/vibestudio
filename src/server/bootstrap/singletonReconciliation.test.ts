import { describe, expect, it, vi } from "vitest";
import { reconcileSingletons } from "./singletonReconciliation.js";

describe("reconcileSingletons", () => {
  it("finishes every runtime preparation before any singleton activation", async () => {
    let releaseSecond!: () => void;
    const secondPrepared = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const events: string[] = [];
    const running = reconcileSingletons({
      items: ["first", "second"],
      prepare: async (item) => {
        events.push(`prepare:${item}`);
        if (item === "second") await secondPrepared;
        events.push(`prepared:${item}`);
        return `image:${item}`;
      },
      activate: async (item, image) => {
        events.push(`activate:${item}:${image}`);
        return `record:${item}`;
      },
      onActivated: (record) => events.push(`registered:${record}`),
    });

    await Promise.resolve();
    expect(events).not.toContain("activate:first:image:first");
    releaseSecond();
    await expect(running).resolves.toEqual(["record:first", "record:second"]);
    expect(events.indexOf("prepared:second")).toBeLessThan(
      events.indexOf("activate:first:image:first")
    );
  });

  it("fails reconciliation instead of registering a partial singleton set", async () => {
    const onActivated = vi.fn();
    await expect(
      reconcileSingletons({
        items: ["broken"],
        prepare: async () => "image",
        activate: async () => {
          throw new Error("activation failed");
        },
        onActivated,
      })
    ).rejects.toThrow("activation failed");
    expect(onActivated).not.toHaveBeenCalled();
  });
});
