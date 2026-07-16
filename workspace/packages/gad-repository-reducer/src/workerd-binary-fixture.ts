import {
  SHA2_256_HASH_ALGORITHM,
  bytesFromHex,
  bytesToHex,
  type ContentStoreCodecId,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { VIBE_BLOB_CODEC } from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { canonicalizeGadObjectRefV1 } from "@workspace/gad-repository-contract";
import {
  asGadDoltCommitHash,
  createGadRepositoryReducerWorkerModule,
  type DatabaseReducerDatabasesHandle,
  type DatabaseReducerInputHandle,
  type DatabaseReducerInvocationContextHandle,
  type DatabaseReducerOutputHandle,
  type DatabaseReducerStandardCasHandle,
  type GadExactMergeAdapterRequestV1,
  type GadFinalizeRepositoryRequestV1,
  type GadFinalizeWorkingRequestV1,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryImageV1,
  type GadRepositoryReducerHostAdapterV1,
  type GadRepositoryReducerWorkerAdapterV1,
  type GadRepositoryReducerWorkerSessionV1,
  type GadWorkingDatabaseRefV1,
  type GadWorkingImageV1,
  type WorkerdDatabaseReducerObjectRefValue,
} from "./index.js";

const STORE_ID = new TextEncoder().encode("gad-workerd-fixture");

class BinaryImportAdapter implements GadRepositoryReducerWorkerAdapterV1 {
  open(input: {
    readonly databases: DatabaseReducerDatabasesHandle;
    readonly invocation: DatabaseReducerInvocationContextHandle;
  }): GadRepositoryReducerWorkerSessionV1 {
    // Publication and follow are caller-binding capabilities. A successful real-binary fixture
    // therefore proves that the reducer invocation surface did not grow either authority.
    if (
      "follow" in input.invocation ||
      "publish" in input.invocation ||
      "publishOutput" in input.invocation
    ) {
      throw new Error("GAD_BINARY_REDUCER_RECEIVED_CALLER_AUTHORITY");
    }
    return new BinaryImportSession(input.databases, requireStandardCas(input.invocation.cas));
  }
}

class BinaryImportSession
  implements GadRepositoryReducerWorkerSessionV1, GadRepositoryReducerHostAdapterV1
{
  readonly host: GadRepositoryReducerHostAdapterV1 = this;
  readonly #generated = new Set<string>();

  constructor(
    private readonly databases: DatabaseReducerDatabasesHandle,
    private readonly cas: DatabaseReducerStandardCasHandle
  ) {}

  getContentStoreId(): Uint8Array {
    return STORE_ID.slice();
  }

  async readExactObject(object: ContentStoreObjectRef): Promise<Uint8Array | null> {
    return await this.cas.get(toNativeRef(object));
  }

  async putExactObject(
    codec: ContentStoreCodecId,
    bytes: Uint8Array
  ): Promise<ContentStoreObjectRef> {
    return fromNativeRef(
      await this.cas.put(bytes, { codecNumber: codec.number, codecVersion: codec.version })
    );
  }

  async loadRepository(_ref: GadRepositoryDatabaseRefV1): Promise<GadRepositoryImageV1> {
    throw new Error("BINARY_IMPORT_FIXTURE_DOES_NOT_LOAD_REPOSITORIES");
  }

  async loadWorking(_ref: GadWorkingDatabaseRefV1): Promise<GadWorkingImageV1> {
    throw new Error("BINARY_IMPORT_FIXTURE_DOES_NOT_LOAD_WORKING_STATE");
  }

  async finalizeRepository(
    request: GadFinalizeRepositoryRequestV1
  ): Promise<GadRepositoryDatabaseRefV1> {
    const output = this.databases.getOutput("repository_out");
    if (output === null) throw new Error("GAD_BINARY_REPOSITORY_OUTPUT_MISSING");
    const imageObject = await this.putExactObject(
      VIBE_BLOB_CODEC,
      new TextEncoder().encode(canonicalJson(request.image))
    );
    output.execute(
      "CREATE TABLE gad_repository_fixture(" +
        "id INTEGER PRIMARY KEY, image_digest TEXT NOT NULL, intent_id TEXT NOT NULL)"
    );
    output.execute(
      `INSERT INTO gad_repository_fixture VALUES (1, ${sqlText(
        bytesToHex(imageObject.contentId.digest)
      )}, ${sqlText(request.intent.commitIntentId)})`
    );
    const commitHash = asGadDoltCommitHash(
      output.commit({
        message: request.intent.message,
        authorName: request.intent.actorRef,
        authorEmail: "workerd-fixture@gad.invalid",
        timestamp: request.intent.logicalTime.slice(0, 19),
      })
    );
    this.#generated.add(commitHash);
    return {
      kind: "gad.repositoryDatabase",
      database: canonicalizeGadObjectRefV1(imageObject),
      commitHash,
    };
  }

  async finalizeWorking(_request: GadFinalizeWorkingRequestV1): Promise<GadWorkingDatabaseRefV1> {
    throw new Error("BINARY_IMPORT_FIXTURE_DOES_NOT_FINALIZE_WORKING_STATE");
  }

  async mergeExact(_request: GadExactMergeAdapterRequestV1): Promise<never> {
    throw new Error("BINARY_IMPORT_FIXTURE_DOES_NOT_MERGE");
  }

  selectRepository(
    ref: GadRepositoryDatabaseRefV1
  ): DatabaseReducerInputHandle | DatabaseReducerOutputHandle {
    if (!this.#generated.has(ref.commitHash)) {
      throw new Error("GAD_BINARY_REPOSITORY_SELECTION_UNKNOWN");
    }
    const output = this.databases.getOutput("repository_out");
    if (output === null) throw new Error("GAD_BINARY_REPOSITORY_OUTPUT_MISSING");
    return output;
  }

  selectWorking(
    _ref: GadWorkingDatabaseRefV1
  ): DatabaseReducerInputHandle | DatabaseReducerOutputHandle {
    throw new Error("BINARY_IMPORT_FIXTURE_HAS_NO_WORKING_SELECTION");
  }
}

function requireStandardCas(
  cas: DatabaseReducerInvocationContextHandle["cas"]
): DatabaseReducerStandardCasHandle {
  if (!("has" in cas) || !("put" in cas)) {
    throw new Error("GAD_BINARY_STANDARD_CAS_REQUIRED");
  }
  return cas;
}

function toNativeRef(object: ContentStoreObjectRef): WorkerdDatabaseReducerObjectRefValue {
  if (object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM) {
    throw new Error("GAD_BINARY_FIXTURE_SUPPORTS_SHA2_CAS_OBJECTS_ONLY");
  }
  return {
    storeId: bytesToHex(object.storeId),
    codecNumber: object.codec.number,
    codecVersion: object.codec.version,
    hashAlgorithm: "sha2-256",
    digest: bytesToHex(object.contentId.digest),
  };
}

function fromNativeRef(object: WorkerdDatabaseReducerObjectRefValue): ContentStoreObjectRef {
  if (object.hashAlgorithm !== "sha2-256") {
    throw new Error("GAD_BINARY_FIXTURE_RECEIVED_NON_SHA2_CAS_OBJECT");
  }
  return {
    storeId: bytesFromHex(object.storeId),
    codec: { number: object.codecNumber, version: object.codecVersion },
    contentId: {
      algorithm: SHA2_256_HASH_ALGORITHM,
      digest: bytesFromHex(object.digest),
    },
  };
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export default createGadRepositoryReducerWorkerModule(new BinaryImportAdapter());
