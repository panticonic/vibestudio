import type {
  RuntimeSupervisionEntityKey,
  RuntimeSupervisionLogRecord,
} from "@vibestudio/service-schemas/runtime";
import type {
  RuntimeDiagnosticHistory,
  RuntimeDiagnosticRecord,
} from "../runtimeDiagnosticsStore.js";

export function runtimeDiagnosticRecord(
  identity: RuntimeSupervisionEntityKey,
  entry: RuntimeDiagnosticRecord
): RuntimeSupervisionLogRecord {
  return {
    identity,
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    ...(entry.fields ? { fields: entry.fields } : {}),
    source: entry.source === "ctx.log" ? "structured" : entry.source,
    ...(entry.seq === undefined ? {} : { seq: entry.seq }),
  };
}

export function runtimeDiagnosticHistory(
  identity: RuntimeSupervisionEntityKey,
  history: RuntimeDiagnosticHistory
): {
  logs: RuntimeSupervisionLogRecord[];
  errors: RuntimeSupervisionLogRecord[];
  dropped: RuntimeDiagnosticHistory["dropped"];
  capacity: RuntimeDiagnosticHistory["capacity"];
} {
  return {
    logs: history.entries.map((entry) => runtimeDiagnosticRecord(identity, entry)),
    errors: history.errors.map((entry) => runtimeDiagnosticRecord(identity, entry)),
    dropped: history.dropped,
    capacity: history.capacity,
  };
}
