import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { BuildDiagnostic } from "./diagnostics.js";
import type { TypecheckAuthorityInput, TypecheckUnitDep } from "./typecheckFold.js";
import type { TypecheckEnvironmentServiceWire, TypecheckWorkerRequest } from "./typecheckWorker.js";

declare global {
  var __VIBESTUDIO_TYPECHECK_WORKER_ENTRY__: string | undefined;
}

const WORKER_BOOTSTRAP_RELATIVE_PATH = "src/server/buildV2/typecheckWorkerBootstrap.mjs" as const;

export function resolveTypecheckWorkerEntry(appRoot: string): string {
  const candidate = path.join(appRoot, WORKER_BOOTSTRAP_RELATIVE_PATH);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Typecheck worker entry is missing at ${candidate}`);
}

function workerEntry(appRoot: string): string {
  const emitted = globalThis.__VIBESTUDIO_TYPECHECK_WORKER_ENTRY__;
  return emitted
    ? path.resolve(path.dirname(process.argv[1]!), emitted)
    : resolveTypecheckWorkerEntry(appRoot);
}

interface Pending {
  resolve(value: BuildDiagnostic[]): void;
  reject(error: Error): void;
}

export class TypecheckWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly appRoot: string) {}

  async check(input: {
    unitRelativePath: string;
    sourceRoot: string;
    internalDeps: TypecheckUnitDep[];
    nodeModulesPaths: string[];
    authority?: TypecheckAuthorityInput;
  }): Promise<BuildDiagnostic[]> {
    const authority = input.authority ? await this.authorityWire(input.authority) : undefined;
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: TypecheckWorkerRequest = { id, ...input, authority };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
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
    const worker = new Worker(workerEntry(this.appRoot));
    worker.unref();
    worker.on(
      "message",
      (message: {
        id: number;
        result?: BuildDiagnostic[];
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
