import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasField,
  finalMessageHasNumericField,
  getToolCalls,
  noFailedInvocations,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  const failed = noFailedInvocations(result);
  if (!failed.passed) return failed;
  return noIncompleteInvocations(result);
}

function checkedWithField(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  field: string
) {
  const base = checked(result, tokens);
  if (!base.passed) return base;
  return finalMessageHasField(result, field);
}

function checkedWithNumericField(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  field: string
) {
  const base = checked(result, tokens);
  if (!base.passed) return base;
  return finalMessageHasNumericField(result, field);
}

function successfulEvalCode(result: Parameters<typeof finalMessageHasAll>[0]): string {
  return getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
}

function requireCreatePanelEvidence(result: Parameters<typeof finalMessageHasAll>[0]) {
  const code = successfulEvalCode(result);
  const required: Array<[label: string, pattern: RegExp]> = [
    ["openPanel", /\bopenPanel\s*\(/u],
    [".cdp.page()", /\.cdp\.page\s*\(/u],
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(code)).map(([label]) => label);
  if (!/(?:\.cdp\.consoleHistory|\.diagnose)\s*\(/u.test(code)) {
    missing.push("host console history via .diagnose() or .cdp.consoleHistory()");
  }
  if (missing.length > 0) {
    return {
      passed: false,
      reason: `Successful eval did not exercise ${missing.join(", ")}`,
    };
  }
  if (!/\.screenshot\s*\(/.test(code)) {
    return { passed: false, reason: "Successful eval did not capture a screenshot" };
  }
  return { passed: true };
}

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Open a new panel",
    category: "panels",
    authorityPolicy: {
      authority: [
        {
          ruleId: "inspect-created-panel",
          capability: { kind: "exact", key: "panel.inspect" },
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Open the base chat panel as a child, make sure it is really running by inspecting its screenshot and console, and evaluate a small JavaScript expression in it. Clean up anything temporary you had to create.",
    validate: (result) => {
      const base = checkedWithField(result, ["PANEL_OPEN_OK"], "handle");
      return base.passed ? requireCreatePanelEvidence(result) : base;
    },
  },
  {
    name: "browser-panel",
    description: "Create and navigate a browser panel",
    category: "panels",
    authorityPolicy: {
      authority: [
        {
          ruleId: "inspect-browser-panel",
          capability: { kind: "exact", key: "panel.inspect" },
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Open https://example.com/ in a browser panel, inspect it, then navigate that same panel to https://example.org/ and confirm the final page works. Clean up anything temporary you had to create.",
    validate: (result) =>
      checkedWithField(
        result,
        [
          "PANEL_BROWSER_OK",
          "PANEL_NAVIGATE_OK",
          "PANEL_SCREENSHOT_OK",
          "PANEL_EVAL_OK",
          "final-marker",
        ],
        "url"
      ),
  },
  {
    name: "panel-tree-navigation",
    description: "Walk the panel tree and navigate a child panel through the tree surface",
    category: "panels",
    authorityPolicy: {
      authority: [
        {
          ruleId: "inspect-tree-panel",
          capability: { kind: "exact", key: "panel.inspect" },
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Open https://example.com/ as a child browser panel, use the panel tree to find and navigate it to https://example.org/, then close it so nothing is left open.",
    validate: (result) => {
      const base = checkedWithNumericField(result, ["PANEL_TREE_OK", "closed"], "children");
      if (!base.passed) return base;
      return finalMessageHasField(result, "navigated");
    },
  },
  {
    name: "panel-list-sources",
    description: "List visible panel handles through the runtime panel API",
    category: "panels",
    prompt: "Which panels are available to open in this workspace?",
    validate: (result) => checkedWithNumericField(result, ["PANEL_SOURCES_OK"], "count"),
  },
];
