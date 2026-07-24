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
    ["consoleHistory", /\.consoleHistory\s*\(/u],
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(code)).map(([label]) => label);
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
    prompt:
      "Exercise opening a spectrolite panel as a child panel using the documented @workspace/runtime panel APIs only. Do not inspect guessed internal source paths. Get a screenshot, retrieve host-captured console logs from the running panel, and run JavaScript in the child panel through handle.cdp.page(). Finish with PANEL_OPEN_OK and handle=<panel-id>.",
    validate: (result) => {
      const base = checkedWithField(result, ["PANEL_OPEN_OK"], "handle");
      return base.passed ? requireCreatePanelEvidence(result) : base;
    },
  },
  {
    name: "browser-panel",
    description: "Create and navigate a browser panel",
    category: "panels",
    prompt:
      "Exercise opening a browser panel for https://example.com/ using openPanel(), then navigate that same browser panel to https://example.org/ with the documented CDP automation API. Reuse the same handle and page; do not open replacement panels or inspect guessed internal source paths. Take a screenshot and run JavaScript in the browser panel. Finish with PANEL_BROWSER_OK, PANEL_NAVIGATE_OK, PANEL_SCREENSHOT_OK, PANEL_EVAL_OK, url=<current-url>, and final-marker.",
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
    prompt:
      "Open a child browser panel for https://example.com/, then explore the panel tree around yourself: identify your own node, confirm the child appears among your children, navigate the child to https://example.org/ through the tree surface, and close it afterward so nothing is left open. Finish with PANEL_TREE_OK, children=<count>, navigated=<final-url>, and closed.",
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
    prompt:
      "Exercise listing currently available panels via the documented runtime panel APIs. Finish with PANEL_SOURCES_OK and count=<number>.",
    validate: (result) => checkedWithNumericField(result, ["PANEL_SOURCES_OK"], "count"),
  },
];
