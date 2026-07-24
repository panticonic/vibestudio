import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import { namespaceEntry, valueEntry } from "@vibestudio/shared/runtimeSurface";
import {
  coreRuntimeSurface,
  PANEL_TREE_MEMBERS,
  WORKSPACE_MEMBERS,
} from "./runtimeSurface.core.js";

const panelTreeDescription =
  "Runtime property, not workspace.panelTree. self/get are synchronous handle factories. navigate/focus/reload/rebuild return a boot-ready PanelObservation; observe is the sole live status read. Use list/roots/children/get for existing panels and openPanel to create.";

export const workerRuntimeSurface: RuntimeSurface = {
  target: "workerRuntime",
  description: "Properties available on the object returned by createWorkerRuntime(env).",
  exports: {
    ...coreRuntimeSurface,
    // Entries whose description is worker-specific (member arrays shared with core).
    workspace: namespaceEntry(
      WORKSPACE_MEMBERS,
      "Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles.",
      "workspace"
    ),
    openPanel: valueEntry(
      'Open a workspace or browser panel and return a PanelHandle only after the exact attempt is application boot-ready; throws structured PanelOperationError on failure. options.placement accepts disposition "side" (default), "replace", or "split-below", plus preferredWidth/minWidth.'
    ),
    listPanels: valueEntry("Alias for runtime.panelTree.list()."),
    getPanelHandle: valueEntry("Alias for runtime.panelTree.get(id, kind?)."),
    panelTree: namespaceEntry(PANEL_TREE_MEMBERS, panelTreeDescription),
    // Worker-only target extras.
    handleRpcPost: valueEntry(),
    destroy: valueEntry(),
  },
};
