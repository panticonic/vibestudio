import { resolveHostWorkerEntry } from "../hostWorkerEntry.js";
import type { Worker } from "node:worker_threads";
import { createMeasuredWorker } from "../workerPerformance.js";
import type { BuildDiagnostic } from "./diagnostics.js";
import type { TypecheckAuthorityInput, TypecheckUnitDep } from "./typecheckFold.js";
import type { TypecheckEnvironmentServiceWire, TypecheckWorkerRequest } from "./typecheckWorker.js";
import { deserializeBuildWorkerFailure, type BuildWorkerFailure } from "./workerFailure.js";

declare global {
  var __VIBESTUDIO_TYPECHECK_WORKER_ENTRY__: string | undefined;
}

export function resolveTypecheckWorkerEntry(): string {
  return resolveHostWorkerEntry(
    globalThis.__VIBESTUDIO_TYPECHECK_WORKER_ENTRY__ ?? "typecheck-worker.mjs"
  );
}

interface Pending {
  resolve(value: BuildDiagnostic[]): void;
  reject(error: Error): void;
}

/**
 * One lazy worker belongs to the build system until shutdown. Keep compiler
 * modules warm across edited states; typecheckUnit disposes each request's
 * program and native compiler API before replying.
 */
export class TypecheckWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  async check(input: {
    unitRelativePath: string;
    sourceRoot: string;
    internalDeps: TypecheckUnitDep[];
    nodeModulesPaths: string[];
    moduleConditions: readonly string[];
    authority?: TypecheckAuthorityInput;
  }): Promise<BuildDiagnostic[]> {
    const authority = input.authority ? await this.authorityWire(input.authority) : undefined;
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: TypecheckWorkerRequest = { id, ...input, authority };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async authorityWire(
    authority: TypecheckAuthorityInput
  ): Promise<TypecheckWorkerRequest["authority"]> {
    const { environment, ...rest } = authority;
    if (!environment) return rest;
    const services: TypecheckEnvironmentServiceWire[] = [];
    for (const binding of environment.services) {
      const resolution = await environment.resolveService(binding.name);
      if (resolution.kind !== "resolved" && resolution.kind !== "inaccessible") {
        throw new Error(`Could not resolve typecheck authority catalog for ${binding.name}`);
      }
      services.push({
        binding,
        catalog: {
          ...resolution.service.catalog,
          methods: [...resolution.service.catalog.methods],
        },
      });
    }
    return { ...rest, environment: { stateHash: environment.stateHash, services } };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createMeasuredWorker("typecheck", resolveTypecheckWorkerEntry());
    worker.unref();
    worker.on(
      "message",
      (message: { id: number; result?: BuildDiagnostic[]; failure?: BuildWorkerFailure }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.failure) {
          pending.reject(deserializeBuildWorkerFailure(message.failure));
        } else if (message.result) pending.resolve(message.result);
        else pending.reject(new Error("Typecheck worker returned no diagnostics"));
      }
    );
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Typecheck worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const closed = new Error("Typecheck worker closed");
    for (const pending of this.pending.values()) pending.reject(closed);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
