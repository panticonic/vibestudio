import type { RpcCaller } from "@natstack/rpc";
import { createGadServiceClient } from "@natstack/shared/userlandServiceRpc";

export { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@natstack/shared/userlandServiceRpc";

export type GadSqlBinding = null | string | number | boolean | Uint8Array;
export type GadJsonRecord = Record<string, unknown>;
export interface GadSqlResult {
    rows: GadJsonRecord[];
}
export interface GadStatusMetric {
    metric: string;
    value: number;
}

export type PiEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export interface PiEntrySpec {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  payload: GadJsonRecord;
  preStateHash?: string | null;
  postStateHash?: string | null;
  actor?: string | null;
  metadata?: GadJsonRecord | null;
}

export interface GadEventSpec {
  eventId: string;
  kind: string;
  anchorKind?: string | null;
  anchorId?: string | null;
  payload: GadJsonRecord;
  metadata?: GadJsonRecord | null;
}

export interface PiBranchHead {
  branchId: string;
  headEntryId: string | null;
  headEntryHash: string | null;
  headStateHash: string;
}

export interface PiEntryRow {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  actor: string | null;
  entryHash: string;
  parentEntryHash: string | null;
  preStateHash: string;
  postStateHash: string;
  payload: GadJsonRecord;
  metadata: GadJsonRecord | null;
  createdAt: string;
}
export interface GadClient {
  rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  ensurePiBranch(input: { branchId: string; channelId?: string | null; metadata?: GadJsonRecord | null }): Promise<PiBranchHead>;
  getPiBranchHead(input: { branchId: string }): Promise<PiBranchHead>;
  appendPiEntryBatch(input: {
    branchId: string;
    expectedHeadEntryHash?: string | null;
    expectedStateHash?: string | null;
    items: PiEntrySpec[];
  }): Promise<PiBranchHead & { items: Array<{ entryId: string; entryHash: string; parentEntryId: string | null }> }>;
  appendGadEvents(input: { events: GadEventSpec[] }): Promise<{ eventIds: string[] }>;
  listGadEvents(input?: { anchorKind?: string | null; anchorId?: string | null; kind?: string | null; limit?: number | null }): Promise<GadJsonRecord[]>;
  setBranchHead(input: { branchId: string; entryId: string | null; expectedHeadEntryHash?: string | null }): Promise<PiBranchHead>;
  getEntryById(input: { entryId: string }): Promise<PiEntryRow | null>;
  getBranchPath(input: { branchId: string; throughEntryId?: string | null; raw?: boolean | null }): Promise<PiEntryRow[]>;
  findEntries(input: { branchId: string; entryType: PiEntryType; offset?: number | null; limit?: number | null; raw?: boolean | null }): Promise<PiEntryRow[]>;
  materializePiMessages(input: { branchId: string }): Promise<{ messages: GadJsonRecord[] }>;
  listGadBranchToolCalls(input: { branchId: string; limit?: number | null }): Promise<GadJsonRecord[]>;
  forkPiBranch(input: { sourceBranchId: string; newBranchId?: string | null; entryId?: string | null; stateHash?: string | null; channelId?: string | null }): Promise<PiBranchHead>;
  listPiBranches(input?: object): Promise<GadJsonRecord[]>;
  listGadBranchFiles(input: { branchId: string }): Promise<GadJsonRecord[]>;
  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): Promise<{ added: GadJsonRecord[]; removed: GadJsonRecord[]; changed: GadJsonRecord[] }>;
  readGadFileAtState(input: { stateHash: string; path: string }): Promise<GadJsonRecord | null>;
  getGadToolProvenance(input: { toolCallId: string }): Promise<GadJsonRecord | null>;
  getGadStateProducer(input: { stateHash: string }): Promise<GadJsonRecord | null>;
  blameGadFileSnippet(input: { stateHash?: string | null; fileVersionId?: number | null; path: string }): Promise<GadJsonRecord[]>;
  enqueueGadIndexJob(input: { sourceHash: string; sourceKind: string; jobKind: string }): Promise<{ id: number }>;
  processGadIndexJobs(input?: { limit?: number | null }): Promise<{ processed: number }>;
  claimGadIndexJobs(input?: { limit?: number | null }): Promise<GadJsonRecord[]>;
  completeGadIndexJob(input: { id: number }): Promise<GadJsonRecord>;
  failGadIndexJob(input: { id: number; error: string; retry?: boolean | null }): Promise<GadJsonRecord>;
  listGadIndexJobs(input?: { status?: string | null; limit?: number | null }): Promise<GadJsonRecord[]>;
  validateGadHashes(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  clearDirtyAfterValidation(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  checkGadIntegrity(input?: object): Promise<{ ok: boolean; errors: GadJsonRecord[] }>;
  replayGadEvents(input?: object): Promise<{ replayed: number }>;
}
export function createGadClient(rpc: RpcCaller): GadClient {
  const service = createGadServiceClient(rpc);
  const call = <T>(method: string, ...args: unknown[]) => service.call<T>(method, ...args);

  return {
    rawSql: (sql, bindings) => call("rawSql", sql, bindings),
    query: (sql, bindings) => call("query", sql, bindings),
    status: () => call("getStatus"),
    ensureBlob: (hash, size, mimeType) => call("ensureBlob", hash, size, mimeType),
    ensurePiBranch: (input) => call("ensurePiBranch", input),
    getPiBranchHead: (input) => call("getPiBranchHead", input),
    appendPiEntryBatch: (input) => call("appendPiEntryBatch", input),
    appendGadEvents: (input) => call("appendGadEvents", input),
    listGadEvents: (input) => call("listGadEvents", input),
    setBranchHead: (input) => call("setBranchHead", input),
    getEntryById: (input) => call("getEntryById", input),
    getBranchPath: (input) => call("getBranchPath", input),
    findEntries: (input) => call("findEntries", input),
    materializePiMessages: (input) => call("materializePiMessages", input),
    listGadBranchToolCalls: (input) => call("listGadBranchToolCalls", input),
    forkPiBranch: (input) => call("forkPiBranch", input),
    listPiBranches: (input) => call("listPiBranches", input),
    listGadBranchFiles: (input) => call("listGadBranchFiles", input),
    diffGadStates: (input) => call("diffGadStates", input),
    readGadFileAtState: (input) => call("readGadFileAtState", input),
    getGadToolProvenance: (input) => call("getGadToolProvenance", input),
    getGadStateProducer: (input) => call("getGadStateProducer", input),
    blameGadFileSnippet: (input) => call("blameGadFileSnippet", input),
    enqueueGadIndexJob: (input) => call("enqueueGadIndexJob", input),
    processGadIndexJobs: (input) => call("processGadIndexJobs", input),
    claimGadIndexJobs: (input) => call("claimGadIndexJobs", input),
    completeGadIndexJob: (input) => call("completeGadIndexJob", input),
    failGadIndexJob: (input) => call("failGadIndexJob", input),
    listGadIndexJobs: (input) => call("listGadIndexJobs", input),
    validateGadHashes: (input) => call("validateGadHashes", input),
    clearDirtyAfterValidation: (input) => call("clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => call("checkGadIntegrity", input),
    replayGadEvents: (input) => call("replayGadEvents", input),
  };
}
