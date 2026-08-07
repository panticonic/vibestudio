import { describe, expect, it } from "vitest";
import type { AttemptPhase, PanelSlotObservation } from "@vibestudio/shared/panel/observation";
import { panelReadinessSnapshot } from "./panelReadiness.js";

const observation = (phase: AttemptPhase): PanelSlotObservation => ({
  attempt: {
    epoch: "epoch",
    attemptId: "attempt",
    slotId: "panel:tree/root",
    runtimeEntityId: "panel:nav-chat",
    phase,
    revision: 2,
    reporter: "renderer",
    updatedAt: 1,
  },
  route: { reachable: true, connectionId: "route" },
  version: { epoch: "epoch", counter: 3 },
});

describe("panel canonical readiness projection", () => {
  it("derives content readiness only from the canonical attempt", () => {
    expect(
      panelReadinessSnapshot({
        panelId: "panel:tree/root",
        source: "panels/chat",
        nativeSlotBound: false,
        observation: observation("ready"),
      })
    ).toMatchObject({ contentReady: true, terminal: false });
  });

  it("requires the native slot only for visible terminal readiness", () => {
    expect(
      panelReadinessSnapshot({
        panelId: "panel:tree/root",
        source: "panels/chat",
        nativeSlotBound: true,
        observation: observation("ready"),
      })
    ).toMatchObject({ contentReady: true, terminal: true });
  });

  it("does not infer readiness from route or host-local artifact facts", () => {
    expect(
      panelReadinessSnapshot({
        panelId: "panel:tree/root",
        source: "panels/chat",
        nativeSlotBound: true,
        observation: observation("booting"),
      })
    ).toMatchObject({ contentReady: false, terminal: false });
  });
});
