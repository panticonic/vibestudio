import { describe, expect, it } from "vitest";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";

describe("canonicalWorkspaceObjectContextId", () => {
  it("derives a deterministic workspace-scoped context slug", () => {
    const identity = {
      source: "workers/workspace-presentation",
      className: "WorkspacePresentationDO",
      key: "workspace-presentation",
    };
    const contextId = canonicalWorkspaceObjectContextId("workspace-1", identity);

    expect(contextId).toMatch(/^object-[a-f0-9]{32}$/u);
    expect(canonicalWorkspaceObjectContextId("workspace-1", identity)).toBe(contextId);
    expect(canonicalWorkspaceObjectContextId("workspace-2", identity)).not.toBe(contextId);
  });
});
