/**
 * Per-panel console + lifecycle history with bounded ring buffers, matching
 * the Electron CdpHostProvider semantics (hosts/desktop/main/cdpHostProvider.ts): 1000
 * entries / 500 errors, dropped counters, level filtering, and host-recorded
 * lifecycle records (crashes, failed loads) marked source:"lifecycle".
 */

import {
  filterConsoleHistoryEntries,
  pageConsoleHistory,
  type PanelConsoleHistoryOptions,
} from "@vibestudio/shared/panel/consoleHistory";
import type {
  PanelConsoleHistoryEntry,
  PanelConsoleHistoryResult,
  PanelConsoleHistoryLevel,
} from "@vibestudio/shared/panel/observation";

export type ConsoleLevel = PanelConsoleHistoryLevel;
export type ConsoleHistoryEntry = PanelConsoleHistoryEntry;
export type ConsoleHistoryResult = PanelConsoleHistoryResult;
export type ConsoleHistoryOptions = PanelConsoleHistoryOptions;

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
    const entries = filterConsoleHistoryEntries(history.entries, options);
    // Level selection must not hide separately retained failures.
    const errors = filterConsoleHistoryEntries(history.errors, { ...options, levels: undefined });
    return {
      ...pageConsoleHistory(entries, errors, options),
      dropped: { entries: history.droppedEntries, errors: history.droppedErrors },
      capacity: { entries: ENTRY_CAPACITY, errors: ERROR_CAPACITY },
    };
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
