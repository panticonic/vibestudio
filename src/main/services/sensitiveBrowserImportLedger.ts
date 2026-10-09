import { randomUUID } from "node:crypto";
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
/** The durable status; callers observe it with its opaque change version. */
interface DurableSensitiveImportStatus {
  operationId: string;
  state: "running" | "applying" | "application_failed" | "complete" | "cancelled" | "failed";
  counts: SensitiveBrowserImportCount[];
  error?: string;
}
export interface SensitiveBrowserImportStatus extends DurableSensitiveImportStatus {
  /** Opaque change version, scoped to this ledger instance. */
  version: string;
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
    state: z.enum(["running", "applying", "application_failed", "complete", "cancelled", "failed"]),
    counts: z.array(CountSchema),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (["failed", "application_failed"].includes(status.state) !== (status.error !== undefined)) {
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
  status: DurableSensitiveImportStatus;
  updatedAt: number;
  /** In-memory change counter; versions are scoped to this ledger instance. */
  revision: number;
}

const WAITABLE_STATES: ReadonlySet<DurableSensitiveImportStatus["state"]> = new Set([
  "running",
  "applying",
]);

/** Durable instance-scoped identity, progress, cancellation, and receipt ledger. */
export class SensitiveBrowserImportLedger {
  private readonly records = new Map<string, LedgerRecord>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly epoch = randomUUID();
  private revision = 0;

  constructor(private readonly filePath: string) {
    this.load();
  }

  begin(operationId: string, input: SensitiveBrowserImportInput): SensitiveBrowserImportStatus {
    const existing = this.records.get(operationId);
    if (existing) {
      this.assertSameInput(existing, input);
      return this.observed(existing);
    }
    const status: DurableSensitiveImportStatus = {
      operationId,
      state: "running",
      counts: input.dataTypes.map((dataType) => zeroCount(dataType)),
    };
    const record: LedgerRecord = {
      operationId,
      input: cloneInput(input),
      status,
      updatedAt: Date.now(),
      revision: ++this.revision,
    };
    this.records.set(operationId, record);
    this.persist();
    return this.observed(record);
  }

  observe(operationId: string): SensitiveBrowserImportStatus {
    return this.observed(this.require(operationId));
  }

  /**
   * Resolve on the operation's next status change when the caller already
   * holds the current version of a running or applying import. Any other state
   * or version answers immediately. Waits end with the change itself, the
   * caller's abort signal, or {@link releaseWaiters} when the owning host stops.
   */
  observeAfter(
    operationId: string,
    afterVersion: string,
    signal?: AbortSignal
  ): Promise<SensitiveBrowserImportStatus> {
    const record = this.require(operationId);
    const current = this.observed(record);
    if (current.version !== afterVersion || !WAITABLE_STATES.has(record.status.state)) {
      return Promise.resolve(current);
    }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(operationId) ?? new Set<Waiter>();
      this.waiters.set(operationId, waiters);
      const onAbort = () => settle(() => reject(signal!.reason));
      const settle = (finish: () => void) => {
        waiters.delete(waiter);
        if (waiters.size === 0 && this.waiters.get(operationId) === waiters) {
          this.waiters.delete(operationId);
        }
        signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const waiter: Waiter = {
        changed: (status) => settle(() => resolve(status)),
        released: (error) => settle(() => reject(error)),
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Reject every pending wait; the owning host is stopping. */
  releaseWaiters(error: Error): void {
    for (const waiters of [...this.waiters.values()]) {
      for (const waiter of [...waiters]) waiter.released(error);
    }
  }

  running(): Array<{ operationId: string; input: SensitiveBrowserImportInput }> {
    return [...this.records.values()]
      .filter((record) =>
        ["running", "applying", "application_failed"].includes(record.status.state)
      )
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
    return this.commit(record);
  }

  complete(
    operationId: string,
    input: SensitiveBrowserImportInput,
    counts: SensitiveBrowserImportCount[]
  ): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    this.assertSameInput(record, input);
    if (!["running", "applying"].includes(record.status.state)) return this.observed(record);
    assertExactCounts(input, counts);
    record.status = {
      operationId,
      state: "complete",
      counts: counts.map((count) => ({ ...count })),
    };
    return this.commit(record);
  }

  applying(
    operationId: string,
    input: SensitiveBrowserImportInput,
    counts: SensitiveBrowserImportCount[]
  ): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    this.assertSameInput(record, input);
    if (!["running", "applying", "application_failed"].includes(record.status.state))
      return this.observed(record);
    assertExactCounts(input, counts);
    record.status = {
      operationId,
      state: "applying",
      counts: counts.map((count) => ({ ...count })),
    };
    return this.commit(record);
  }

  applicationFailed(operationId: string, error: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    if (record.status.state !== "applying") return this.observed(record);
    record.status = { ...record.status, state: "application_failed", error };
    return this.commit(record);
  }

  cancel(operationId: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    if (!["running", "applying", "application_failed"].includes(record.status.state))
      return this.observed(record);
    const { error: _error, ...status } = record.status;
    record.status = { ...status, state: "cancelled" };
    return this.commit(record);
  }

  fail(operationId: string, error: string): SensitiveBrowserImportStatus {
    const record = this.require(operationId);
    if (record.status.state !== "running") return this.observed(record);
    record.status = { ...record.status, state: "failed", error };
    return this.commit(record);
  }

  private commit(record: LedgerRecord): SensitiveBrowserImportStatus {
    record.updatedAt = Date.now();
    record.revision = ++this.revision;
    this.pruneTerminalReceipts();
    this.persist();
    const status = this.observed(record);
    for (const waiter of [...(this.waiters.get(record.operationId) ?? [])]) {
      waiter.changed(this.observed(record));
    }
    return status;
  }

  private observed(record: LedgerRecord): SensitiveBrowserImportStatus {
    return { ...cloneStatus(record.status), version: `${this.epoch}:${record.revision}` };
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
      .filter(
        (record) => !["running", "applying", "application_failed"].includes(record.status.state)
      )
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
        revision: ++this.revision,
      });
    }
  }

  private persist(): void {
    writeFileAtomicSync(
      this.filePath,
      `${JSON.stringify(
        {
          format: "vibestudio-sensitive-browser-import-ledger/1",
          records: [...this.records.values()].map((record) => ({
            operationId: record.operationId,
            input: record.input,
            status: record.status,
            updatedAt: record.updatedAt,
          })),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }
}

interface Waiter {
  changed(status: SensitiveBrowserImportStatus): void;
  released(error: Error): void;
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

function cloneStatus(status: DurableSensitiveImportStatus): DurableSensitiveImportStatus {
  return {
    operationId: status.operationId,
    state: status.state,
    counts: status.counts.map((count) => ({ ...count })),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}
