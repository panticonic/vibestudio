import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { getCentralDataPath } from "@vibestudio/env-paths";
export type MainProcessErrorRecord = {
  origin: string;
  timestamp: number;
  kind: "uncaughtException" | "unhandledRejection";
  message: string;
  stack?: string;
};
const observers = new Set<(record: MainProcessErrorRecord) => void>();
const bootRecords: MainProcessErrorRecord[] = [];
const ledgerPath = () => join(getCentralDataPath(), "main-diagnostics", "errors.json");
/** A private bounded diagnostic source, available before an account/workspace exists. It never sends reports. */
export function observeMainProcessErrors(
  observer: (record: MainProcessErrorRecord) => void
): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
export function recordMainProcessError(kind: MainProcessErrorRecord["kind"], error: unknown): void {
  const bounded = (text: string, budget: number) =>
    Buffer.from(text.slice(0, budget), "utf8")
      .subarray(0, budget - 4)
      .toString("utf8");
  const record: MainProcessErrorRecord = {
    origin: randomUUID(),
    timestamp: Date.now(),
    kind,
    message: bounded(error instanceof Error ? error.message : String(error), 4096),
    ...(error instanceof Error && error.stack ? { stack: bounded(error.stack, 12288) } : {}),
  };
  bootRecords.push(record);
  if (bootRecords.length > 100) bootRecords.shift();
  try {
    const retained = readRetainedMainProcessErrors().filter(
      (r) => r.timestamp > Date.now() - 14 * 86400000
    );
    retained.push(record);
    const destination = ledgerPath();
    mkdirSync(join(getCentralDataPath(), "main-diagnostics"), { recursive: true, mode: 0o700 });
    const temporary = destination + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(retained.slice(-100)), { flag: "wx", mode: 0o600 });
    try {
      const file = openSync(temporary, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    process.stderr.write("[main-diagnostics] Error persistence unavailable.\n");
  }
  for (const observer of observers)
    try {
      observer(structuredClone(record));
    } catch {
      /* Observers never affect exception handling. */
    }
}
/** Current-boot test/diagnostic view. Retained history is an explicit reporting selection. */
export function readMainProcessErrors(): MainProcessErrorRecord[] {
  return structuredClone(bootRecords);
}
export function readRetainedMainProcessErrors(): MainProcessErrorRecord[] {
  try {
    const file = openSync(ledgerPath(), "r");
    let raw: Buffer;
    try {
      if (fstatSync(file).size > 8 * 1024 * 1024) throw new Error("Diagnostic budget exceeded");
      raw = readFileSync(file);
    } finally {
      closeSync(file);
    }
    if (raw.byteLength > 8 * 1024 * 1024) throw new Error("Diagnostic budget exceeded");
    const records: unknown = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(records)) return [];
    return records
      .filter(
        (r): r is MainProcessErrorRecord =>
          r &&
          typeof r === "object" &&
          typeof r.origin === "string" &&
          typeof r.timestamp === "number" &&
          typeof r.message === "string" &&
          ["uncaughtException", "unhandledRejection"].includes(r.kind)
      )
      .slice(-100);
  } catch {
    return [];
  }
}
export function clearMainProcessErrors(): void {
  bootRecords.length = 0;
  rmSync(ledgerPath(), { force: true });
}
