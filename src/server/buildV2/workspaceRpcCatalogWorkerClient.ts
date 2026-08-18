import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { WorkspaceRpcMethodDoc, WorkspaceRpcSchemaMetadata } from "./workspaceRpcCatalog.js";

declare global {
  var __VIBESTUDIO_RPC_CATALOG_WORKER_ENTRY__: string | undefined;
}

const SOURCE_ENTRY = "src/server/buildV2/workspaceRpcCatalogWorkerBootstrap.mjs";

export function resolveWorkspaceRpcCatalogWorkerEntry(appRoot: string): string {
  const candidate = path.join(appRoot, SOURCE_ENTRY);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Workspace RPC catalog worker entry is missing at ${candidate}`);
}

function workerEntry(appRoot: string): string {
  const emitted = globalThis.__VIBESTUDIO_RPC_CATALOG_WORKER_ENTRY__;
  if (emitted) return path.resolve(path.dirname(process.argv[1]!), emitted);
  return resolveWorkspaceRpcCatalogWorkerEntry(appRoot);
}

interface Pending {
  resolve(value: WorkspaceRpcMethodDoc[]): void;
  reject(error: Error): void;
}

/** Runs TypeScript parsing and source-tree traversal outside the server thread. */
export class WorkspaceRpcCatalogWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly appRoot: string) {}

  collect(
    workerSourcePath: string,
    input: {
      provider: string;
      authority: UnitAuthorityManifest;
      rpcSchemas?: Readonly<Record<string, Readonly<Record<string, WorkspaceRpcSchemaMetadata>>>>;
    }
  ): Promise<WorkspaceRpcMethodDoc[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, workerSourcePath, input });
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
        result?: WorkspaceRpcMethodDoc[];
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
          pending.resolve(message.result ?? []);
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
      fail(new Error(`Workspace RPC catalog worker exited with code ${code}`))
    );
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Workspace RPC catalog worker closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
