import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomicSync } from "../../atomicFile.js";

const MAX_TERMINAL_RECEIPTS = 32;

export type BrowserSensitiveImportDataType = "cookies" | "passwords" | "formFill";
export interface SensitiveBrowserImportInput {
  sourceId: string;
  dataTypes: BrowserSensitiveImportDataType[];
}
export interface SensitiveBrowserImportCount {
  dataType: BrowserSensitiveImportDataType;
  read: number;
  stored: number;
  skipped: number;
  errors: number;
}
export interface SensitiveBrowserImportStatus {
  operationId: string;
  state: "running" | "complete" | "cancelled" | "failed";
  counts: SensitiveBrowserImportCount[];
  error?: string;
}

const SensitiveDataTypeSchema = z.enum(["cookies", "passwords", "formFill"]);
const CountSchema = z
  .object({
    dataType: SensitiveDataTypeSchema,
    read: z.number().int().nonnegative(),
    stored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();
const StatusSchema = z
  .object({
    operationId: z.string().min(1),
    state: z.enum(["running", "complete", "cancelled", "failed"]),
    counts: z.array(CountSchema),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((status, ctx) => {
    if ((status.state === "failed") !== (status.error !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Only failed imports contain an error" });
    }
  });
const InputSchema = z
  .object({
    sourceId: z.string().min(1),
    dataTypes: z.array(SensitiveDataTypeSchema).min(1).max(3),
  })
  .strict();
const RecordSchema = z
  .object({
    operationId: z.string().min(1),
    input: InputSchema,
    status: StatusSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.status.operationId !== record.operationId) {
      ctx.addIssue({ code: "custom", message: "Sensitive-import status identity mismatch" });
    }
    if (
      record.status.counts.length !== record.input.dataTypes.length ||
      record.input.dataTypes.some(
        (dataType) => !record.status.counts.some((count) => count.dataType === dataType)
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Sensitive-import status category mismatch" });
    }
  });
const LedgerSchema = z
  .object({
    format: z.literal("vibestudio-sensitive-browser-import-ledger/1"),
    records: z.array(RecordSchema),
  })
  .strict();

interface LedgerRecord {
  operationId: string;
  input: SensitiveBrowserImportInput;
  status: SensitiveBrowserImportStatus;
  updatedAt: number;
}

/** Durable instance-scoped identity, progress, cancellation, and receipt ledger. */
export class SensitiveBrowserImportLedger {
  private readonly records = new Map<string, LedgerRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  begin(operationId: string, input: SensitiveBrowserImportInput): SensitiveBrowserImportStatus {
    const existing = this.records.get(operationId);
    if (existing) {
      this.assertSameInput(existing, input);
      return cloneStatus(existing.status);
    }
    const status: SensitiveBrowserImportStatus = {
      operationId,
      state: "running",
      counts: input.dataTypes.map((dataType) => zeroCount(dataType)),
    };
    this.records.set(operationId, {
      operationId,
      input: cloneInput(input),
      status,
      updatedAt: Date.now(),
    });
    this.persist();
    return cloneStatus(status);
  }

  observe(operationId: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    return cloneStatus(record.status);
  }

  running(): Array<{ operationId: string; input: SensitiveBrowserImportInput }> {
    return [...this.records.values()]
      .filter((record) => record.status.state === "running")
      .map((record) => ({ operationId: record.operationId, input: cloneInput(record.input) }));
  }

  progress(
    operationId: string,
    input: SensitiveBrowserImportInput,
    count: SensitiveBrowserImportCount
  ): SensitiveBrowserImportStatus {
    const record = this.requireRunning(operationId, input);
    const index = record.status.counts.findIndex((entry) => entry.dataType === count.dataType);
    if (index < 0) throw new Error(`Unexpected sensitive import category: ${count.dataType}`);
    record.status.counts[index] = { ...count };
    record.updatedAt = Date.now();
    this.persist();
    return cloneStatus(record.status);
  }

  complete(
    operationId: string,
    input: SensitiveBrowserImportInput,
    counts: SensitiveBrowserImportCount[]
  ): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    this.assertSameInput(record, input);
    if (record.status.state !== "running") return cloneStatus(record.status);
    assertExactCounts(input, counts);
    record.status = {
      operationId,
      state: "complete",
      counts: counts.map((count) => ({ ...count })),
    };
    record.updatedAt = Date.now();
    this.pruneTerminalReceipts();
    this.persist();
    return cloneStatus(record.status);
  }

  cancel(operationId: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    if (record.status.state !== "running") return cloneStatus(record.status);
    record.status = { ...record.status, state: "cancelled" };
    record.updatedAt = Date.now();
    this.pruneTerminalReceipts();
    this.persist();
    return cloneStatus(record.status);
  }

  fail(operationId: string, error: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    if (record.status.state !== "running") return cloneStatus(record.status);
    record.status = { ...record.status, state: "failed", error };
    record.updatedAt = Date.now();
    this.pruneTerminalReceipts();
    this.persist();
    return cloneStatus(record.status);
  }

  private require(operationId: string): LedgerRecord {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`Sensitive browser import operation not found: ${operationId}`);
    return record;
  }

  private requireRunning(operationId: string, input: SensitiveBrowserImportInput): LedgerRecord {
    const record = this.require(operationId);
    this.assertSameInput(record, input);
    if (record.status.state !== "running") {
      throw new Error(
        `Sensitive browser import operation is ${record.status.state}: ${operationId}`
      );
    }
    return record;
  }

  private assertSameInput(record: LedgerRecord, input: SensitiveBrowserImportInput): void {
    if (
      record.input.sourceId !== input.sourceId ||
      record.input.dataTypes.length !== input.dataTypes.length ||
      record.input.dataTypes.some((dataType, index) => dataType !== input.dataTypes[index])
    ) {
      throw new Error(
        `Sensitive browser import operation ${record.operationId} has different inputs`
      );
    }
  }

  private pruneTerminalReceipts(): void {
    const terminal = [...this.records.values()]
      .filter((record) => record.status.state !== "running")
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const record of terminal.slice(MAX_TERMINAL_RECEIPTS)) {
      this.records.delete(record.operationId);
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = LedgerSchema.parse(JSON.parse(raw));
    for (const record of parsed.records) {
      if (this.records.has(record.operationId)) {
        throw new Error(`Duplicate sensitive browser import operation: ${record.operationId}`);
      }
      this.records.set(record.operationId, {
        operationId: record.operationId,
        input: cloneInput(record.input),
        status: cloneStatus(record.status),
        updatedAt: record.updatedAt,
      });
    }
  }

  private persist(): void {
    writeFileAtomicSync(
      this.filePath,
      `${JSON.stringify(
        {
          format: "vibestudio-sensitive-browser-import-ledger/1",
          records: [...this.records.values()],
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }
}

function assertExactCounts(
  input: SensitiveBrowserImportInput,
  counts: SensitiveBrowserImportCount[]
): void {
  if (
    counts.length !== input.dataTypes.length ||
    new Set(counts.map((count) => count.dataType)).size !== input.dataTypes.length ||
    input.dataTypes.some((dataType) => !counts.some((count) => count.dataType === dataType))
  ) {
    throw new Error("Sensitive browser import status does not cover every requested category");
  }
}

function zeroCount(dataType: BrowserSensitiveImportDataType): SensitiveBrowserImportCount {
  return { dataType, read: 0, stored: 0, skipped: 0, errors: 0 };
}

function cloneInput(input: SensitiveBrowserImportInput): SensitiveBrowserImportInput {
  return { sourceId: input.sourceId, dataTypes: [...input.dataTypes] };
}

function cloneStatus(status: SensitiveBrowserImportStatus): SensitiveBrowserImportStatus {
  return {
    operationId: status.operationId,
    state: status.state,
    counts: status.counts.map((count) => ({ ...count })),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}
