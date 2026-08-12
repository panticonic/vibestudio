import { describe, expect, it, vi } from "vitest";
import {
  createdPanelRoots,
  orchestratePanelGoal,
  orchestrateSeededPanelGoal,
  panelTreeDifference,
  type VisiblePanelNode,
} from "./_panel-tree-invariant.js";
import { validateAgentCompletionReport } from "../test-runner.js";
import type { TestOrchestrationContext } from "../types.js";
import { PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { cdpGadDiagnosticTests } from "./cdp-gad-diagnostics.js";
import { panelTests } from "./panels.js";
import { projectLifecycleTests } from "./project-lifecycle.js";

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

  it("records a leaked child before harness cleanup and cannot pass on the agent report", async () => {
    const visible = tree({ id: "existing-root", parentId: null, kind: "workspace" });
    const archived: string[] = [];
    const removeSubtree = (id: string): void => {
      for (const node of [...visible.values()]) {
        if (node.parentId === id) removeSubtree(node.id);
      }
      visible.delete(id);
    };
    const page = (parentId: string | null) => ({
      revision: 1,
      group: parentId ? "children" : "roots",
      entries: [...visible.values()]
        .filter((node) => node.parentId === parentId)
        .map((node) => ({
          node: {
            slotId: node.id,
            parentSlotId: node.parentId,
            kind: node.kind,
          },
          handle: {},
        })),
      nextCursor: null,
    });
    const panelTree = {
      roots: vi.fn(async () => page(null)),
      children: vi.fn(async (parentId: string) => page(parentId)),
      get: vi.fn((id: string) => ({
        archive: async () => {
          archived.push(id);
          removeSubtree(id);
        },
      })),
    } as unknown as NonNullable<Parameters<typeof orchestratePanelGoal>[3]>;
    const completion = {
      id: "agent-completion",
      senderId: "agent",
      senderMetadata: { type: "agent" as const },
      kind: "message" as const,
      contentType: "text" as const,
      content: "Task completed. I inspected the requested panel.",
      complete: true,
    };
    const session = {
      messages: [completion],
      snapshot: () => ({}),
      close: vi.fn(async () => undefined),
    };
    const context = {
      runner: {
        panelTreeClient: panelTree,
        spawn: vi.fn(async () => session),
      },
      remainingTimeMs: () => 1_000,
      sendAndWait: vi.fn(async () => {
        visible.set("leaked-child", {
          id: "leaked-child",
          parentId: "existing-root",
          kind: "browser",
        });
        visible.set("leaked-grandchild", {
          id: "leaked-grandchild",
          parentId: "leaked-child",
          kind: "workspace",
        });
        return completion;
      }),
    } as unknown as TestOrchestrationContext;

    const execution = await orchestratePanelGoal(
      context,
      "Inspect that browser view.",
      "inspect vague panel reference",
      panelTree
    );

    expect(execution.error).toContain(
      "Agent left temporary panels in the tree: leaked-child, leaked-grandchild"
    );
    expect(execution.diagnostics?.["panelTreeInvariant"]).toMatchObject({
      createdIds: ["leaked-child", "leaked-grandchild"],
      harnessArchivedRootIds: ["leaked-child"],
      remainingCreatedIds: [],
    });
    expect(archived).toEqual(["leaked-child"]);
    expect([...visible.keys()]).toEqual(["existing-root"]);
    expect(validateAgentCompletionReport(execution)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("Agent left temporary panels"),
    });
  });

  it("seeds a real vague-reference target, observes same-panel navigation, then owns cleanup", async () => {
    const visible = tree();
    let source = "https://example.com/";
    const archive = vi.fn(async () => {
      visible.delete("seeded-browser");
    });
    const handle = {
      id: "seeded-browser",
      kind: "browser",
      archive,
      observe: vi.fn(async () => ({
        panelId: "seeded-browser",
        source,
        phase: "ready",
      })),
    };
    const page = (parentId: string | null) => ({
      revision: 1,
      group: parentId ? "children" : "roots",
      entries: [...visible.values()]
        .filter((node) => node.parentId === parentId)
        .map((node) => ({
          node: {
            slotId: node.id,
            parentSlotId: node.parentId,
            kind: node.kind,
          },
          handle,
        })),
      nextCursor: null,
    });
    const panelTree = {
      roots: vi.fn(async () => page(null)),
      children: vi.fn(async (parentId: string) => page(parentId)),
      path: vi.fn(async (id: string) =>
        visible.has(id)
          ? {
              revision: 1,
              entries: page(null).entries.filter((entry) => entry.node.slotId === id),
            }
          : null
      ),
      get: vi.fn(() => handle),
    };
    const completion = {
      id: "agent-completion",
      senderId: "agent",
      senderMetadata: { type: "agent" as const },
      kind: "message" as const,
      contentType: "text" as const,
      content: "The existing browser view now shows example.org.",
      complete: true,
    };
    const session = {
      messages: [completion],
      snapshot: () => ({}),
      close: vi.fn(async () => undefined),
    };
    const context = {
      runner: {
        openPanelClient: vi.fn(async () => {
          visible.set("seeded-browser", {
            id: "seeded-browser",
            parentId: null,
            kind: "browser",
          });
          return handle;
        }),
        panelTreeClient: panelTree,
        spawn: vi.fn(async () => session),
      },
      remainingTimeMs: () => 1_000,
      sendAndWait: vi.fn(async () => {
        expect(visible.has("seeded-browser")).toBe(true);
        source = "https://example.org/";
        return completion;
      }),
    } as unknown as TestOrchestrationContext;

    const execution = await orchestrateSeededPanelGoal(
      context,
      "Where did that browser view end up?",
      "resolve a vague panel reference",
      "https://example.com/",
      "https://example.org/",
      panelTree as never
    );

    expect(execution.error).toBeUndefined();
    expect(execution.diagnostics?.["seededPanelGoal"]).toEqual({
      panelId: "seeded-browser",
      expectedFinalSource: "https://example.org/",
      initialSource: "https://example.com/",
      initialPhase: "ready",
      initialPathIds: ["seeded-browser"],
      finalSource: "https://example.org/",
      finalPhase: "ready",
      finalPathIds: ["seeded-browser"],
      targetPreserved: true,
      reachedExpectedSource: true,
    });
    expect(archive).toHaveBeenCalledOnce();
    expect(visible.size).toBe(0);
  });

  it("keeps cleanup instructions out of every panel-automation goal", () => {
    const cases = [
      ...panelTests,
      ...cdpGadDiagnosticTests,
      ...agenticRuntimeTests,
      ...projectLifecycleTests,
    ].filter((test) => test.resources?.includes(PANEL_AUTOMATION_RESOURCE));

    expect(cases).toHaveLength(15);
    for (const test of cases) {
      expect(test.prompt).not.toMatch(/\b(?:archive|close|clean\s*up|cleanup)\b/iu);
      if (test.category !== "project-lifecycle" && test.name !== "panel-list-sources") {
        expect(test.orchestrate, `${test.name} should enforce the tree invariant`).toEqual(
          expect.any(Function)
        );
      }
    }
  });
});
