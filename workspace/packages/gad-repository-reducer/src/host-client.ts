import { bytesFromHex, bytesToHex } from "@vibestudio/shared/contentStore/exactContentStore";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  canonicalizeGadObjectRefV1,
  contentStoreObjectRefFromCanonicalV1,
} from "@workspace/gad-repository-contract";
import { cloneRepositoryRefV1 } from "./state.js";
import {
  GAD_REPOSITORY_OUTPUT_NAME,
  GAD_WORKING_OUTPUT_NAME,
  asGadDoltCommitHash,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryPublicationRequestV1,
  type GadRepositoryReducerRequestV1,
  type GadRepositoryReducerResultV1,
  type GadWorkingDatabaseRefV1,
} from "./types.js";
import {
  GAD_PRIVATE_REPOSITORY_OUTPUT_NAME,
  GAD_PRIVATE_WORKING_OUTPUT_NAME,
} from "./worker-bundle.js";
import {
  decodeDatabaseReducerByteString,
  decodeGadReducerInvocationBundleV1,
  decodeGadReducerApplicationResultV1,
  encodeDatabaseReducerByteString,
  encodeGadReducerInvocationBundleV1,
} from "./worker-codec.js";
import type {
  DatabaseReducerCommitOptions,
  WorkerdDatabaseReducerDatabaseRefValue,
  WorkerdDatabaseReducerGeneratedBinding,
  WorkerdDatabaseReducerRunDatabase,
  WorkerdDatabaseReducerRunInput,
  WorkerdDatabaseReducerRunOptions,
  WorkerdDatabaseReducerRunOutputPlan,
  WorkerdDatabaseReducerRunResult,
} from "./workerd-contract.js";

const DOLT_REPOSITORY_ROOT_CODEC_NUMBER = 0x30_0101;
const DOLT_REPOSITORY_ROOT_CODEC_VERSION = 1;
const DOLT_BLAKE3_160_HASH_ALGORITHM = 0x30_0101;

export interface GadWorkerdTransportRunRequest {
  readonly executionKey: Uint8Array;
  readonly options: WorkerdDatabaseReducerRunOptions;
}

export interface GadWorkerdPublicationIntentV1 {
  readonly version: 1;
  readonly executionKey: Uint8Array;
  readonly targetRef: string;
  readonly expected: GadRepositoryDatabaseRefV1 | null;
  readonly selectedOutput: GadRepositoryDatabaseRefV1;
  readonly selectedTransportOutput: WorkerdDatabaseReducerRunDatabase;
  readonly reason: string;
}

export interface GadWorkerdPublicationResultV1 {
  readonly status: "published" | "already_current" | "conflict";
  readonly generation: bigint | null;
  readonly current: GadRepositoryDatabaseRefV1 | null;
}

/** Publication/follow authority belongs to the host and is never passed to reducer code. */
export interface GadWorkerdHostTransportV1 {
  run(request: GadWorkerdTransportRunRequest): Promise<WorkerdDatabaseReducerRunResult>;
  follow(executionKey: Uint8Array): Promise<WorkerdDatabaseReducerRunResult | null>;
  publish(request: GadWorkerdPublicationIntentV1): Promise<GadWorkerdPublicationResultV1>;
}

export interface GadWorkerdClientDatabaseInputV1 {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly transport: WorkerdDatabaseReducerDatabaseRefValue;
}

export interface GadWorkerdClientRunRequestV1 {
  readonly request: GadRepositoryReducerRequestV1;
  readonly databases: readonly GadWorkerdClientDatabaseInputV1[];
  readonly repositoryCommit?: DatabaseReducerCommitOptions;
  readonly workingCommit?: DatabaseReducerCommitOptions;
}

export interface GadWorkerdExecutionResponseV1 {
  readonly executionKey: Uint8Array;
  readonly result: GadRepositoryReducerResultV1;
  readonly transportOutputs: readonly WorkerdDatabaseReducerRunDatabase[];
}

const DEFAULT_REPOSITORY_COMMIT: DatabaseReducerCommitOptions = Object.freeze({
  message: "Gad repository reducer output",
  authorName: "Gad reducer",
  authorEmail: "reducer@gad.invalid",
  timestamp: "1970-01-01T00:00:00",
});
const DEFAULT_WORKING_COMMIT: DatabaseReducerCommitOptions = Object.freeze({
  message: "Gad working snapshot output",
  authorName: "Gad reducer",
  authorEmail: "reducer@gad.invalid",
  timestamp: "1970-01-01T00:00:00",
});

export class GadWorkerdHostClientV1 {
  constructor(private readonly transport: GadWorkerdHostTransportV1) {}

