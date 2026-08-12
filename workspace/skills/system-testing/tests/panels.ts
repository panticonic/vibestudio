import type { TestCase } from "../types.js";
import { validateAgentCompletionReport } from "../test-runner.js";
import { panelControlAuthorityPolicy, PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import {
  orchestratePanelGoal,
  orchestrateSeededPanelGoal,
  type SeededPanelGoalEvidence,
} from "./_panel-tree-invariant.js";

const CREATE_PANEL_PROMPT =
  "Please inspect the base chat interface itself and tell me its exact visible heading or interface label. Also check whether its console is clean and confirm that a small JavaScript expression runs in that interface.";

const BROWSER_PANEL_PROMPT =
  "Compare the visible heading on https://example.com/ with what you see after moving the same browser view to https://example.org/. Base the comparison on the rendered pages, and tell me where that view ends up.";

const PANEL_TREE_NAVIGATION_PROMPT =
  "I lost track of that browser view in the panel tree. Compare https://example.com/ with https://example.org/ there, then tell me where the investigation lived and which destination it ended on.";

const BROWSER_IMPORT_PROMPT =
  "Check the Browser Import inspector itself and tell me its exact panel identity, source, and lifecycle phase once it is usable.";

function validateSeededPanelNavigation(result: Parameters<TestCase["validate"]>[0]) {
  const evidence = result.diagnostics?.["seededPanelGoal"] as
    | Partial<SeededPanelGoalEvidence>
    | undefined;
  return evidence?.initialSource === "https://example.com/" &&
    evidence.initialPhase === "ready" &&
    evidence.finalSource === "https://example.org/" &&
    evidence.finalPhase === "ready" &&
    evidence.targetPreserved === true &&
    evidence.reachedExpectedSource === true &&
    evidence.initialPathIds?.includes(evidence.panelId ?? "") &&
    evidence.finalPathIds?.includes(evidence.panelId ?? "")
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The harness did not observe the same pre-existing panel-tree target navigate from example.com to example.org",
      };
}

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Inspect the base chat through a temporary panel",
    category: "panels",
    authorityPolicy: panelControlAuthorityPolicy("inspect-created-panel"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: CREATE_PANEL_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(context, CREATE_PANEL_PROMPT, "inspect the base chat interface"),
    validate: validateAgentCompletionReport,
  },
  {
    name: "browser-panel",
    description: "Inspect and navigate one temporary browser panel",
    category: "panels",
    authorityPolicy: panelControlAuthorityPolicy("inspect-browser-panel"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: BROWSER_PANEL_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(context, BROWSER_PANEL_PROMPT, "compare two rendered web pages"),
    validate: validateAgentCompletionReport,
  },
  {
    name: "panel-tree-navigation",
    description: "Resolve a vague browser-view reference through the panel tree",
    category: "panels",
    validation: "agent-evidence",
    authorityPolicy: panelControlAuthorityPolicy("inspect-tree-panel"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: PANEL_TREE_NAVIGATION_PROMPT,
    orchestrate: (context) =>
      orchestrateSeededPanelGoal(
        context,
        PANEL_TREE_NAVIGATION_PROMPT,
        "locate and navigate the browser investigation",
        "https://example.com/",
        "https://example.org/"
      ),
    validate: validateSeededPanelNavigation,
  },
  {
    name: "panel-list-sources",
    description: "List visible panel handles through the runtime panel API",
    category: "panels",
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: "Which panels are available to open in this workspace?",
    validate: validateAgentCompletionReport,
  },
  {
    name: "browser-import-panel-lifecycle",
    description: "Inspect the first-party Browser Import panel through its real lifecycle",
    category: "panels",
    authorityPolicy: panelControlAuthorityPolicy("inspect-browser-import-panel"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: BROWSER_IMPORT_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(context, BROWSER_IMPORT_PROMPT, "inspect the Browser Import lifecycle"),
    validate: validateAgentCompletionReport,
  },
];
