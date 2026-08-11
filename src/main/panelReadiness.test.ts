import { describe, expect, it } from "vitest";
import type { AttemptPhase, PanelSlotObservation } from "@vibestudio/shared/panel/observation";
import type { PanelPresentationSnapshot } from "@vibestudio/shared/panel/presentation";
import { panelReadinessSnapshot } from "./panelReadiness.js";

const observation = (phase: AttemptPhase): PanelSlotObservation => ({
  attempt: {
    epoch: "epoch",
    attemptId: "server-attempt",
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

const presentation = (state: "loading" | "ready"): PanelPresentationSnapshot =>
  state === "ready"
    ? {
        revision: 4,
        presentation: {
          state: "ready",
          slotId: "panel:tree/root",
          attemptId: "local-attempt",
          surface: "code",
          runtimeEntityId: "panel:nav-chat",
          webContentsId: 7,
          nativeSlotId: "pane:primary",
          documentRevision: 1,
          url: "http://localhost/panel",
          enteredAt: 1,
        },
      }
    : {
        revision: 3,
        presentation: {
          state: "loading",
          slotId: "panel:tree/root",
          attemptId: "local-attempt",
          stage: "booting",
          enteredAt: 1,
        },
      };

describe("panel canonical readiness projection", () => {
  it("uses the local presentation as its only readiness oracle", () => {
    expect(
      panelReadinessSnapshot({
        panelId: "panel:tree/root",
        source: "panels/chat",
        nativeSlotBound: true,
        presentation: presentation("loading"),
        observation: observation("ready"),
      })
    ).toMatchObject({ contentReady: false, terminal: false });
  });

  it("does not make delayed coordinator propagation block a ready presentation", () => {
    expect(
      panelReadinessSnapshot({
        panelId: "panel:tree/root",
        source: "panels/chat",
        nativeSlotBound: true,
        presentation: presentation("ready"),
        observation: observation("pending"),
      })
    ).toMatchObject({
      contentReady: true,
      terminal: true,
      runtimeEntityId: "panel:nav-chat",
      presentationRevision: 4,
    });
  });
});
