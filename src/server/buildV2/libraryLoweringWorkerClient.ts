import { resolveHostWorkerEntry } from "../hostWorkerEntry.js";
import type { Worker } from "node:worker_threads";
import { createMeasuredWorker } from "../workerPerformance.js";

declare global {
  var __VIBESTUDIO_LIBRARY_LOWERING_WORKER_ENTRY__: string | undefined;
}

interface Pending {
  resolve(value: string): void;
  reject(error: Error): void;
}

export function resolveLibraryLoweringWorkerEntry(): string {
  return resolveHostWorkerEntry(
    globalThis.__VIBESTUDIO_LIBRARY_LOWERING_WORKER_ENTRY__ ?? "library-lowering-worker.mjs"
  );
}

/** Keeps Babel's CPU-heavy library lowering off the workspace server event loop. */
export class LibraryLoweringWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  lower(source: string): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, source });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createMeasuredWorker("libraryLowering", resolveLibraryLoweringWorkerEntry());
    worker.unref();
    worker.on(
      "message",
      (message: {
        id: number;
        result?: string;
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
        } else if (typeof message.result === "string") pending.resolve(message.result);
        else pending.reject(new Error("Library lowering worker returned no output"));
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
      fail(new Error(`Library lowering worker exited with code ${code}`))
    );
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const closed = new Error("Library lowering worker closed");
    for (const pending of this.pending.values()) pending.reject(closed);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
