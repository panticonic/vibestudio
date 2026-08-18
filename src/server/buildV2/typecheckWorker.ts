import { parentPort } from "node:worker_threads";
import type {
  ExactWorkspaceServiceBinding,
  UserlandMethodAuthority,
  UserlandServiceAuthorityCatalog,
} from "./userlandAuthority.js";
import { createExactWorkspaceAuthorityEnvironment } from "./userlandAuthority.js";
import {
  typecheckUnit,
  type TypecheckAuthorityInput,
  type TypecheckUnitDep,
} from "./typecheckFold.js";

export interface TypecheckEnvironmentServiceWire {
  binding: ExactWorkspaceServiceBinding;
  catalog: Omit<UserlandServiceAuthorityCatalog, "methods"> & {
    methods: Array<[string, UserlandMethodAuthority]>;
  };
}

export interface TypecheckAuthorityWire extends Omit<TypecheckAuthorityInput, "environment"> {
  environment?: { stateHash: string; services: TypecheckEnvironmentServiceWire[] };
}

export interface TypecheckWorkerRequest {
  id: number;
  unitRelativePath: string;
  sourceRoot: string;
  internalDeps: TypecheckUnitDep[];
  nodeModulesPaths: string[];
  authority?: TypecheckAuthorityWire;
}

function authorityFromWire(
  authority: TypecheckWorkerRequest["authority"]
): TypecheckAuthorityInput | undefined {
  if (!authority) return undefined;
  const { environment, ...rest } = authority;
  if (!environment) return rest;
  const catalogs = new Map(
    environment.services.map(({ binding, catalog }) => [
      binding.name,
      { ...catalog, methods: new Map(catalog.methods) },
    ])
  );
  return {
    ...rest,
    environment: createExactWorkspaceAuthorityEnvironment({
      stateHash: environment.stateHash,
      services: environment.services.map(({ binding }) => binding),
      async resolveCatalog(binding) {
        const catalog = catalogs.get(binding.name);
        if (!catalog) throw new Error(`Missing typecheck authority catalog for ${binding.name}`);
        return catalog;
      },
    }),
  };
}

const port = parentPort;
if (port) {
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (request: TypecheckWorkerRequest) => {
    queue = queue.then(async () => {
      try {
        const result = await typecheckUnit(
          request.unitRelativePath,
          request.sourceRoot,
          request.internalDeps,
          request.nodeModulesPaths,
          authorityFromWire(request.authority)
        );
        port.postMessage({ id: request.id, result });
      } catch (error) {
        port.postMessage({
          id: request.id,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { name: "Error", message: String(error) },
        });
      }
    });
  });
}
