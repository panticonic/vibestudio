import { resolveHostWorkerEntry } from "../hostWorkerEntry.js";
import type { Worker } from "node:worker_threads";
import { createMeasuredWorker } from "../workerPerformance.js";

declare global {
  var __VIBESTUDIO_IMMUTABLE_TREE_WORKER_ENTRY__: string | undefined;
}

export function resolveImmutableTreeWorkerEntry(): string {
  return resolveHostWorkerEntry(
    globalThis.__VIBESTUDIO_IMMUTABLE_TREE_WORKER_ENTRY__ ?? "immutable-tree-worker.mjs"
  );
}

interface Pending {
  resolve(): void;
  reject(error: Error): void;
}

/** Keeps immutable dependency-tree projection off the workspace server thread. */
export class ImmutableTreeWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  materialize(source: string, target: string): Promise<void> {
    return this.project("tree", source, target);
  }

  materializePackage(source: string, target: string): Promise<void> {
    return this.project("package", source, target);
  }

  private project(kind: "tree" | "package", source: string, target: string): Promise<void> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, kind, source, target });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createMeasuredWorker("immutableTree", resolveImmutableTreeWorkerEntry());
    worker.unref();
    worker.on(
      "message",
      (message: {
        id: number;
        result?: boolean;
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
        } else if (message.result) pending.resolve();
        else pending.reject(new Error("Immutable tree worker returned no result"));
      }
    );
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Immutable tree worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Immutable tree worker closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
