import { describe, expect, it } from "vitest";
import { scopeCovers } from "@vibestudio/shared/authorization";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  CONTEXT_BOUNDARY_CAPABILITY,
  contextBoundaryResourceKey,
  prepareContextBoundarySelection,
} from "./contextBoundary.js";

const caller = createVerifiedCaller("panel:p1", "panel", {
  callerId: "panel:p1",
  callerKind: "panel",
  repoPath: "panels/p",
  effectiveVersion: "v1",
});
const action = { kind: "runtime" as const, verb: "Create panel" };

describe("prepareContextBoundarySelection", () => {
  it("omits same-context and fresh-context leaves", () => {
    const existing = { contextExists: () => true };
    expect(
      prepareContextBoundarySelection(existing, {
        subjectCaller: caller,
        originContextId: "ctx-a",
        targetContextId: "ctx-a",
        action,
      })
    ).toBeNull();
    expect(
      prepareContextBoundarySelection(
        { contextExists: () => false },
        {
          subjectCaller: caller,
          originContextId: "ctx-a",
          targetContextId: "ctx-fresh",
          action,
        }
      )
    ).toBeNull();
  });

  it("derives the exact foreign-context leaf and host review copy", () => {
    expect(
      prepareContextBoundarySelection(
        { contextExists: () => true, resolveContextOwnerLabel: () => "Agent X" },
        {
          subjectCaller: caller,
          originContextId: "ctx-a",
          targetContextId: "ctx-b",
          action,
        }
      )
    ).toEqual(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        resourceKey: contextBoundaryResourceKey("ctx-b", "panel:p1"),
        authorizingCaller: caller,
        challenge: expect.objectContaining({
          title: "Open panel in another workspace branch",
          description: expect.stringContaining("workspace branch owned by Agent X"),
          details: [
            { label: "Owner", value: "Agent X" },
            { label: "Workspace branch", value: "ctx-b" },
          ],
        }),
      })
    );
  });

  it("renders durable-object launches as background processes", () => {
    const selected = prepareContextBoundarySelection(
      { contextExists: () => true },
      {
        subjectCaller: caller,
        originContextId: null,
        targetContextId: "ctx-b",
        action: { kind: "runtime", verb: "Create do" },
      }
    );
    expect(selected?.challenge.title).toBe("Launch background process in another workspace branch");
    expect(selected?.challenge.description).toContain("start a background process");
  });

  it("uses a hierarchical key covered by the manifest context prefix", () => {
    const key = contextBoundaryResourceKey("ctx/a", "panel:p1");
    expect(key).toBe("context/ctx%2Fa/requester/panel%3Ap1");
    expect(scopeCovers({ kind: "prefix", prefix: "context" }, key)).toBe(true);
  });
});
