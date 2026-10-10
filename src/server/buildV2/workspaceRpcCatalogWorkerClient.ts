import { resolveHostWorkerEntry } from "../hostWorkerEntry.js";
import type { Worker } from "node:worker_threads";
import { createMeasuredWorker } from "../workerPerformance.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { WorkspaceRpcMethodDoc, WorkspaceRpcSchemaMetadata } from "./workspaceRpcCatalog.js";
import { deserializeBuildWorkerFailure, type BuildWorkerFailure } from "./workerFailure.js";

declare global {
  var __VIBESTUDIO_RPC_CATALOG_WORKER_ENTRY__: string | undefined;
}

export function resolveWorkspaceRpcCatalogWorkerEntry(): string {
  return resolveHostWorkerEntry(
    globalThis.__VIBESTUDIO_RPC_CATALOG_WORKER_ENTRY__ ?? "workspace-rpc-catalog-worker.mjs"
  );
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

  collect(
    workerSourcePath: string,
    input: {
      provider: string;
      authority: UnitAuthorityManifest;
      rpcSchemas?: Readonly<Record<string, Readonly<Record<string, WorkspaceRpcSchemaMetadata>>>>;
      durableObjects?: boolean;
    }
  ): Promise<WorkspaceRpcMethodDoc[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, workerSourcePath, input });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createMeasuredWorker(
      "workspaceRpcCatalog",
      resolveWorkspaceRpcCatalogWorkerEntry()
    );
    worker.unref();
    worker.on(
      "message",
      (message: { id: number; result?: WorkspaceRpcMethodDoc[]; failure?: BuildWorkerFailure }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.failure) {
          pending.reject(deserializeBuildWorkerFailure(message.failure));
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
