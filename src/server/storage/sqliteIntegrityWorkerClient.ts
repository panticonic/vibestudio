import { resolveHostWorkerEntry } from "../hostWorkerEntry.js";
import { Worker } from "node:worker_threads";

declare global {
  var __VIBESTUDIO_SQLITE_INTEGRITY_WORKER_ENTRY__: string | undefined;
}

export function resolveSqliteIntegrityWorkerEntry(): string {
  return resolveHostWorkerEntry(
    globalThis.__VIBESTUDIO_SQLITE_INTEGRITY_WORKER_ENTRY__ ?? "sqlite-integrity-worker.mjs"
  );
}

/** Runs whole-database verification outside the workspace-server thread. */
export class SqliteIntegrityWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>();

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
    const worker = new Worker(resolveSqliteIntegrityWorkerEntry());
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
