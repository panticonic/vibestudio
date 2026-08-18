import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

declare global {
  var __VIBESTUDIO_LIBRARY_LOWERING_WORKER_ENTRY__: string | undefined;
}

interface Pending {
  resolve(value: string): void;
  reject(error: Error): void;
}

const WORKER_BOOTSTRAP_RELATIVE_PATH =
  "src/server/buildV2/libraryLoweringWorkerBootstrap.mjs" as const;

export function resolveLibraryLoweringWorkerEntry(appRoot: string): string {
  const candidate = path.join(appRoot, WORKER_BOOTSTRAP_RELATIVE_PATH);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Library lowering worker entry is missing at ${candidate}`);
}

function workerEntry(appRoot: string): string {
  const emitted = globalThis.__VIBESTUDIO_LIBRARY_LOWERING_WORKER_ENTRY__;
  return emitted
    ? path.resolve(path.dirname(process.argv[1]!), emitted)
    : resolveLibraryLoweringWorkerEntry(appRoot);
}

/** Keeps Babel's CPU-heavy library lowering off the workspace server event loop. */
export class LibraryLoweringWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly appRoot: string) {}

  lower(source: string): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, source });
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
