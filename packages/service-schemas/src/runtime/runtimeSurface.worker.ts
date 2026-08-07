import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import { namespaceEntry, valueEntry } from "@vibestudio/shared/runtimeSurface";
import {
  coreRuntimeSurface,
  CREATE_PANEL_SLOT_SIGNATURE,
  OPEN_PANEL_SIGNATURE,
  PANEL_HANDLE_AUTOMATION_GUIDE,
  PANEL_TREE_MEMBERS,
  PANEL_TREE_METHOD_CATALOG,
  WORKSPACE_MEMBERS,
} from "./runtimeSurface.core.js";

const panelTreeDescription =
  "Runtime property, not workspace.panelTree. self/get are synchronous handle factories. rootGroups() returns a page object with groups; page(...) returns a page object with entries; search(...) returns a page object with hits, each containing entry.node and entry.handle. Traversal reads are bounded. Handle navigate/navigateHistory/focus/reload/rebuild return a boot-ready PanelObservation; observe is the sole live status read.";

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
    createPanelSlot: valueEntry(
      "Commit a panel and promptly return its durable handle without focusing while build and boot continue in the background. Pass operationId for retry-stable identity; use handle.observe() when readiness matters.",
      CREATE_PANEL_SLOT_SIGNATURE
    ),
    openPanel: valueEntry(
      'Create a panel and return its handle after the exact attempt is application boot-ready, with no fixed readiness deadline. Pass options.signal for caller-owned cancellation and operationId for retry-stable identity. It defaults under the caller and focused; use parentId:null for a root or focus:false to suppress presentation. options.placement accepts "side" (default), "replace", or "split-below". ' +
        PANEL_HANDLE_AUTOMATION_GUIDE,
      OPEN_PANEL_SIGNATURE
    ),
    getPanelHandle: valueEntry("Alias for runtime.panelTree.get(id, kind?)."),
    panelTree: namespaceEntry(
      PANEL_TREE_MEMBERS,
      panelTreeDescription,
      undefined,
      PANEL_TREE_METHOD_CATALOG
    ),
    // Worker-only target extras.
    handleRpcPost: valueEntry(),
    destroy: valueEntry(),
  },
};
