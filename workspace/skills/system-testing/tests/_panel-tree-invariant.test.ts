import { describe, expect, it } from "vitest";
import {
  createdPanelRoots,
  panelTreeDifference,
  type VisiblePanelNode,
} from "./_panel-tree-invariant.js";
import { PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { cdpGadDiagnosticTests } from "./cdp-gad-diagnostics.js";
import { panelTests } from "./panels.js";

function tree(...nodes: VisiblePanelNode[]): Map<string, VisiblePanelNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe("panel-tree invariant", () => {
  it("distinguishes leaked panels from pre-existing panels the agent removed", () => {
    const before = tree(
      { id: "existing-root", parentId: null, kind: "workspace" },
      { id: "existing-child", parentId: "existing-root", kind: "browser" }
    );
    const after = tree(
      { id: "existing-root", parentId: null, kind: "workspace" },
      { id: "new-root", parentId: null, kind: "workspace" },
      { id: "new-child", parentId: "new-root", kind: "browser" }
    );

    expect(panelTreeDifference(before, after)).toEqual({
      createdIds: ["new-child", "new-root"],
      removedPreexistingIds: ["existing-child"],
    });
  });

  it("archives only the highest created nodes so subtree cleanup is canonical", () => {
    const after = tree(
      { id: "existing-root", parentId: null, kind: "workspace" },
      { id: "new-under-existing", parentId: "existing-root", kind: "browser" },
      { id: "new-root", parentId: null, kind: "workspace" },
      { id: "new-child", parentId: "new-root", kind: "browser" }
    );

    expect(
      createdPanelRoots(["new-child", "new-root", "new-under-existing"], after).map(
        (node) => node.id
      )
    ).toEqual(["new-root", "new-under-existing"]);
  });

  it("keeps cleanup instructions out of every panel-automation goal", () => {
    const cases = [...panelTests, ...cdpGadDiagnosticTests, ...agenticRuntimeTests].filter(
      (test) => test.resources?.includes(PANEL_AUTOMATION_RESOURCE)
    );

    expect(cases).toHaveLength(11);
    for (const test of cases) {
      expect(test.prompt).not.toMatch(/\b(?:archive|close|clean\s*up|cleanup)\b/iu);
      if (test.name !== "panel-list-sources") {
        expect(test.orchestrate, `${test.name} should enforce the tree invariant`).toEqual(
          expect.any(Function)
        );
      }
    }
  });
});
