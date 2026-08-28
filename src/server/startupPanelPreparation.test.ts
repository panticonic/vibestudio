import { describe, expect, it, vi } from "vitest";

import { prepareStartupPanels } from "./startupPanelPreparation.js";

describe("prepareStartupPanels", () => {
  it("prepares each declared initial panel once without creating runtime state", async () => {
    const pending: Array<() => void> = [];
    const prime = vi.fn((source: string) => {
      void source;
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    });

    const preparing = prepareStartupPanels(
      {
        initPanels: [
          { source: "panels/chat" },
          { source: " panels/notes " },
          { source: "panels/chat", stateArgs: { restored: true } },
        ],
      },
      prime
    );

    await vi.waitFor(() => expect(prime).toHaveBeenCalledTimes(2));
    expect(prime.mock.calls.map(([source]) => source)).toEqual(["panels/chat", "panels/notes"]);
    pending.forEach((resolve) => resolve());

    await expect(preparing).resolves.toMatchObject({
      sources: ["panels/chat", "panels/notes"],
    });
  });

  it("finishes without work when the workspace has no initial panels", async () => {
    const prime = vi.fn<() => Promise<void>>();
    await expect(prepareStartupPanels({ initPanels: [] }, prime)).resolves.toMatchObject({
      sources: [],
    });
    expect(prime).not.toHaveBeenCalled();
  });
});
