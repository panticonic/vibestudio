import type { Suite } from "../run.js";
import { panelLifecycle } from "./panelLifecycle.js";
import { panelViewport } from "./panelViewport.js";
import { chatTranscript } from "./chatTranscript.js";
import { newsPanel } from "./newsPanel.js";

export { panelLifecycle, panelViewport, chatTranscript, newsPanel };

/** Deterministic suites owned by the bootable base workspace. */
export function allSuites(): Suite[] {
  return [panelLifecycle, panelViewport, chatTranscript, newsPanel];
}
