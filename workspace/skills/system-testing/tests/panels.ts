import type { TestCase } from "../types.js";
import { validateAgentCompletionReport } from "../test-runner.js";
import { panelControlAuthorityPolicy, PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import { orchestratePanelGoal } from "./_panel-tree-invariant.js";

const CREATE_PANEL_PROMPT =
  "Please inspect the base chat interface itself and tell me its exact visible heading or interface label. Also check whether its console is clean and confirm that a small JavaScript expression runs in that interface.";

const BROWSER_PANEL_PROMPT =
  "Compare the visible heading on https://example.com/ with what you see after moving the same browser view to https://example.org/. Base the comparison on the rendered pages, and tell me where that view ends up.";

const PANEL_TREE_NAVIGATION_PROMPT =
  "I lose track of browser views in the panel tree. Use one browser view to compare https://example.com/ with https://example.org/, then tell me where the investigation lived in the tree and which destination it ended on.";

const BROWSER_IMPORT_PROMPT =
  "Check the Browser Import inspector itself and tell me its exact panel identity, source, and lifecycle phase once it is usable.";

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
    description: "Navigate a temporary browser panel with panel-tree awareness",
    category: "panels",
    authorityPolicy: panelControlAuthorityPolicy("inspect-tree-panel"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: PANEL_TREE_NAVIGATION_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(
        context,
        PANEL_TREE_NAVIGATION_PROMPT,
        "locate and navigate the browser investigation"
      ),
    validate: validateAgentCompletionReport,
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
      orchestratePanelGoal(
        context,
        BROWSER_IMPORT_PROMPT,
        "inspect the Browser Import lifecycle"
      ),
    validate: validateAgentCompletionReport,
  },
];
