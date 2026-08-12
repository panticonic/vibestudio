import { describe, expect, it } from "vitest";
import { panelTests } from "./panels.js";

const createPanelTest = panelTests.find((test) => test.name === "create-panel")!;

describe("panel system-test declarations", () => {
  it("preauthorizes inspection of the panel that the unattended test creates", () => {
    expect(createPanelTest.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "manage-panel-state",
          capability: { kind: "exact", key: "workspace.runtime-state.manage" },
          resource: { kind: "exact", key: "workspace.runtime-state.manage" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "manage-panel-context-boundary",
          capability: { kind: "exact", key: "context.boundary" },
          resource: { kind: "prefix", prefix: "context/" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "use-testkit-driver",
          capability: { kind: "exact", key: "workspace-service:testkit-driver" },
          resource: {
            kind: "exact",
            key: "do:workers/testkit-driver:TestkitDriverDO:workspace-testkit-driver",
          },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "inspect-created-panel",
          capability: { kind: "exact", key: "panel.inspect" },
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    });
  });

  it("guards every scenario that can create a panel", () => {
    for (const test of panelTests.filter((candidate) => candidate.name !== "panel-list-sources")) {
      expect(test.orchestrate).toEqual(expect.any(Function));
    }
  });

  it("uses the navigation case for a vague user reference instead of panel ids", () => {
    const navigation = panelTests.find((test) => test.name === "panel-tree-navigation");

    expect(navigation).toMatchObject({
      description: "Resolve a vague browser-view reference through the panel tree",
    });
    expect(navigation?.prompt).toContain("that browser view");
    expect(navigation?.prompt).not.toMatch(/\b(?:panel[- ]?id|slot[- ]?id|parent[- ]?id)\b/iu);
    expect(navigation?.validation).toBe("agent-evidence");
  });

  it("requires independent same-panel navigation evidence", () => {
    const navigation = panelTests.find((test) => test.name === "panel-tree-navigation")!;
    const evidence = {
      panelId: "seeded-browser",
      expectedFinalUrl: "https://example.org/",
      initialSource: "browser:https://example.com/",
      initialUrl: "https://example.com/",
      initialPhase: "ready",
      initialPathIds: ["seeded-browser"],
      finalSource: "browser:https://example.com/",
      finalUrl: "https://example.org/",
      finalPhase: "ready",
      finalPathIds: ["seeded-browser"],
      targetPreserved: true,
      reachedExpectedDestination: true,
    };

    expect(
      navigation.validate({
        messages: [],
        duration: 1,
        diagnostics: { seededPanelGoal: evidence },
      })
    ).toEqual({ passed: true, reason: undefined });
    expect(
      navigation.validate({
        messages: [],
        duration: 1,
        diagnostics: {
          seededPanelGoal: { ...evidence, finalUrl: "https://example.com/" },
        },
      })
    ).toMatchObject({ passed: false });
  });
});