  async run(request: GadWorkerdClientRunRequestV1): Promise<GadWorkerdExecutionResponseV1> {
    const prepared = await prepareRun(request);
    return decodeRunResult(request, prepared.executionKey, await this.transport.run(prepared));
  }

  async follow(
    request: GadWorkerdClientRunRequestV1
  ): Promise<GadWorkerdExecutionResponseV1 | null> {
    const prepared = await prepareRun(request);
    const result = await this.transport.follow(prepared.executionKey);
    return result === null ? null : decodeRunResult(request, prepared.executionKey, result);
  }

  /** Run once, then use the deterministic execution key after an ambiguous response. */
  async execute(request: GadWorkerdClientRunRequestV1): Promise<GadWorkerdExecutionResponseV1> {
    const prepared = await prepareRun(request);
    try {
      return decodeRunResult(request, prepared.executionKey, await this.transport.run(prepared));
    } catch (error) {
      const followed = await this.transport.follow(prepared.executionKey);
      if (followed === null) throw error;
      return decodeRunResult(request, prepared.executionKey, followed);
    }
  }

  createPublicationIntent(response: GadWorkerdExecutionResponseV1): GadWorkerdPublicationIntentV1 {
    const request = response.result.publicationRequest;
    if (request === null) throw new Error("Gad reducer result has no publication intent");
    const transport = response.transportOutputs.find(
      (candidate) => candidate.logicalName === GAD_REPOSITORY_OUTPUT_NAME
    );
    if (transport === undefined) throw new Error("Gad publication requires repository output");
    return {
      version: 1,
      executionKey: response.executionKey.slice(),
      targetRef: request.targetRef,
      expected: request.expected ? cloneRepositoryRefV1(request.expected) : null,
      selectedOutput: cloneRepositoryRefV1(request.repository),
      selectedTransportOutput: cloneTransportOutput(transport),
      reason: request.reason,
    };
  }

  publish(request: GadWorkerdPublicationIntentV1): Promise<GadWorkerdPublicationResultV1> {
    return this.transport.publish(request);
  }
}

export function createGadGeneratedBindingRunTransportV1(
  binding: WorkerdDatabaseReducerGeneratedBinding,
  metadata: Pick<GadWorkerdHostTransportV1, "follow" | "publish">
): GadWorkerdHostTransportV1 {
  return {
    run: async (request) => await binding.run(request.options),
    follow: (executionKey) => metadata.follow(executionKey),
    publish: (request) => metadata.publish(request),
  };
}

async function prepareRun(
  value: GadWorkerdClientRunRequestV1
): Promise<GadWorkerdTransportRunRequest> {
  const canonicalRequest = decodeAndFreezeRequest(value.request);
  const inputs = canonicalInputs(canonicalRequest, value.databases);
  const outputs = outputPlans(canonicalRequest, value);
  const invocation = encodeGadReducerInvocationBundleV1({
    version: 1,
    request: canonicalRequest,
  });
  const canonicalInput = encodeDatabaseReducerByteString(invocation);
  const fingerprint = new TextEncoder().encode(
    canonicalJson({
      version: 1,
      invocation: bytesToHex(invocation),
      inputs,
      outputs,
    })
  );
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(fingerprint).buffer);
  return {
    executionKey: new Uint8Array(digest),
    options: {
      inputs,
      outputs,
      canonicalInput,
    },
  };
}

function decodeAndFreezeRequest(
  request: GadRepositoryReducerRequestV1
): GadRepositoryReducerRequestV1 {
  // The invocation codec is its own strict canonical round trip and clones every byte array.
  const bytes = encodeGadReducerInvocationBundleV1({ version: 1, request });
  return decodeGadReducerInvocationBundleV1(bytes).request;
}

function canonicalInputs(
  request: GadRepositoryReducerRequestV1,
  provided: readonly GadWorkerdClientDatabaseInputV1[]
): WorkerdDatabaseReducerRunInput[] {
  const expected = [
    ...(request.inputs.repository ? [request.inputs.repository] : []),
    ...(request.inputs.working ? [request.inputs.working] : []),
    ...request.inputs.merges,
  ];
  if (provided.length !== expected.length)
    throw new Error("Gad client database input count mismatch");
  const byName = new Map(provided.map((input) => [input.logicalName, input] as const));
  if (byName.size !== provided.length) throw new Error("Duplicate Gad client database input");
  return expected.map((input) => {
    const supplied = byName.get(input.logicalName);
    if (supplied === undefined || supplied.sqlAlias !== input.sqlAlias) {
      throw new Error(`Gad client database input mismatch: ${input.logicalName}`);
    }
    assertTransportMatchesApplicationRef(supplied.transport, input.ref);
    return {
      logicalName: input.logicalName,
      sqlAlias: input.sqlAlias,
      database: cloneTransportDatabase(supplied.transport),
    };
  });
}

