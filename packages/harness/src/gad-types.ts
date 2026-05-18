export type GadJsonRecord = Record<string, unknown>;

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

export type GadEventKind =
  | "file_observation_recorded"
  | "file_mutation_planned"
  | "file_mutation_observed"
  | "dispatch_pending"
  | "dispatch_resolved"
  | "dispatch_abandoned"
  | "approval_requested"
  | "approval_resolved"
  | "credential_interruption"
  | "branch_event"
  | "system_event"
  | "claim_recorded"
  | "theory_updated"
  | "contradiction_recorded";

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
  kind: GadEventKind;
  anchorKind?: string | null;
  anchorId?: string | null;
  payload: GadJsonRecord;
  metadata?: GadJsonRecord | null;
}

export type GadJournalItemSpec = PiEntrySpec | GadEventSpec;

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

export interface AppendPiEntryBatchInput {
  branchId: string;
  expectedHeadEntryHash?: string | null;
  expectedStateHash?: string | null;
  items: PiEntrySpec[];
}

export interface AppendPiEntryBatchResult extends PiBranchHead {
  items: Array<{
    entryId: string;
    entryHash: string;
    parentEntryId: string | null;
  }>;
}
