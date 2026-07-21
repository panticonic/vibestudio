import { describe, expect, it } from "vitest";
import {
  findReviewedInternalDurableObjectTarget,
  REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS,
} from "./reviewedInternalDurableObjectTargets.js";

describe("reviewed internal Durable Object targets", () => {
  it("derives the exact GAD singleton and its workspace-service authority", () => {
    expect(
      findReviewedInternalDurableObjectTarget(
        "vibestudio/internal",
        "GadWorkspaceDO",
        "workspace-semantic-control-plane"
      )
    ).toEqual({
      source: "vibestudio/internal",
      className: "GadWorkspaceDO",
      objectKey: "workspace-semantic-control-plane",
      authority: {
        capability: "workspace-service:gad.workspace",
        principals: ["host", "user", "code"],
      },
    });
  });

  it("reviews only the one BrowserDataDO storage identity for broker code", () => {
    expect(
      findReviewedInternalDurableObjectTarget("vibestudio/internal", "BrowserDataDO", "global")
    ).toEqual({
      source: "vibestudio/internal",
      className: "BrowserDataDO",
      objectKey: "global",
      authority: {
        capability: "service:workers.resolveDurableObject",
        principals: ["code"],
      },
    });
    expect(
      findReviewedInternalDurableObjectTarget("vibestudio/internal", "BrowserDataDO", "guessed")
    ).toBeNull();
  });

  it("contains no class-wide or key-wide patterns", () => {
    expect(REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS).not.toContainEqual(
      expect.objectContaining({ className: "*" })
    );
    expect(REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS).not.toContainEqual(
      expect.objectContaining({ objectKey: "*" })
    );
  });
});
