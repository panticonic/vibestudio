import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Open a new panel",
    category: "panels",
    prompt: "Exercise opening a workspace panel. Finish with PANEL_OPEN_OK and handle.",
    validate: (result) => checked(result, ["PANEL_OPEN_OK", "handle"]),
  },
  {
    name: "browser-panel",
    description: "Create a browser panel pointing to a URL",
    category: "panels",
    prompt: "Exercise opening a browser panel. Finish with PANEL_BROWSER_OK and url.",
    validate: (result) => checked(result, ["PANEL_BROWSER_OK", "url"]),
  },
  {
    name: "browser-navigate",
    description: "Navigate a browser panel to a new URL",
    category: "panels",
    prompt: "Exercise browser panel navigation. Finish with PANEL_NAVIGATE_OK and final-marker.",
    validate: (result) => checked(result, ["PANEL_NAVIGATE_OK", "final-marker"]),
  },
  {
    name: "browser-screenshot",
    description: "Take a screenshot of a browser panel",
    category: "panels",
    prompt: "Exercise browser panel screenshot capture. Finish with PANEL_SCREENSHOT_OK and bytes.",
    validate: (result) => checked(result, ["PANEL_SCREENSHOT_OK", "bytes"]),
  },
  {
    name: "browser-evaluate",
    description: "Evaluate JavaScript in a browser panel",
    category: "panels",
    prompt: "Exercise evaluating JavaScript in a browser panel. Finish with PANEL_EVALUATE_OK and marker-match.",
    validate: (result) => checked(result, ["PANEL_EVALUATE_OK", "marker-match"]),
  },
  {
    name: "panel-list-sources",
    description: "List available panel sources from the build system",
    category: "panels",
    prompt: "Exercise listing panel sources. Finish with PANEL_SOURCES_OK and count.",
    validate: (result) => checked(result, ["PANEL_SOURCES_OK", "count"]),
  },
];
