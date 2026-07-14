/**
 * panelLog — forwards panel console warnings/errors and lifecycle events
 * (renderer crashes, load failures) from the Electron shell to the server's
 * runtime-diagnostics store.
 *
 * Why: panel webContents live in the Electron main process, so their console
 * output and crash events are invisible to the server by default. Workspace
 * agents query unit health through `workspace.units.diagnostics` /
 * `workspace.units.logs`, which read the server-side store — without this
 * bridge, panel failures never show up there.
 *
 * The shell batches records and fires `panelLog.append` best-effort; only
 * warn/error console output and lifecycle events are forwarded (full console
 * history stays queryable per-panel via the CDP host).
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { panelLogMethods, type PanelLogRecord } from "@vibestudio/service-schemas/panelLog";

export type { PanelLogRecord } from "@vibestudio/service-schemas/panelLog";

export interface PanelLogServiceDeps {
  onRecords: (records: PanelLogRecord[]) => void;
}

export function createPanelLogService(deps: PanelLogServiceDeps): ServiceDefinition {
  return {
    name: "panelLog",
    description: "Forward panel console errors and lifecycle events into unit diagnostics",
    authority: { principals: ["user", "host"] },
    methods: panelLogMethods,
    handler: defineServiceHandler("panelLog", panelLogMethods, {
      append: (_ctx, [records]) => {
        if (records.length > 0) deps.onRecords(records);
        return undefined;
      },
    }),
  };
}
