import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

declare global {
  var __VIBESTUDIO_SQLITE_INTEGRITY_WORKER_ENTRY__: string | undefined;
}

const SOURCE_ENTRY = "src/server/storage/sqliteIntegrityWorkerBootstrap.mjs";

export function resolveSqliteIntegrityWorkerEntry(appRoot: string): string {
  const candidate = path.join(appRoot, SOURCE_ENTRY);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`SQLite integrity worker entry is missing at ${candidate}`);
}

function workerEntry(appRoot: string): string {
  const emitted = globalThis.__VIBESTUDIO_SQLITE_INTEGRITY_WORKER_ENTRY__;
  if (emitted) return path.resolve(path.dirname(process.argv[1]!), emitted);
  return resolveSqliteIntegrityWorkerEntry(appRoot);
}

/** Runs whole-database verification outside the workspace-server thread. */
export class SqliteIntegrityWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>();

  constructor(private readonly appRoot: string) {}

  verify(paths: string[], options: { readOnly?: boolean } = {}): Promise<void> {
    if (paths.length === 0) return Promise.resolve();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, paths, readOnly: options.readOnly ?? true });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerEntry(this.appRoot));
    worker.unref();
    worker.on(
      "message",
      (message: {
        id: number;
        result?: true;
        error?: { name?: string; message: string; stack?: string };
      }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message);
          error.name = message.error.name ?? "Error";
          error.stack = message.error.stack;
          pending.reject(error);
        } else {
          pending.resolve();
        }
      }
    );
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) =>
      fail(new Error(`SQLite integrity worker exited with code ${code}`))
    );
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const error = new Error("SQLite integrity worker closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
