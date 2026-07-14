import { describe, expect, it } from "vitest";
import type { RuntimeEntitySummary } from "@vibestudio/shared/runtime/entitySpec";
import { verifyPanelCodeIdentity } from "./panelCodeIdentity.js";

const panel = {
  callerId: "panel-view-1",
  runtimeEntityId: "panel:entry-1",
  source: "panels/terminal",
  executionDigest: "a".repeat(64),
};

const activeEntity: RuntimeEntitySummary = {
  id: panel.runtimeEntityId,
  kind: "panel",
  source: panel.source,
  contextId: "ctx-terminal",
  createdAt: 1,
  executionDigest: panel.executionDigest,
  authorityRequests: [
    { capability: "rpc:shell.open", resource: { kind: "exact", key: "workspace" } },
  ],
};

describe("verifyPanelCodeIdentity", () => {
  it("returns the authority sealed into the exact active panel execution", () => {
    expect(verifyPanelCodeIdentity(panel, [activeEntity])).toEqual({
      callerId: panel.callerId,
      callerKind: "panel",
      repoPath: panel.source,
      executionDigest: panel.executionDigest,
      requested: activeEntity.authorityRequests,
    });
  });

  it.each([
    ["kind", { kind: "worker" }],
    ["source", { source: "panels/other" }],
    ["execution", { executionDigest: "b".repeat(64) }],
    ["sealed authority", { authorityRequests: undefined }],
  ])("rejects a mismatched active %s", (_label, override) => {
    expect(() => verifyPanelCodeIdentity(panel, [{ ...activeEntity, ...override }])).toThrow(
      /execution identity changed/
    );
  });

  it("rejects a retired or otherwise missing runtime entity", () => {
    expect(() => verifyPanelCodeIdentity(panel, [])).toThrow(/runtime entity is missing/);
  });
});