function outputPlans(
  request: GadRepositoryReducerRequestV1,
  client: GadWorkerdClientRunRequestV1
): WorkerdDatabaseReducerRunOutputPlan[] {
  const repositorySource = request.inputs.repository?.logicalName ?? "";
  const workingSource = request.inputs.working?.logicalName ?? "";
  return [
    {
      logicalName: GAD_PRIVATE_REPOSITORY_OUTPUT_NAME,
      sqlAlias: GAD_PRIVATE_REPOSITORY_OUTPUT_NAME,
      origin: repositorySource === "" ? "create-canonical" : "fork-input",
      sourceInput: repositorySource,
      commit: client.repositoryCommit ?? DEFAULT_REPOSITORY_COMMIT,
    },
    {
      logicalName: GAD_PRIVATE_WORKING_OUTPUT_NAME,
      sqlAlias: GAD_PRIVATE_WORKING_OUTPUT_NAME,
      origin: workingSource === "" ? "create-canonical" : "fork-input",
      sourceInput: workingSource,
      commit: client.workingCommit ?? DEFAULT_WORKING_COMMIT,
    },
  ];
}

function decodeRunResult(
  request: GadWorkerdClientRunRequestV1,
  executionKey: Uint8Array,
  value: WorkerdDatabaseReducerRunResult
): GadWorkerdExecutionResponseV1 {
  const application = decodeGadReducerApplicationResultV1(
    decodeDatabaseReducerByteString(value.canonicalOutput)
  );
  const expectedNames =
    application.workingSource === null
      ? [GAD_REPOSITORY_OUTPUT_NAME]
      : [GAD_REPOSITORY_OUTPUT_NAME, GAD_WORKING_OUTPUT_NAME];
  if (
    value.databases.length !== expectedNames.length ||
    !expectedNames.every((name) =>
      value.databases.some((database) => database.logicalName === name)
    )
  ) {
    throw new Error("Gad reducer selected database set mismatch");
  }
  const repositoryOutput = requireRunOutput(value, GAD_REPOSITORY_OUTPUT_NAME);
  validateSelectedOutput(request, application.repositorySource, repositoryOutput, "repository");
  const repository = repositoryRefFromTransport(repositoryOutput.database);

  let working: GadWorkingDatabaseRefV1 | null = null;
  if (application.workingSource !== null) {
    const workingOutput = requireRunOutput(value, GAD_WORKING_OUTPUT_NAME);
    validateSelectedOutput(request, application.workingSource, workingOutput, "working");
    working = {
      kind: "gad.workingDatabase",
      database: objectRefFromTransport(workingOutput.database.repositoryRoot),
      committedBase: cloneRepositoryRefV1(repository),
    };
  }
  const publicationRequest: GadRepositoryPublicationRequestV1 | null = application.publication
    ? {
        kind: "gad.repositoryPublicationRequest",
        targetRef: application.publication.targetRef,
        expected: application.publication.expected
          ? cloneRepositoryRefV1(application.publication.expected)
          : null,
        outputName: GAD_REPOSITORY_OUTPUT_NAME,
        repository: cloneRepositoryRefV1(repository),
        reason: application.publication.reason,
      }
    : null;
  return {
    executionKey: executionKey.slice(),
    result: {
      protocolVersion: 1,
      repository,
      working,
      repositoryManifest: application.repositoryManifest,
      workingManifest: application.workingManifest,
      publicationRequest,
      mergeResults: application.mergeResults.map((merge) => ({
        inputName: merge.inputName,
        status: merge.status,
        baseCommitHash:
          merge.baseCommitHash === null ? null : asGadDoltCommitHash(merge.baseCommitHash),
        conflicts: merge.conflicts.map((conflict) => ({ ...conflict })),
      })),
    },
    transportOutputs: value.databases.map(cloneTransportOutput),
  };
}

function validateSelectedOutput(
  request: GadWorkerdClientRunRequestV1,
  source: { kind: "input" | "output"; logicalName: string; sqlAlias: string },
  selected: WorkerdDatabaseReducerRunDatabase,
  resultKind: "repository" | "working"
): void {
  if (selected.sqlAlias !== source.sqlAlias)
    throw new Error("Gad selected database alias mismatch");
  if (source.kind === "output") {
    const expected =
      resultKind === "repository"
        ? GAD_PRIVATE_REPOSITORY_OUTPUT_NAME
        : GAD_PRIVATE_WORKING_OUTPUT_NAME;
    if (source.logicalName !== expected) throw new Error("Gad selected the wrong private output");
    return;
  }
  const input = request.databases.find((candidate) => candidate.logicalName === source.logicalName);
  if (input === undefined || input.sqlAlias !== source.sqlAlias) {
    throw new Error("Gad selected an unknown input database");
  }
  if (!sameTransportDatabase(input.transport, selected.database)) {
    throw new Error("Gad selected input database was substituted");
  }
  if (resultKind === "working" && source.logicalName !== "working") {
    throw new Error("Gad working result selected a repository input");
  }
  if (resultKind === "repository" && source.logicalName === "working") {
    throw new Error("Gad repository result selected a working input");
  }
}

