import { describe, expect, it, vi } from "vitest";
import { observeDesktopPanelHost } from "./panelHostObservation";

describe("observeDesktopPanelHost", () => {
  it("publishes the canonical host observation without flattening its view", async () => {
    const getBootObservation = vi.fn(async () => ({
      kind: "observed" as const,
      observation: { phase: "ready" as const },
    }));
    const getPanelHostObservation = vi.fn(() => ({
      holderLabel: "Desktop",
      platform: "desktop" as const,
      supportsInspection: true,
      viewRevision: 7,
      view: { exists: true, url: "http://panel.test/", loading: false },
      boot: { kind: "observed" as const, observation: { phase: "ready" as const } },
    }));

    await expect(
      observeDesktopPanelHost({ getBootObservation, getPanelHostObservation }, "panel:tree/test")
    ).resolves.toEqual({
      holderLabel: "Desktop",
      platform: "desktop",
      supportsInspection: true,
      viewRevision: 7,
      view: { exists: true, url: "http://panel.test/", loading: false },
      boot: { kind: "observed" as const, observation: { phase: "ready" } },
    });
  });

  it("rejects the obsolete flattened desktop-only shape at its producer", async () => {
    const source = {
      getBootObservation: vi.fn(async () => ({
        kind: "observed" as const,
        observation: { phase: "ready" as const },
      })),
      getPanelHostObservation: vi.fn(
        () =>
          ({
            url: "http://panel.test/",
            loading: false,
            boot: { kind: "observed" as const, observation: { phase: "ready" } },
          }) as never
      ),
    };

    await expect(observeDesktopPanelHost(source, "panel:tree/test")).rejects.toThrow();
  });
});
