import { runGadRepositoryReducerV1 } from "./kernel.js";
import type {
  GadRepositoryDatabaseRefV1,
  GadRepositoryReducerHostAdapterV1,
  GadRepositoryReducerRequestV1,
  GadWorkingDatabaseRefV1,
} from "./types.js";
import {
  decodeGadReducerInvocationBundleV1,
  encodeGadReducerApplicationResultV1,
  type GadReducerSelectedSourceV1,
} from "./worker-codec.js";
import type {
  DatabaseReducerDatabasesHandle,
  DatabaseReducerHandlerResult,
  DatabaseReducerInputHandle,
  DatabaseReducerInvocationContextHandle,
  DatabaseReducerOutputHandle,
  DatabaseReducerWorkerModule,
} from "./workerd-contract.js";

export const GAD_PRIVATE_REPOSITORY_OUTPUT_NAME = "repository_out" as const;
export const GAD_PRIVATE_WORKING_OUTPUT_NAME = "working_out" as const;

type DatabaseHandle = DatabaseReducerInputHandle | DatabaseReducerOutputHandle;

/**
 * Invocation-local bridge between the portable Gad kernel and concrete synchronous database/CAS
 * operations. Selection is explicit because the portable kernel may return an input (for example a
 * fast-forward operand) or one of the private outputs.
 */
export interface GadRepositoryReducerWorkerSessionV1 {
  readonly host: GadRepositoryReducerHostAdapterV1;
  selectRepository(ref: GadRepositoryDatabaseRefV1): DatabaseHandle;
  selectWorking(ref: GadWorkingDatabaseRefV1): DatabaseHandle;
}

export interface GadRepositoryReducerWorkerAdapterV1 {
  open(input: {
    readonly databases: DatabaseReducerDatabasesHandle;
    readonly request: GadRepositoryReducerRequestV1;
    readonly invocation: DatabaseReducerInvocationContextHandle;
  }): Promise<GadRepositoryReducerWorkerSessionV1> | GadRepositoryReducerWorkerSessionV1;
}

export type GadRepositoryReducerWorkerModule<Env = unknown> = DatabaseReducerWorkerModule<Env>;

/**
 * Creates the modules-syntax worker object. The standard-mode `env` argument is intentionally not
 * forwarded into the portable Gad kernel; concrete host capabilities are fixed when the bundle is
 * assembled through `adapter`.
 */
export function createGadRepositoryReducerWorkerModule<Env = unknown>(
  adapter: GadRepositoryReducerWorkerAdapterV1
): GadRepositoryReducerWorkerModule<Env> {
  return {
    async reduce(databases, input, _env, ctx): Promise<DatabaseReducerHandlerResult> {
      return await reduceGadRepository(databases, input, ctx, adapter);
    },
  };
}

/** Three-argument core matching the reducer event after modules-syntax environment injection. */
export async function reduceGadRepository(
  databases: DatabaseReducerDatabasesHandle,
  input: unknown,
  ctx: DatabaseReducerInvocationContextHandle,
  adapter: GadRepositoryReducerWorkerAdapterV1
): Promise<DatabaseReducerHandlerResult> {
  if (!(input instanceof Uint8Array)) throw new Error("Gad reducer input must be canonical bytes");
  const bundle = decodeGadReducerInvocationBundleV1(input);
  assertNamedHandles(databases, bundle.request);
  const session = await adapter.open({ databases, request: bundle.request, invocation: ctx });
  const result = await runGadRepositoryReducerV1(bundle.request, session.host);
  const repository = session.selectRepository(result.repository);
  const repositorySource = sourceForHandle(databases, repository);
  assertRepositorySelection(bundle.request, repositorySource);

  let working: DatabaseHandle | null = null;
  let workingSource: GadReducerSelectedSourceV1 | null = null;
  if (result.working !== null) {
    working = session.selectWorking(result.working);
    workingSource = sourceForHandle(databases, working);
    assertWorkingSelection(workingSource);
  }

  return {
    databases: {
      repository,
      ...(working === null ? {} : { working }),
    },
    output: encodeGadReducerApplicationResultV1({
      version: 1,
      repositorySource,
      workingSource,
      repositoryManifest: result.repositoryManifest,
      workingManifest: result.workingManifest,
      publication: result.publicationRequest
        ? {
            targetRef: result.publicationRequest.targetRef,
            expected: result.publicationRequest.expected,
            reason: result.publicationRequest.reason,
          }
        : null,
      mergeResults: result.mergeResults,
    }),
  };
}

