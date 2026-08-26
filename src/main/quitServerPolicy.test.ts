import { describe, expect, it } from "vitest";
import { ordinaryQuitServerDecision } from "./quitServerPolicy.js";

describe("ordinaryQuitServerDecision", () => {
  it("always stops a desktop-owned ephemeral hub", () => {
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: true,
        rememberedKeepServer: true,
      })
    ).toBe("stop");
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: true,
        rememberedKeepServer: false,
      })
    ).toBe("stop");
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: true,
        rememberedKeepServer: null,
      })
    ).toBe("stop");
  });

  it("uses the remembered policy for a persistent local hub", () => {
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: false,
        rememberedKeepServer: false,
      })
    ).toBe("stop");
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: false,
        rememberedKeepServer: true,
      })
    ).toBe("keep");
  });

  it("prompts only for an owned persistent hub without a preference", () => {
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: true,
        ephemeralWorkspace: false,
        rememberedKeepServer: null,
      })
    ).toBe("prompt");
    expect(
      ordinaryQuitServerDecision({
        ownsLocalHub: false,
        ephemeralWorkspace: false,
        rememberedKeepServer: null,
      })
    ).toBe("keep");
  });
});
