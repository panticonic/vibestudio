import { describe, expect, it } from "vitest";
import {
  PANEL_OPERATION_ERROR_CODE,
  parsePanelPageObservation,
  PanelOperationError,
  panelAttemptId,
  panelFailure,
  panelFailureBoundaryError,
  panelFailureFromError,
  rethrowPanelOperationError,
} from "./observation.js";

describe("panel observation failures", () => {
  const failure = panelFailure({
    code: "unit_not_found",
    stage: "resolve",
    message: "Unknown build unit: panels/missing",
    provenance: {
      source: "panels/missing",
      contextId: "ctx-test",
      requestedRef: "ctx:ctx-test",
    },
    occurredAt: 1,
  });

  it("preserves structured provenance across the RPC boundary", () => {
    const boundary = panelFailureBoundaryError(failure);

    expect(boundary.code).toBe(PANEL_OPERATION_ERROR_CODE);
    expect(panelFailureFromError(boundary)).toEqual(failure);
    expect(() => rethrowPanelOperationError(boundary)).toThrow(PanelOperationError);

    try {
      rethrowPanelOperationError(boundary);
    } catch (error) {
      expect(error).toBeInstanceOf(PanelOperationError);
      expect((error as PanelOperationError).failure).toEqual(failure);
    }
  });

  it("uses runtime and build identity for stable attempt correlation", () => {
    expect(panelAttemptId("panel:nav-a", "build-a")).toBe("panel:nav-a@build-a");
    expect(panelAttemptId(null, null)).toBe("unassigned@unbuilt");
  });

  it("validates the canonical browser page observation", () => {
    expect(
      parsePanelPageObservation({
        view: { url: "http://127.0.0.1/panel", loading: false },
        boot: {
          phase: "ready",
          runtimeEntityId: "panel:nav-a",
          source: "panels/example",
          contextId: "ctx-a",
          effectiveVersion: "state-a",
          buildKey: "build-a",
          updatedAt: 2,
        },
      })
    ).toEqual({
      view: { url: "http://127.0.0.1/panel", loading: false },
      boot: {
        phase: "ready",
        runtimeEntityId: "panel:nav-a",
        source: "panels/example",
        contextId: "ctx-a",
        effectiveVersion: "state-a",
        buildKey: "build-a",
        updatedAt: 2,
      },
    });
    expect(() =>
      parsePanelPageObservation({
        view: { url: "http://127.0.0.1/panel", loading: "no" },
        boot: { phase: "ready" },
      })
    ).toThrow("invalid view state");
  });
});