function assertNamedHandles(
  databases: DatabaseReducerDatabasesHandle,
  request: GadRepositoryReducerRequestV1
): void {
  const expectedInputs = [
    ...(request.inputs.repository ? [request.inputs.repository.logicalName] : []),
    ...(request.inputs.working ? [request.inputs.working.logicalName] : []),
    ...request.inputs.merges.map((input) => input.logicalName),
  ];
  if (!sameNameSet(databases.inputNames, expectedInputs)) {
    throw new Error("Gad reducer named input handle set mismatch");
  }
  if (
    !sameNameSet(databases.outputNames, [
      GAD_PRIVATE_REPOSITORY_OUTPUT_NAME,
      GAD_PRIVATE_WORKING_OUTPUT_NAME,
    ])
  ) {
    throw new Error("Gad reducer private output handle set mismatch");
  }
  for (const input of [
    ...(request.inputs.repository ? [request.inputs.repository] : []),
    ...(request.inputs.working ? [request.inputs.working] : []),
    ...request.inputs.merges,
  ]) {
    const handle = databases.getInput(input.logicalName);
    if (handle === null || handle.sqlAlias !== input.sqlAlias) {
      throw new Error(`Gad reducer input alias mismatch: ${input.logicalName}`);
    }
  }
  const repository = databases.getOutput(GAD_PRIVATE_REPOSITORY_OUTPUT_NAME);
  const working = databases.getOutput(GAD_PRIVATE_WORKING_OUTPUT_NAME);
  if (repository?.sqlAlias !== GAD_PRIVATE_REPOSITORY_OUTPUT_NAME) {
    throw new Error("Gad reducer repository output alias mismatch");
  }
  if (working?.sqlAlias !== GAD_PRIVATE_WORKING_OUTPUT_NAME) {
    throw new Error("Gad reducer working output alias mismatch");
  }
}

function sourceForHandle(
  databases: DatabaseReducerDatabasesHandle,
  selected: DatabaseHandle
): GadReducerSelectedSourceV1 {
  // Native getInput()/getOutput() calls may allocate a fresh JS wrapper for the same
  // generation-bound database. Identify the selected handle by its immutable invocation name and
  // alias; the native handler-result extractor still verifies that the returned value is a real
  // database resource from this invocation.
  if (databases.inputNames.includes(selected.logicalName)) {
    return {
      kind: "input",
      logicalName: selected.logicalName,
      sqlAlias: selected.sqlAlias,
    };
  }
  if (databases.outputNames.includes(selected.logicalName)) {
    return {
      kind: "output",
      logicalName: selected.logicalName,
      sqlAlias: selected.sqlAlias,
    };
  }
  throw new Error("Gad reducer adapter selected an unknown database handle");
}

function assertRepositorySelection(
  request: GadRepositoryReducerRequestV1,
  source: GadReducerSelectedSourceV1
): void {
  if (source.kind === "output") {
    if (source.logicalName !== GAD_PRIVATE_REPOSITORY_OUTPUT_NAME) {
      throw new Error("Gad repository result selected the wrong private output");
    }
    return;
  }
  const allowed = new Set([
    ...(request.inputs.repository ? [request.inputs.repository.logicalName] : []),
    ...request.inputs.merges.map((input) => input.logicalName),
  ]);
  if (!allowed.has(source.logicalName)) {
    throw new Error("Gad repository result selected a non-repository input");
  }
}

function assertWorkingSelection(source: GadReducerSelectedSourceV1): void {
  if (
    (source.kind === "input" && source.logicalName !== "working") ||
    (source.kind === "output" && source.logicalName !== GAD_PRIVATE_WORKING_OUTPUT_NAME)
  ) {
    throw new Error("Gad working result selected the wrong database handle");
  }
}

function sameNameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}
