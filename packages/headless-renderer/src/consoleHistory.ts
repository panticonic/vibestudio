/**
 * Per-panel console + lifecycle history with bounded ring buffers, matching
 * the Electron CdpHostProvider semantics (hosts/desktop/main/cdpHostProvider.ts): 1000
 * entries / 500 errors, dropped counters, level filtering, and host-recorded
 * lifecycle records (crashes, failed loads) marked source:"lifecycle".
 */

import {
  queryPanelConsoleHistory,
  type PanelConsoleHistoryEntry as ConsoleHistoryEntry,
  type PanelConsoleHistoryResult as ConsoleHistoryResult,
  type PanelConsoleHistoryOptions as ConsoleHistoryOptions,
  type PanelConsoleHistoryLevel as ConsoleLevel,
} from "@vibestudio/shared/panel/consoleHistory";
export type { ConsoleHistoryEntry, ConsoleHistoryResult, ConsoleHistoryOptions, ConsoleLevel };

const ENTRY_CAPACITY = 1_000;
const ERROR_CAPACITY = 500;

class PanelHistory {
  nextSeq = 1;
  entries: ConsoleHistoryEntry[] = [];
  errors: ConsoleHistoryEntry[] = [];
  droppedEntries = 0;
  droppedErrors = 0;
}

export class ConsoleHistoryStore {
  private readonly panels = new Map<string, PanelHistory>();

  record(slotId: string, entry: ConsoleHistoryEntry): void {
    const history = this.panels.get(slotId) ?? new PanelHistory();
    this.panels.set(slotId, history);
    const recorded = { ...entry, seq: history.nextSeq++ };
    history.entries.push(recorded);
    while (history.entries.length > ENTRY_CAPACITY) {
      history.entries.shift();
      history.droppedEntries += 1;
    }
    if (entry.level === "error") {
      history.errors.push(recorded);
      while (history.errors.length > ERROR_CAPACITY) {
        history.errors.shift();
        history.droppedErrors += 1;
      }
    }
  }

  recordLifecycle(slotId: string, message: string, fields?: Record<string, unknown>): void {
    this.record(slotId, {
      timestamp: Date.now(),
      level: "error",
      message,
      line: 0,
      sourceId: "lifecycle",
      url: "",
      source: "lifecycle",
      fields,
    });
  }

  query(slotId: string, options: ConsoleHistoryOptions = {}): ConsoleHistoryResult {
    const history = this.panels.get(slotId) ?? new PanelHistory();
    return queryPanelConsoleHistory(
      {
        entries: history.entries,
        errors: history.errors,
        dropped: { entries: history.droppedEntries, errors: history.droppedErrors },
        capacity: { entries: ENTRY_CAPACITY, errors: ERROR_CAPACITY },
      },
      options
    );
  }

  clear(slotId: string): void {
    this.panels.delete(slotId);
  }
}

/** Map a CDP Runtime.consoleAPICalled type to our level vocabulary. */
export function levelFromConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case "debug":
      return "debug";
    case "warning":
      return "warning";
    case "error":
    case "assert":
      return "error";
    case "log":
    case "info":
      return "info";
    default:
      return "unknown";
  }
}
