/**
 * Structural snapshot of the generic database-reducer API consumed by the Gad bundle.
 *
 * This package deliberately does not import a generated workerd package. The application release
 * pins that generated surface and checks it against these transport-neutral shapes.
 */

export type DatabaseReducerValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | Uint8Array
  | readonly DatabaseReducerValue[]
  | { readonly [key: string]: DatabaseReducerValue };

export interface DatabaseReducerCommitOptions {
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly timestamp: string;
}

export interface DatabaseReducerOutputStatus {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly headCommit: string;
  readonly stateDigest: string;
  readonly dirty: boolean;
}

export interface DatabaseReducerInputHandle {
  readonly logicalName: string;
  readonly sqlAlias: string;
  queryText(sql: string): string;
}

export interface DatabaseReducerOutputHandle {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly status: DatabaseReducerOutputStatus;
  queryText(sql: string): string;
  execute(sql: string): void;
  commit(options: DatabaseReducerCommitOptions): string;
}

export interface DatabaseReducerDatabasesHandle {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  getInput(logicalName: string): DatabaseReducerInputHandle | null;
  getOutput(logicalName: string): DatabaseReducerOutputHandle | null;
}

export interface DatabaseReducerCasPutOptions {
  readonly codecNumber: number;
  readonly codecVersion: number;
}

export interface DatabaseReducerPureCasHandle {
  get(object: WorkerdDatabaseReducerObjectRefValue): Promise<Uint8Array>;
}

export interface DatabaseReducerStandardCasHandle {
  get(object: WorkerdDatabaseReducerObjectRefValue): Promise<Uint8Array | null>;
  has(object: WorkerdDatabaseReducerObjectRefValue): Promise<boolean>;
  put(
    bytes: Uint8Array,
    options: DatabaseReducerCasPutOptions
  ): Promise<WorkerdDatabaseReducerObjectRefValue>;
}

export interface DatabaseReducerInvocationContextHandle {
  readonly cas: DatabaseReducerPureCasHandle | DatabaseReducerStandardCasHandle;
  waitUntil(promise: Promise<void>): void;
  randomBytes(byteCount: number): Uint8Array;
}

export interface DatabaseReducerHandlerResult {
  readonly databases: Readonly<
    Record<string, DatabaseReducerInputHandle | DatabaseReducerOutputHandle>
  >;
  readonly output: DatabaseReducerValue;
}

export interface DatabaseReducerWorkerModule<Env = unknown> {
  reduce(
    databases: DatabaseReducerDatabasesHandle,
    input: unknown,
    env: Env,
    ctx: DatabaseReducerInvocationContextHandle
  ): Promise<DatabaseReducerHandlerResult>;
}

export interface WorkerdDatabaseReducerObjectRefValue {
  readonly storeId: string;
  readonly codecNumber: number;
  readonly codecVersion: number;
  readonly hashAlgorithm: string;
  readonly digest: string;
}

export interface WorkerdDatabaseReducerDatabaseRefValue {
  readonly repositoryRoot: WorkerdDatabaseReducerObjectRefValue;
  readonly doltFormatVersion: number;
  readonly commitHash: string;
  readonly stateFormatVersion: number;
  readonly stateDigest: string;
}

export interface WorkerdDatabaseReducerRunInput {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly database: WorkerdDatabaseReducerDatabaseRefValue;
}

export interface WorkerdDatabaseReducerRunOutputPlan {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly origin: "fork-input" | "create-canonical" | "pass-through-input";
  readonly sourceInput: string;
  readonly commit: DatabaseReducerCommitOptions;
}

export interface WorkerdDatabaseReducerRunOptions {
  readonly inputs: WorkerdDatabaseReducerRunInput[];
  readonly outputs: WorkerdDatabaseReducerRunOutputPlan[];
  readonly canonicalInput: Uint8Array;
}

export interface WorkerdDatabaseReducerRunDatabase {
  readonly logicalName: string;
  readonly sqlAlias: string;
  readonly database: WorkerdDatabaseReducerDatabaseRefValue;
}

export interface WorkerdDatabaseReducerRunResult {
  readonly databases: WorkerdDatabaseReducerRunDatabase[];
  readonly canonicalOutput: Uint8Array;
}

export interface WorkerdDatabaseReducerGeneratedBinding {
  run(options: WorkerdDatabaseReducerRunOptions): Promise<WorkerdDatabaseReducerRunResult>;
}