function requireRunOutput(
  value: WorkerdDatabaseReducerRunResult,
  logicalName: string
): WorkerdDatabaseReducerRunDatabase {
  const matches = value.databases.filter((database) => database.logicalName === logicalName);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Missing or duplicate Gad reducer output: ${logicalName}`);
  }
  return matches[0];
}

function assertTransportMatchesApplicationRef(
  transport: WorkerdDatabaseReducerDatabaseRefValue,
  ref: GadRepositoryDatabaseRefV1 | GadWorkingDatabaseRefV1
): void {
  const expectedRoot = ref.database;
  const actualRoot = objectRefFromTransport(transport.repositoryRoot);
  const actualObject = contentStoreObjectRefFromCanonicalV1(actualRoot);
  const expectedObject = contentStoreObjectRefFromCanonicalV1(expectedRoot);
  if (
    bytesToHex(actualObject.storeId) !== bytesToHex(expectedObject.storeId) ||
    actualObject.codec.number !== expectedObject.codec.number ||
    actualObject.codec.version !== expectedObject.codec.version ||
    actualObject.contentId.algorithm !== expectedObject.contentId.algorithm ||
    bytesToHex(actualObject.contentId.digest) !== bytesToHex(expectedObject.contentId.digest)
  ) {
    throw new Error("Gad transport database root substitution");
  }
  if (ref.kind === "gad.repositoryDatabase" && transport.commitHash !== ref.commitHash) {
    throw new Error("Gad transport commit substitution");
  }
  validateTransportDatabase(transport);
}

function repositoryRefFromTransport(
  value: WorkerdDatabaseReducerDatabaseRefValue
): GadRepositoryDatabaseRefV1 {
  validateTransportDatabase(value);
  return {
    kind: "gad.repositoryDatabase",
    database: objectRefFromTransport(value.repositoryRoot),
    commitHash: asGadDoltCommitHash(value.commitHash),
  };
}

function objectRefFromTransport(value: WorkerdDatabaseReducerDatabaseRefValue["repositoryRoot"]) {
  if (
    value.codecNumber !== DOLT_REPOSITORY_ROOT_CODEC_NUMBER ||
    value.codecVersion !== DOLT_REPOSITORY_ROOT_CODEC_VERSION ||
    value.hashAlgorithm !== "dolt-blake3-160" ||
    value.digest.length !== 40
  ) {
    throw new Error("Unsupported Gad Dolt repository-root identity");
  }
  return canonicalizeGadObjectRefV1({
    storeId: bytesFromHex(value.storeId),
    codec: { number: value.codecNumber, version: value.codecVersion },
    contentId: {
      algorithm: DOLT_BLAKE3_160_HASH_ALGORITHM,
      digest: bytesFromHex(value.digest),
    },
  });
}

function validateTransportDatabase(value: WorkerdDatabaseReducerDatabaseRefValue): void {
  objectRefFromTransport(value.repositoryRoot);
  asGadDoltCommitHash(value.commitHash);
  if (!Number.isSafeInteger(value.doltFormatVersion) || value.doltFormatVersion <= 0) {
    throw new Error("Invalid Gad Dolt format version");
  }
  if (!Number.isSafeInteger(value.stateFormatVersion) || value.stateFormatVersion <= 0) {
    throw new Error("Invalid Gad state format version");
  }
  if (value.stateDigest.length !== 40) throw new Error("Invalid Gad Dolt state digest");
  bytesFromHex(value.stateDigest);
}

function sameTransportDatabase(
  left: WorkerdDatabaseReducerDatabaseRefValue,
  right: WorkerdDatabaseReducerDatabaseRefValue
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneTransportDatabase(
  value: WorkerdDatabaseReducerDatabaseRefValue
): WorkerdDatabaseReducerDatabaseRefValue {
  return { ...value, repositoryRoot: { ...value.repositoryRoot } };
}

function cloneTransportOutput(
  value: WorkerdDatabaseReducerRunDatabase
): WorkerdDatabaseReducerRunDatabase {
  return {
    logicalName: value.logicalName,
    sqlAlias: value.sqlAlias,
    database: cloneTransportDatabase(value.database),
  };
}
