import { describe, expect, it } from "vitest";
import {
  bytesFromHex,
  bytesToHex,
  cloneObjectRef,
  objectRefKey,
  type ContentStoreCodecId,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import { contentStoreRefForSha256 } from "@vibestudio/shared/contentStore/vibeContentCodecs";
import {
  asGadCommitIntentId,
  canonicalizeGadObjectRefV1,
  type GadCommitIntentRowV1,
} from "@workspace/gad-repository-contract";
import {
  GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
  GadWorkerdHostClientV1,
  asGadDoltCommitHash,
  createGadRepositoryReducerWorkerModule,
  decodeDatabaseReducerByteString,
  encodeDatabaseReducerByteString,
  type DatabaseReducerCommitOptions,
  type DatabaseReducerDatabasesHandle,
  type DatabaseReducerHandlerResult,
  type DatabaseReducerInputHandle,
  type DatabaseReducerInvocationContextHandle,
  type DatabaseReducerOutputHandle,
  type DatabaseReducerOutputStatus,
  type GadDoltCommitHash,
  type GadExactMergeAdapterRequestV1,
  type GadFinalizeRepositoryRequestV1,
  type GadFinalizeWorkingRequestV1,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryImageV1,
  type GadRepositoryReducerHostAdapterV1,
  type GadRepositoryReducerRequestV1,
  type GadRepositoryReducerWorkerAdapterV1,
  type GadRepositoryReducerWorkerModule,
  type GadRepositoryReducerWorkerSessionV1,
  type GadWorkingDatabaseRefV1,
  type GadWorkerdHostTransportV1,
  type GadWorkerdPublicationIntentV1,
  type GadWorkerdPublicationResultV1,
  type GadWorkerdTransportRunRequest,
  type WorkerdDatabaseReducerDatabaseRefValue,
  type WorkerdDatabaseReducerRunDatabase,
  type WorkerdDatabaseReducerRunResult,
} from "./index.js";

const STORE_ID = bytesFromHex("6761642d776f726b6572642d736861646f77");
const DATABASE_CODEC: ContentStoreCodecId = { number: 0x30_0101, version: 1 };

const hexByte = (value: number, count: number): string =>
  value.toString(16).padStart(2, "0").repeat(count);

function intent(id: string, operation: GadCommitIntentRowV1["operation"]): GadCommitIntentRowV1 {
  return {
    commitIntentId: asGadCommitIntentId(id),
    operation,
    message: id,
    actorRef: "actor:shadow",
    invocationId: `invocation:${id}`,
    turnId: `turn:${id}`,
    logicalTime: "2026-07-15T00:00:00.000Z",
    groupId: null,
    rebasedFromIntentId: null,
  };
}

function repository(seed: number): GadRepositoryDatabaseRefV1 {
  return {
    kind: "gad.repositoryDatabase",
    database: canonicalizeGadObjectRefV1({
      storeId: STORE_ID,
      codec: DATABASE_CODEC,
      contentId: { algorithm: 0x30_0101, digest: bytesFromHex(hexByte(seed, 20)) },
    }),
    commitHash: asGadDoltCommitHash(hexByte(seed, 20)),
  };
}

function transport(
  ref: GadRepositoryDatabaseRefV1,
  stateSeed: number
): WorkerdDatabaseReducerDatabaseRefValue {
  return {
    repositoryRoot: {
      storeId: ref.database.storeIdHex,
      codecNumber: ref.database.codecNumber,
      codecVersion: ref.database.codecVersion,
      hashAlgorithm: "dolt-blake3-160",
      digest: ref.database.digestHex,
    },
    doltFormatVersion: 1,
    commitHash: ref.commitHash,
    stateFormatVersion: 1,
    stateDigest: hexByte(stateSeed, 20),
  };
}

function image(head: GadCommitIntentRowV1): GadRepositoryImageV1 {
  return {
    schemaVersion: 1,
    files: [],
    edits: [],
    hunks: [],
    commitIntents: [head],
    headCommitIntentId: head.commitIntentId,
  };
}

describe("deployable Gad reducer bundle and typed host client", () => {
  it("executes the portable kernel, follows one ambiguous run, and publishes separately", async () => {
    const base = repository(0x11);
    const first = repository(0x22);
    const second = repository(0x33);
    const baseIntent = intent("intent.base", "import");
    const firstInputIntent = intent("intent.input.first", "commit");
    const secondInputIntent = intent("intent.input.second", "commit");
    const firstMerge = intent("intent.merge.first", "merge");
    const secondMerge = intent("intent.merge.second", "merge");
    const images = new Map<GadDoltCommitHash, GadRepositoryImageV1>([
      [base.commitHash, image(baseIntent)],
      [first.commitHash, image(firstInputIntent)],
      [second.commitHash, image(secondInputIntent)],
    ]);
    const adapter = new ShadowGadAdapter(images);
    const module = createGadRepositoryReducerWorkerModule(adapter);
    const host = new InMemoryWorkerdHost(module);
    host.loseNextRunResponse = true;
    const client = new GadWorkerdHostClientV1(host);
    const reducerRequest: GadRepositoryReducerRequestV1 = {
      protocolVersion: GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
      inputs: {
        repository: { logicalName: "repository", sqlAlias: "repository_in", ref: base },
        working: null,
        merges: [
          { logicalName: "merge_first", sqlAlias: "merge_first_in", ref: first },
          { logicalName: "merge_second", sqlAlias: "merge_second_in", ref: second },
        ],
      },
      operation: {
        kind: "mergeSequential",
        steps: [
          { inputName: "merge_first", intent: firstMerge, resolutions: [] },
          { inputName: "merge_second", intent: secondMerge, resolutions: [] },
        ],
      },
      publication: {
        targetRef: "main:packages/shadow",
        expected: base,
        reason: "shadow candidate",
      },
    };
    const request = {
      request: reducerRequest,
      databases: [
        { logicalName: "repository", sqlAlias: "repository_in", transport: transport(base, 0x41) },
        {
          logicalName: "merge_first",
          sqlAlias: "merge_first_in",
          transport: transport(first, 0x42),
        },
        {
          logicalName: "merge_second",
          sqlAlias: "merge_second_in",
          transport: transport(second, 0x43),
        },
      ],
    };

    const response = await client.execute(request);
    expect(host.runCount).toBe(1);
    expect(host.followCount).toBe(1);
    expect(adapter.mergeCalls.map((call) => call.theirs.commitHash)).toEqual([
      first.commitHash,
      second.commitHash,
    ]);
    expect(adapter.mergeCalls[0]?.ours.commitHash).toBe(base.commitHash);
    expect(adapter.mergeCalls[1]?.ours.commitHash).toBe(adapter.finalizedCommits[0]);
    expect(response.result.mergeResults.map((result) => result.inputName)).toEqual([
      "merge_first",
      "merge_second",
    ]);
    expect(response.result.repository.commitHash).toBe(adapter.finalizedCommits[1]);
    expect(response.result.repositoryManifest.database.outputName).toBe("repository");
    expect(response.result.working).toBeNull();
    expect(response.result.publicationRequest?.repository).toEqual(response.result.repository);
    expect(host.publications).toEqual([]);
    expect(host.reducerObservedPublicationCapability).toBe(false);

    const publication = client.createPublicationIntent(response);
    const published = await client.publish(publication);
    expect(published.status).toBe("published");
    expect(host.publications).toHaveLength(1);
    expect(host.publications[0]?.selectedOutput).toEqual(response.result.repository);

    const executionByte = publication.executionKey[0];
    const outputDigest = publication.selectedOutput.database.digestHex;
    if (reducerRequest.publication === null) throw new Error("Shadow publication missing");
    reducerRequest.publication.reason = "mutated after execution";
    expect(publication.executionKey[0]).toBe(executionByte);
    expect(publication.selectedOutput.database.digestHex).toBe(outputDigest);

    const wrapped = encodeDatabaseReducerByteString(Uint8Array.of(1, 2, 3));
    expect(decodeDatabaseReducerByteString(wrapped)).toEqual(Uint8Array.of(1, 2, 3));
  });
});

class ShadowGadAdapter implements GadRepositoryReducerWorkerAdapterV1 {
  readonly mergeCalls: GadExactMergeAdapterRequestV1[] = [];
  readonly finalizedCommits: GadDoltCommitHash[] = [];

  constructor(private readonly images: Map<GadDoltCommitHash, GadRepositoryImageV1>) {}

  open(input: Parameters<GadRepositoryReducerWorkerAdapterV1["open"]>[0]) {
    return new ShadowGadSession(
      input.databases,
      this.images,
      this.mergeCalls,
      this.finalizedCommits
    );
  }
}

class ShadowGadSession
  implements GadRepositoryReducerWorkerSessionV1, GadRepositoryReducerHostAdapterV1
{
  readonly host: GadRepositoryReducerHostAdapterV1 = this;
  readonly #objects = new Map<string, Uint8Array>();
  readonly #generated = new Set<GadDoltCommitHash>();

  constructor(
    private readonly databases: DatabaseReducerDatabasesHandle,
    private readonly images: Map<GadDoltCommitHash, GadRepositoryImageV1>,
    private readonly mergeCalls: GadExactMergeAdapterRequestV1[],
    private readonly finalizedCommits: GadDoltCommitHash[]
  ) {}

  getContentStoreId(): Uint8Array {
    return STORE_ID.slice();
  }

  async readExactObject(object: ContentStoreObjectRef): Promise<Uint8Array | null> {
    return this.#objects.get(objectRefKey(object))?.slice() ?? null;
  }

  async putExactObject(
    codec: ContentStoreCodecId,
    bytes: Uint8Array
  ): Promise<ContentStoreObjectRef> {
    const copied = Uint8Array.from(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copied.buffer));
    const object = contentStoreRefForSha256(STORE_ID, codec, bytesToHex(digest));
    this.#objects.set(objectRefKey(object), copied);
    return cloneObjectRef(object);
  }

  async loadRepository(ref: GadRepositoryDatabaseRefV1): Promise<GadRepositoryImageV1> {
    const value = this.images.get(ref.commitHash);
    if (value === undefined) throw new Error(`Unknown shadow repository: ${ref.commitHash}`);
    return structuredClone(value);
  }

  async loadWorking(_ref: GadWorkingDatabaseRefV1): Promise<never> {
    throw new Error("Shadow fixture has no working input");
  }

  async finalizeRepository(
    request: GadFinalizeRepositoryRequestV1
  ): Promise<GadRepositoryDatabaseRefV1> {
    const output = this.databases.getOutput("repository_out");
    if (output === null) throw new Error("Shadow repository output missing");
    output.execute(`-- shadow finalize ${request.physicalPurpose}`);
    const commitHash = asGadDoltCommitHash(
      output.commit({
        message: request.intent.message,
        authorName: request.intent.actorRef,
        authorEmail: "shadow@gad.invalid",
        timestamp: request.intent.logicalTime.slice(0, 19),
      })
    );
    const ref: GadRepositoryDatabaseRefV1 = {
      kind: "gad.repositoryDatabase",
      database: canonicalizeGadObjectRefV1({
        storeId: STORE_ID,
        codec: DATABASE_CODEC,
        contentId: {
          algorithm: 0x30_0101,
          digest: bytesFromHex(hexByte(0x80 + this.#generated.size, 20)),
        },
      }),
      commitHash,
    };
    this.images.set(commitHash, structuredClone(request.image));
    this.#generated.add(commitHash);
    this.finalizedCommits.push(commitHash);
    return ref;
  }

  async finalizeWorking(_request: GadFinalizeWorkingRequestV1): Promise<never> {
    throw new Error("Shadow fixture did not produce working state");
  }

  async mergeExact(request: GadExactMergeAdapterRequestV1) {
    this.mergeCalls.push(structuredClone(request));
    const theirs = await this.loadRepository(request.theirs);
    const intents = new Map(
      [...request.oursImage.commitIntents, ...theirs.commitIntents, request.intent].map((item) => [
        item.commitIntentId,
        item,
      ])
    );
    return {
      status: "clean" as const,
      baseCommitHash: null,
      parents: [request.ours.commitHash, request.theirs.commitHash],
      image: {
        schemaVersion: 1 as const,
        files: [],
        edits: [],
        hunks: [],
        commitIntents: [...intents.values()],
        headCommitIntentId: request.intent.commitIntentId,
      },
      provisionalWorking: null,
      conflicts: [],
    };
  }

  selectRepository(
    ref: GadRepositoryDatabaseRefV1
  ): DatabaseReducerInputHandle | DatabaseReducerOutputHandle {
    if (this.#generated.has(ref.commitHash)) {
      const output = this.databases.getOutput("repository_out");
      if (output === null) throw new Error("Shadow repository output missing");
      return output;
    }
    for (const logicalName of this.databases.inputNames) {
      const input = this.databases.getInput(logicalName);
      if (input !== null && this.images.has(ref.commitHash)) return input;
    }
    throw new Error("Unknown shadow repository selection");
  }

  selectWorking(_ref: GadWorkingDatabaseRefV1): never {
    throw new Error("Shadow fixture did not select working state");
  }
}

class MemoryInput implements DatabaseReducerInputHandle {
  constructor(
    readonly logicalName: string,
    readonly sqlAlias: string
  ) {}
  queryText(_sql: string): string {
    return "";
  }
}

class MemoryOutput implements DatabaseReducerOutputHandle {
  #commitOrdinal = 0;
  #dirty = false;
  #headCommit = asGadDoltCommitHash(hexByte(0x60, 20));

  constructor(
    readonly logicalName: string,
    readonly sqlAlias: string
  ) {}

  get status(): DatabaseReducerOutputStatus {
    return {
      logicalName: this.logicalName,
      sqlAlias: this.sqlAlias,
      headCommit: this.#headCommit,
      stateDigest: hexByte(0x70 + this.#commitOrdinal, 20),
      dirty: this.#dirty,
    };
  }

  queryText(_sql: string): string {
    return "";
  }

  execute(_sql: string): void {
    this.#dirty = true;
  }

  commit(_options: DatabaseReducerCommitOptions): string {
    this.#commitOrdinal += 1;
    this.#headCommit = asGadDoltCommitHash(hexByte(0x60 + this.#commitOrdinal, 20));
    this.#dirty = false;
    return this.#headCommit;
  }
}

class MemoryDatabases implements DatabaseReducerDatabasesHandle {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];

  constructor(
    private readonly inputs: ReadonlyMap<string, MemoryInput>,
    private readonly outputs: ReadonlyMap<string, MemoryOutput>
  ) {
    this.inputNames = [...inputs.keys()];
    this.outputNames = [...outputs.keys()];
  }

  getInput(logicalName: string): MemoryInput | null {
    return this.inputs.get(logicalName) ?? null;
  }

  getOutput(logicalName: string): MemoryOutput | null {
    return this.outputs.get(logicalName) ?? null;
  }
}

class InMemoryWorkerdHost implements GadWorkerdHostTransportV1 {
  loseNextRunResponse = false;
  runCount = 0;
  followCount = 0;
  reducerObservedPublicationCapability = false;
  readonly publications: GadWorkerdPublicationIntentV1[] = [];
  readonly #completed = new Map<string, WorkerdDatabaseReducerRunResult>();

  constructor(private readonly module: GadRepositoryReducerWorkerModule) {}

  async run(request: GadWorkerdTransportRunRequest): Promise<WorkerdDatabaseReducerRunResult> {
    this.runCount += 1;
    const inputs = new Map(
      request.options.inputs.map((input) => [
        input.logicalName,
        new MemoryInput(input.logicalName, input.sqlAlias),
      ])
    );
    const outputs = new Map(
      request.options.outputs.map((output) => [
        output.logicalName,
        new MemoryOutput(output.logicalName, output.sqlAlias),
      ])
    );
    const context: DatabaseReducerInvocationContextHandle = {
      cas: {
        get: async () => null,
        has: async () => false,
        put: async () => {
          throw new Error("Shadow Gad reducer does not use invocation CAS directly");
        },
      },
      waitUntil: (_promise) => undefined,
      randomBytes: () => {
        throw new Error("Shadow Gad reducer does not use random bytes");
      },
    };
    this.reducerObservedPublicationCapability = "publish" in context;
    const result = await this.module.reduce(
      new MemoryDatabases(inputs, outputs),
      decodeDatabaseReducerByteString(request.options.canonicalInput),
      {},
      context
    );
    const response = this.completeResult(result, request, inputs, outputs);
    this.#completed.set(bytesToHex(request.executionKey), response);
    if (this.loseNextRunResponse) {
      this.loseNextRunResponse = false;
      throw new Error("AMBIGUOUS_SHADOW_RESPONSE_LOSS");
    }
    return response;
  }

  async follow(executionKey: Uint8Array): Promise<WorkerdDatabaseReducerRunResult | null> {
    this.followCount += 1;
    return this.#completed.get(bytesToHex(executionKey)) ?? null;
  }

  async publish(request: GadWorkerdPublicationIntentV1): Promise<GadWorkerdPublicationResultV1> {
    this.publications.push(structuredClone(request));
    return {
      status: "published",
      generation: 1n,
      current: structuredClone(request.selectedOutput),
    };
  }

  private completeResult(
    result: DatabaseReducerHandlerResult,
    request: GadWorkerdTransportRunRequest,
    inputs: ReadonlyMap<string, MemoryInput>,
    outputs: ReadonlyMap<string, MemoryOutput>
  ): WorkerdDatabaseReducerRunResult {
    if (!(result.output instanceof Uint8Array)) throw new Error("Gad application bytes required");
    const databases: WorkerdDatabaseReducerRunDatabase[] = Object.entries(result.databases).map(
      ([logicalName, handle], resultIndex) => {
        const inputPlan = request.options.inputs.find(
          (input) => inputs.get(input.logicalName) === handle
        );
        if (inputPlan !== undefined) {
          return {
            logicalName,
            sqlAlias: handle.sqlAlias,
            database: structuredClone(inputPlan.database),
          };
        }
        const outputPlan = request.options.outputs.find(
          (output) => outputs.get(output.logicalName) === handle
        );
        if (outputPlan === undefined || !(handle instanceof MemoryOutput)) {
          throw new Error("Unknown selected shadow database handle");
        }
        const source = request.options.inputs.find(
          (input) => input.logicalName === outputPlan.sourceInput
        );
        const base = source?.database ?? request.options.inputs[0]?.database;
        if (base === undefined) throw new Error("Shadow output has no database template");
        return {
          logicalName,
          sqlAlias: handle.sqlAlias,
          database: {
            ...structuredClone(base),
            repositoryRoot: {
              ...structuredClone(base.repositoryRoot),
              digest: hexByte(0xa0 + resultIndex, 20),
            },
            commitHash: handle.status.headCommit,
            stateDigest: handle.status.stateDigest,
          },
        };
      }
    );
    return {
      databases,
      canonicalOutput: encodeDatabaseReducerByteString(result.output),
    };
  }
}
