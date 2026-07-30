import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import { namespaceEntry, valueEntry } from "@vibestudio/shared/runtimeSurface";
import {
  coreRuntimeSurface,
  OPEN_PANEL_SIGNATURE,
  PANEL_HANDLE_AUTOMATION_GUIDE,
  PANEL_TREE_MEMBERS,
  WORKSPACE_MEMBERS,
} from "./runtimeSurface.core.js";

const panelTreeDescription =
  "Top-level export, not workspace.panelTree. self/get are synchronous handle factories. page({ group: { kind: 'children', parentSlotId } }) returns { entries }; search({ query }) returns { hits }, each with entry.node and entry.handle. Traversal reads are bounded. Handle navigate/focus/reload/rebuild return a boot-ready PanelObservation; observe is the sole live status read.";

// Panel-only affordances, grouped under one `panel` namespace (was ~16 flat
// top-level exports). Identity/introspection/theme/focus/lifecycle + stateArgs.
const PANEL_MEMBERS = [
  "entityId",
  "slotId",
  "parentId",
  "env",
  "setTitle",
  "getInfo",
  "focusPanel",
  "getTheme",
  "onThemeChange",
  "onFocus",
  "onConnectionError",
  "onChildCreated",
  "reopen",
  "stateArgs",
];

export const panelRuntimeSurface: RuntimeSurface = {
  target: "panel",
  description: "Top-level value exports available from @workspace/runtime in panel eval contexts.",
  exports: {
    ...coreRuntimeSurface,
    // Entries whose description is panel-specific (member arrays shared with core).
    workspace: namespaceEntry(
      WORKSPACE_MEMBERS,
      "Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles.",
      "workspace"
    ),
    openPanel: valueEntry(
      'Create a panel and return its handle after the exact attempt is application boot-ready. It defaults under the caller and focused; use parentId:null for a root or focus:false for background creation. The slot commits before readiness, so on PanelOperationError inspect failure.provenance.panelId instead of blindly retrying. options.placement accepts "side" (default), "replace", or "split-below". ' +
        PANEL_HANDLE_AUTOMATION_GUIDE,
      OPEN_PANEL_SIGNATURE
    ),
    getPanelHandle: valueEntry(),
    panelTree: namespaceEntry(PANEL_TREE_MEMBERS, panelTreeDescription),
    // Portable authoring helpers (also on worker + eval — pure, target-independent).
    Rpc: valueEntry("RPC helpers namespace export."),
    z: valueEntry("Zod export."),
    defineContract: valueEntry(),
    buildPanelLink: valueEntry(
      "Build a managed panel URL; options.disposition controls tree placement and options.placement supplies visual side/replace/split-below hints."
    ),
    buildPanelDeepLink: valueEntry(
      "Build a canonical panel deep link with optional tree disposition and visual placement hints."
    ),
    buildPanelShareLink: valueEntry(
      "Build a canonical panel share link with optional tree disposition and visual placement hints."
    ),
    parseContextId: valueEntry(),
    isValidContextId: valueEntry(),
    getInstanceId: valueEntry(),
    normalizePath: valueEntry(),
    getFileName: valueEntry(),
    resolvePath: valueEntry(),
    createGatewayFetch: valueEntry(
      "Create a gateway-authenticated fetch helper from an explicit config."
    ),
    FORM_FILL_TYPES: valueEntry(
      "Canonical HTML autocomplete field vocabulary recognized by browser form fill."
    ),
    // Panel-only namespaces.
    panel: namespaceEntry(
      PANEL_MEMBERS,
      "Panel-only affordances: identity (entityId/slotId/parentId/env), semantic display title (setTitle(title, { explicit? })), introspection (getInfo/getTheme/onThemeChange/onFocus/onConnectionError), lifecycle (focusPanel/onChildCreated/reopen), and stateArgs (get/set/setForPanel)."
    ),
    journal: namespaceEntry(
      ["Journal", "with", "current"],
      "Panel operation journaling: journal.Journal (class), journal.with(journal, fn), journal.current()."
    ),
    agentApi: valueEntry(),
    adblock: namespaceEntry([
      "getStats",
      "isActive",
      "getStatsForPanel",
      "isEnabledForPanel",
      "setEnabledForPanel",
      "resetStatsForPanel",
      "getPanelUrl",
      "addToWhitelist",
      "removeFromWhitelist",
    ]),
  },
};
