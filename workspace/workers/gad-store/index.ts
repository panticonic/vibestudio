import { DurableObjectBase, rpc } from "@workspace/runtime/worker";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  assertAgenticEventStoredValuesEncoded,
  brandId,
  collectStoredValueRefs,
  publicActorRef,
  publicParticipantMetadata,
  publicParticipantRef,
  sanitizeAgenticEventParticipantRefs,
  storedAgenticEventSchema,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type InvocationId,
  type LogEnvelope,
  type LogEventCausality,
  type LogKind,
  type ParticipantRef,
  type ParticipantSelector,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";
import {
  gadAppendErrorMessage,
  logEnvelopeHashPreimage,
  logEnvelopeSemantic,
  type AppendIdempotency,
  manifestHashForEntries,
  sha256HexSyncText,
  sortForCanonicalJson,
  canonicalJson,
  stateHashForRoot,
  EMPTY_MANIFEST_HASH,
  EMPTY_STATE_HASH,
  type LogEnvelopeSemanticInput,
} from "@workspace/agentic-protocol";
import {
  EditEngine,
  MergeEngine,
  blameChain,
  decodeUtf8Text,
  discoverRepoPaths,
  hasConflictMarkers,
  type BlameOpRow,
  type BlameResolution,
  type EditOp as VcsEditOp,
  type MergeComputation,
  type MergeHunk,
  type StateFileEntry,
  type WorkingFileEntry,
} from "@workspace/vcs-engine";

/** A provenance edit-op minted for a main-advance / merge commit (the shape
 *  {@link IngestWorktreeStateInput.editOps} expects). */
type ProvenanceEditOp = {
  kind: "replace" | "create" | "delete" | "chmod";
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  hunks?: unknown;
  mode?: number | null;
  synthetic?: boolean;
};

/** One repo's slice of a write-ahead publish intent (§6): everything needed to
 *  reconstruct the provenance commit for a main advance whose ref CAS already
 *  landed but whose provenance was not yet recorded (crash window). */
interface PublishIntentEntry {
  repoPath: string;
  logId: string;
  /** The main state the CAS swapped FROM (null = repo creation). */
  expectedOld: string | null;
  /** The main state the CAS swapped TO (the candidate). */
  next: string;
  /** Second-parent event/state (the pushed ctx commit / merge source). */
  parentEventId: string | null;
  parentStateHash: string | null;
  files: Array<{ path: string; contentHash: string; mode: number }>;
  editOps: ProvenanceEditOp[];
  /** Provenance ops are synthetic (for example import snapshots) — skip chain checks. */
  synthetic?: boolean;
}

interface PublishIntent {
  intentId: string;
  operation: "push" | "import";
  entries: PublishIntentEntry[];
  message?: string | null;
  actor?: ParticipantRef | null;
  sourceHead?: string | null;
}

/** The DO-side push result — mirrors the host push contract (and the shared
 *  `vcsPushResultSchema`) so in-tree callers keep working across the flip. */
type VcsPushResultDo =
  | { status: "pushed" | "up-to-date"; repoPaths: string[]; reports: unknown[] }
  | {
      status: "diverged";
      divergences: Array<{
        repoPath: string;
        base: string | null;
        mainTip: string | null;
        upstreamCommits: Array<{
          eventId: string;
          message: string;
          stateHash: string;
          createdAt: string | null;
        }>;
        mergeable: "clean" | "conflict";
        conflictPaths?: string[];
      }>;
    }
  | { status: "build-failed"; reports: unknown[] };

/** DO-side git-import publish result: the staged import tree either advanced
 *  the protected `main` or already matched it. */
type VcsImportPublishResultDo = {
  status: "published" | "up-to-date";
  repoPath: string;
  stateHash: string;
};

const SYSTEM_PARTICIPANT = { kind: "system", id: "system" } as unknown as ParticipantRef;

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;

interface GadGcRootsInput {
  rootStateHashes?: string[] | null;
  protectedBlobDigests?: string[] | null;
  protectedTreeDigests?: string[] | null;
}

const CHANNEL_LOG_HEAD = "main";

/** Valid agentic participant kinds (an actor.kind on a log event). Transport
 *  caller kinds (server/shell/do/worker) are NOT participant kinds. */
const PARTICIPANT_KINDS = new Set(["user", "agent", "system", "panel", "external"]);

/** Independent schema version for the durable knowledge ledger (§8.1). Bumped
 *  only when the ledger's own shape changes — decoupled from the DO's
 *  schemaVersion so the ledger migrates for real instead of being wiped. */
const KNOWLEDGE_LEDGER_VERSION = 1;

/** Claim dedup-on-write (§8.1 record_claim): FTS finds candidates, then a
 *  token-overlap ratio decides "near-duplicate" (corpus-magnitude-independent,
 *  so it is deterministic and test-stable). */
const CLAIM_DEDUP_TOP_K = 5;
const CLAIM_DEDUP_MIN_OVERLAP = 0.6;

/** Blame (design §5.2): cap the first-parent commit walk per chain, and the
 *  cross-parent `theirs` routing depth, so a query is O(reachable-for-path). */
const BLAME_MAX_COMMITS = 5000;
const BLAME_MAX_ROUTE_DEPTH = 8;
/** U2 standing chain check (checkGadIntegrity): most-recent committed ops
 *  examined per repo before the walk is capped. */
const CHAIN_CHECK_CAP = 5000;

/**
 * §6/§7/§12 provenance density + attachment tunables — the ONE authoritative
 * named-consts block the `provenance-tuning` skill (§12.1) points at. Every knob
 * is documented with its §12 name; tuning is proposal-then-human-approval, never
 * silent. Keep them here so the skill's pointer stays true.
 */
// §6.1 leg weights: rank(C) = w_sim·sim(C) + w_prov·idf(C)·Σ …
const PROV_W_SIM = 1.0; // §12 w_sim — recall (similarity) leg
const PROV_W_PROV = 1.0; // §12 w_prov — structural (provenance/density) leg
// §6.2 flat per-kind edge weights; magnitude is NEVER an input.
const PROV_KIND_WEIGHT = {
  edited: 1.0, // native invocation→file (gad_worktree_edit_ops)
  asserted: 1.0, // native invocation→claim (gad_claims)
  relation: 0.8, // native claim↔claim (gad_claim_relations)
  cited: 0.7, // soft session→claim (gad_touches kind='cited')
  observed: 0.5, // soft session→file (gad_touches kind='observed')
} as const;
// §6.3 decay basis: logical, two clocks (never the wall clock, never global seq).
const PROV_DECAY_SESSION_TURNS = 8; // session-recency leg: exp(-turnsAgo / 8)
const PROV_DECAY_HISTORICAL = 16; // historical leg: exp(-laterEdits / 16)
// §4.2/§12: soft-edge `hits` accumulate sublinearly (default sqrt).
const PROV_HITS_CURVE = (hits: number): number => Math.sqrt(Math.max(hits, 1));
// §6.5 caps that double as quality controls.
const PROV_SEED_CAP_K = 32; // K — last-K touch(S) seeds
const PROV_FANOUT_CAP_M = 12; // M — per-node fan-out (top by recency)
const PROV_CANDIDATE_CAP_N = 64; // N — candidate cap
// §7.5 salience floor: non-exception items render only above this; NO filler.
const PROV_SALIENCE_FLOOR = 0.15;
// §7.1 per-tier item budgets (items, not tokens; the tail is withheld+advertised).
const PROV_ITEM_BUDGET_MODERATE = 5;
const PROV_ITEM_BUDGET_DEEP = 10;
// §7.3 standalone compute ceiling; overrun degrades to the one-line hint.
const PROV_BUDGET_MS = 150;
// §7.3 warm precompute: moderate blocks for ≤ this many likely-next files.
const PROV_WARM_MAX_FILES = 8;

/** One rendered attachment line (§7.5): a bounded `insight + handle`. `kind`
 *  names the item class; `exception` sorts it first, above density; `score` is
 *  the §6.1 rank (0 for exceptions — they render regardless). */
export interface ProvItem {
  line: string;
  handle: string;
  kind: string;
  exception: boolean;
  score: number;
}

/** The §7.1 read-attachment / drill-down page. `total` is the full ranked list
 *  (exceptions + floored density); `shown` this page. `suppressed` = the block
 *  signature was unchanged (§7.1); `degraded` = the compute overran the budget
 *  and returned the one-line hint (§7.3). */
export interface ProvenanceForFileResult {
  items: ProvItem[];
  shown: number;
  total: number;
  nextCursor?: string;
  suppressed: boolean;
  degraded?: boolean;
}

export interface ProvenanceForSessionResult {
  items: ProvItem[];
  shown: number;
  total: number;
  nextCursor?: string;
}

/** A spreading-activation node (a graph node reached during §6 density): a claim
 *  or a file, with an accumulating structural `prov` leg and a recall `sim` leg. */
interface ProvCand {
  kind: "claim" | "file" | "commit";
  id: string;
  sim: number;
  prov: number;
  recallRank: number;
  commitMessage?: string | null;
  turnsAgo?: number | null;
  coeditCount?: number;
}

/** A seed / frontier node in the bounded 2-hop walk: an activation carried from
 *  touch(S) outward along native + soft edges. */
interface ProvSeed {
  kind: "claim" | "file";
  id: string;
  activation: number;
}

interface ProvenanceCacheKey {
  logId: string;
  head: string;
  path: string;
  sessionLogId: string;
  sessionHead: string;
  recallKey: string;
  turnSeq: number;
  touchVersion: number;
  knowledgeVersion: number;
  contentStamp: string;
}

/** Tables that must exist before a schema version is recorded as ready
 *  (validated by DurableObjectBase after every createTables()). Lazily
 *  created tables (memory index) are deliberately absent. */
const GAD_REQUIRED_TABLES = [
  "log_heads",
  "log_events",
  "log_blob_refs",
  "gad_worktree_heads",
  "vcs_context_bases",
  "vcs_context_provenance",
  "refs",
  "ref_log",
  "trajectory_turns",
  "trajectory_messages",
  "trajectory_message_blocks",
  "trajectory_invocations",
  "trajectory_invocation_outputs",
  "trajectory_approvals",
  "trajectory_usage_rollups",
  "trajectory_checkpoints",
  "channel_message_types",
  "channel_roster",
  "gad_blobs",
  "gad_worktree_states",
  "gad_file_versions",
  "gad_manifest_nodes",
  "gad_manifest_entries",
  "gad_state_transitions",
  "gad_transition_parents",
  "gad_worktree_edit_ops",
  "gad_claims",
  "gad_claim_relations",
  "gad_knowledge_ledger",
  "gad_touches",
  "gad_provenance_cache",
  "gad_prov_metrics",
  "gad_prov_render_log",
  "gad_gc_candidates",
  "gad_publish_intents",
] as const;

/** Log kinds whose events are full agentic trajectory events (validated and
 *  projected). `log_kind` stays metadata for append/fork/replay/integrity —
 *  this set only gates content validation and projection dispatch. */
const AGENTIC_LOG_KINDS = new Set<string>(["trajectory", "vcs"]);

const TERMINAL_INVOCATION_KINDS = new Set([
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
]);

const STATE_TRANSITION_KINDS = new Set([
  "state.transition_recorded",
  "state.snapshot_ingested",
  "state.merge_applied",
]);

/**
 * GC creation-time grace period: values created within this window are never
 * collected, so multi-step flows (e.g. stageWorktreeState → setPendingMerge)
 * cannot lose freshly created values to a GC run that lands between steps.
 */
const GC_CREATION_GRACE_MS = 15 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Soft-state prune floors (§4.2, C6): the periodic server-driven pass ages out
 * behavioral touches and disposable render artifacts. All three are re-derivable
 * on demand, so the floors are relevance thresholds, not durability guarantees.
 */
// A single-hit touch older than this never accumulated repeat signal — background hum.
const TOUCH_PRUNE_AGE_MS = 45 * DAY_MS;
// The warm cache is pure disposable derived data (re-computed on a miss); age it
// out well before touches so a stale block never outlives its relevance.
const PROV_CACHE_PRUNE_AGE_MS = 7 * DAY_MS;
// The render-log is instrumentation-only (feeds the attachment-action counter),
// never a ranking input — a short retention is enough for the rate numerator.
const PROV_RENDER_LOG_PRUNE_AGE_MS = 14 * DAY_MS;

export interface LogAppendEventInput {
  envelopeId?: string | null;
  actor: ParticipantRef;
  to?: ParticipantRef[] | ParticipantSelector | null;
  payloadKind: string;
  payload: unknown;
  causality?: LogEventCausality | null;
  annotations?: Record<string, unknown> | null;
  appendedAt?: string | null;
  publish?: { channels: Array<{ channelId: string; audience?: unknown }> } | null;
}

export interface AppendLogEventInput {
  logId: string;
  head: string;
  logKind: LogKind | string;
  owner?: { kind: string; id: string } | null;
  expectedHeadHash?: string | null;
  /** Append idempotency intent — see AppendIdempotency in agentic-protocol.
   *  Default "exact": same-id-different-content is a hard integrity error.
   *  "idempotent-by-id" (client publish paths only): first write wins; the
   *  journaled original is returned in `envelopes` as a replay. */
  idempotency?: AppendIdempotency | null;
  events: LogAppendEventInput[];
}

export interface AppendLogEventResult {
  logId: string;
  head: string;
  headSeq: number;
  headHash: string;
  envelopes: LogEnvelope[];
  published: Array<{ originEnvelopeId: string; channelId: string; envelopeId: string }>;
}

export interface ForkLogInput {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  atSeq?: number | null;
  owner?: { kind: string; id: string } | null;
}

export interface ForkLogResult {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  forkSeq: number;
  forkHash: string;
  inherited: number;
}

export interface ReadLogInput {
  logId: string;
  head: string;
  afterSeq?: number | null;
  beforeSeq?: number | null;
  limit?: number | null;
  payloadKind?: string | null;
}

export interface LogHeadInfo {
  logId: string;
  head: string;
  logKind: string;
  seq: number;
  hash: string;
  envelopeId: string | null;
  forkSeq: number | null;
  forkHash: string | null;
  parentLogId: string | null;
  parentHead: string | null;
}

export interface RefRecord {
  refName: string;
  kind: string;
  target: unknown;
  updatedAt: string;
}

export interface WorktreeHeadRecord {
  logId: string;
  head: string;
  stateHash: string;
  commitEventId: string | null;
  updatedAt: string;
}

export interface IngestWorktreeStateInput {
  files: Array<{ path: string; contentHash: string; size?: number | null; mode?: number | null }>;
  baseStateHash?: string | null;
  parentStateHashes?: string[] | null;
  parentEventIds?: string[] | null;
  logId: string;
  head: string;
  logKind?: LogKind | string | null;
  expectedRefStateHash?: string | null;
  actor: ParticipantRef;
  summary?: string | null;
  eventId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Transition kind: ordinary snapshot (default) or a completed merge. */
  eventKind?: "state.snapshot_ingested" | "state.merge_applied" | null;
  /** The op union that authored this commit (provenance/intent), recorded in
   *  gad_worktree_edit_ops keyed to the transition event as COMMITTED rows
   *  (used by bootstrap/merge/fork commits — the working edit→commit path
   *  re-keys existing rows via {@link commitRepo} instead). */
  editOps?: Array<{
    kind: "replace" | "write" | "create" | "delete" | "chmod";
    path: string;
    oldContentHash?: string | null;
    newContentHash?: string | null;
    hunks?: unknown;
    mode?: number | null;
    /** P3/A2: a synthetic op (for example an import snapshot) carries no true
     *  first-parent hunks — blame treats it as a chain RESTART and the
     *  chain-continuity check skips it. */
    synthetic?: boolean | null;
    /** U1: the op's NEW content is binary (no line structure) — hunks are
     *  legitimately absent and blame chain-restarts. */
    binary?: boolean | null;
  }> | null;
  /** P3/A2 (blame invariant U2): when true, validate that each non-synthetic
   *  editOp's `oldContentHash` matches the file's content in the FIRST-PARENT
   *  tree (`baseStateHash`) — the ops compose against the first parent. Rejects
   *  on mismatch. Set by the DO push/merge provenance paths; left off for
   *  bootstrap/fork ingests whose base may not be locally resolvable. */
  validateFirstParentChain?: boolean | null;
  /** Causality (agent turn / tool-call that authored this commit) — recorded on
   *  the edit-op rows so VCS provenance ties to the agentic trajectory. */
  invocationId?: string | null;
  turnId?: string | null;
}

// ---------------------------------------------------------------------------
// Legacy adapter shapes (deleted in the Stage B cut along with the adapters)
// ---------------------------------------------------------------------------

export interface TrajectoryAppendItem {
  event: AgenticEvent;
  eventId?: string | null;
  publish?: {
    channelIds: string[];
    audience?: unknown;
  } | null;
}

export interface AppendTrajectoryBatchInput {
  trajectoryId: string;
  branchId: string;
  owner: { kind: "agent"; id: string };
  expectedHeadEventHash?: string | null;
  events: TrajectoryAppendItem[];
}

export interface AppendTrajectoryBatchResult {
  trajectoryId: string;
  branchId: string;
  headEventId: string | null;
  headEventHash: string | null;
  headStateHash: string | null;
  events: TrajectoryEvent[];
  published: Array<{ eventId: string; channelId: string; envelopeId: string }>;
}

export interface ChannelPublication {
  eventId: string;
  trajectoryId: string;
  branchId: string;
  channelId: string;
  channelSeq: number;
  envelopeId: string;
  publishedAt: string;
}

export interface EnvelopeLineage {
  publication: ChannelPublication;
  envelope: ChannelEnvelope;
  trajectoryEvent: TrajectoryEvent;
}

export interface PublishedArtifact {
  lineage: EnvelopeLineage;
}

export interface PrivateLineageForPublishedEnvelope {
  lineage: EnvelopeLineage;
  branchEvents: TrajectoryEvent[];
}

export interface ChannelReplayWindow {
  envelopes: ChannelEnvelope[];
  totalCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

export interface ChannelEnvelopeInspection {
  envelopeId: string;
  channelId: string;
  seq: number;
  payloadKind?: string;
  from: JsonRecord;
  metadata?: JsonRecord;
  bytes: {
    from: number;
    to: number;
    payload: number;
    metadata: number;
    attachments: number;
  };
  payloadSummary: unknown;
  storedRefs: JsonRecord[];
  publishedAt: string;
}

export interface PublicationIntegrityInspection {
  summary: {
    expectedMappings: number;
    missingMappings: number;
    orphanMappings: number;
    missingPublicationEvents: number;
    missingPublicationEnvelopes: number;
    sequenceMismatches: number;
    channelOriginAgenticEnvelopes: number;
  };
  rows: JsonRecord[];
}

export interface TurnStateInspection {
  summary: {
    branches: number;
    openTurns: number;
    streamingMessages: number;
    nonterminalInvocations: number;
    duplicateOpenedTurns: number;
  };
  rows: JsonRecord[];
}

export interface InvocationStateInspection {
  summary: {
    projected: number;
    startedEvents: number;
    terminalEvents: number;
    openProjectedInvocations: number;
  };
  rows: JsonRecord[];
}

export interface ChannelRosterInspection {
  summary: {
    rows: number;
    activeParticipants: number;
    inactiveParticipants: number;
  };
  rows: JsonRecord[];
}

export interface AgentHealthInspection {
  channelId: string;
  branchId: string;
  generatedAt: string;
  summary: {
    ok: boolean;
    publicationIssues: number;
    openTurns: number;
    streamingMessages: number;
    nonterminalInvocations: number;
    activeParticipants: number;
    storageIssues: number;
  };
  publicationIntegrity: PublicationIntegrityInspection;
  turnState: TurnStateInspection;
  invocationState: InvocationStateInspection;
  roster: ChannelRosterInspection;
  envelopes: { rows: ChannelEnvelopeInspection[] };
  storage: { rows: JsonRecord[] };
}

export interface ForkChannelLogInput {
  fromChannelId: string;
  toChannelId: string;
  throughSeq?: number | null;
}

export interface ForkChannelLogResult {
  fromChannelId: string;
  toChannelId: string;
  throughSeq: number | null;
  copied: number;
  firstSeq?: number;
  lastSeq?: number;
  lineage: Array<{
    sourceEnvelopeId: string;
    forkEnvelopeId: string;
    sourceSeq: number;
    forkSeq: number;
  }>;
}

export interface ForkTrajectoryBranchInput {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  throughSeq?: number | null;
  throughEventHash?: string | null;
  throughPublishedChannelId?: string | null;
  throughPublishedChannelSeq?: number | null;
  toPublishedChannelId?: string | null;
  owner?: { kind: "agent"; id: string } | null;
}

export interface ForkTrajectoryBranchResult {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  copied: number;
  headEventId: string | null;
  headEventHash: string | null;
  headStateHash: string | null;
  lineage: Array<{
    sourceEventId: string;
    forkEventId: string;
    sourceSeq: number;
    forkSeq: number;
    sourceEventHash: string;
    forkEventHash: string;
  }>;
}

export interface ChannelMessageTypeDefinition {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "code"; code: string } | { type: "file"; path: string };
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: Record<string, unknown>;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export type RegistryMutationInput =
  | {
      kind: "upsertMessageType";
      typeId: string;
      row: Omit<ChannelMessageTypeDefinition, "typeId" | "updatedAtSeq" | "clearedAtSeq">;
    }
  | { kind: "clearMessageType"; typeId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  return JSON.parse(value) as unknown;
}

function parseRecord(value: string | null | undefined): JsonRecord {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : {};
}

function readOnlySql(sql: string): boolean {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\n\r]*/gu, " ")
    .replace(/'(?:''|[^'])*'/gu, "''")
    .replace(/"(?:[^"]|"")*"/gu, '""')
    .trimStart();
  const verb = normalized.match(/^[A-Za-z]+/u)?.[0]?.toUpperCase();
  if (verb === "SELECT" || verb === "EXPLAIN" || verb === "PRAGMA") return true;
  if (verb !== "WITH") return false;
  if (!/\bSELECT\b/iu.test(normalized)) return false;
  return !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH)\b/iu.test(
    normalized
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

function stringPrefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const value = codePoints[index]!.codePointAt(0)!;
    if (value < 0x10ffff) {
      return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(value + 1)}`;
    }
  }
  return null;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid worktree-relative path: ${path}`);
  }
  return normalized;
}

/**
 * U1 (design §5.1) — the hunk-completeness invariant, enforced at INSERT time on
 * BOTH edit-op seams (the working {@link GadWorkspaceDO.insertWorkingEditRows}
 * and the ingest editOps path), not left to caller goodwill. An op that MUTATES
 * existing TEXT content must carry `hunks_json` so blame's offset composition
 * (§5.2) is exact. Hunks may be legitimately absent for `create`/`delete`/
 * `chmod`, binary content (marked on the row), explicitly-synthetic snapshot ops
 * (import/push/whole-file takes), and no-op writes (content hash unchanged). A
 * violating insert is a latent silent mis-blame — reject it loudly.
 */
function assertHunkCompleteness(
  op: {
    kind: string;
    oldContentHash?: string | null;
    newContentHash?: string | null;
    hunks?: unknown;
    binary?: boolean | null;
    synthetic?: boolean | null;
  },
  where: string
): void {
  if (op.kind !== "replace" && op.kind !== "write") return;
  const oldHash = op.oldContentHash ?? null;
  const newHash = op.newContentHash ?? null;
  // No prior content (a first write is a create) or an unchanged write (mode-only
  // / identical bytes) carries no line delta to record.
  if (oldHash === null || oldHash === newHash) return;
  if (op.binary || op.synthetic) return;
  if (op.hunks != null) return;
  throw new Error(
    `hunk-completeness violation (U1) at ${where}: ${op.kind} over existing text ` +
      `(${oldHash} → ${newHash ?? "∅"}) carries no hunks and is not binary/synthetic`
  );
}

/** Char span of each 1-based line, excluding the terminating newline. A trailing
 *  newline does not open an empty final line. */
function computeLineSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

/** Two adjacent lines share a blame resolution iff every attribution field
 *  matches — the coalescing key for contiguous ranges. */
function blameSameResolution(
  a: Omit<VcsBlameLineWire, "startLine" | "endLine">,
  b: Omit<VcsBlameLineWire, "startLine" | "endLine">
): boolean {
  return (
    a.opId === b.opId &&
    a.commitEventId === b.commitEventId &&
    a.kind === b.kind &&
    a.invocationId === b.invocationId &&
    a.turnId === b.turnId &&
    a.actorId === b.actorId &&
    a.degraded === b.degraded
  );
}

/** Coalesce per-line resolutions (line `fromLine + i`) into contiguous ranges. */
function coalesceBlameLines(
  fromLine: number,
  perLine: Array<Omit<VcsBlameLineWire, "startLine" | "endLine">>
): VcsBlameLineWire[] {
  const out: VcsBlameLineWire[] = [];
  perLine.forEach((r, i) => {
    const lineNo = fromLine + i;
    const prev = out[out.length - 1];
    if (prev && blameSameResolution(prev, r)) {
      prev.endLine = lineNo;
    } else {
      out.push({ startLine: lineNo, endLine: lineNo, ...r });
    }
  });
  return out;
}

function blameLinePriority(r: Omit<VcsBlameLineWire, "startLine" | "endLine">): number {
  const attribution = r.degraded === null ? 2 : r.opId !== null ? 1 : 0;
  return attribution * 1_000_000_000 + (r.opId ?? -1);
}

/** Pick the newest concrete attribution observed anywhere on the line. */
function representativeLineBlame(
  resolutions: Array<Omit<VcsBlameLineWire, "startLine" | "endLine">>
): Omit<VcsBlameLineWire, "startLine" | "endLine"> {
  let best = resolutions[0]!;
  for (const r of resolutions.slice(1)) {
    if (blameLinePriority(r) > blameLinePriority(best)) best = r;
  }
  return best;
}

/** Normalize a workspace-relative repo path (the `vcs:repo:<path>` key) —
 *  kept semantically identical to the host's normalizeRepoPathForLog. */
function normalizeRepoPathArg(repoPath: string): string {
  const normalized = repoPath.replace(/\\/gu, "/");
  if (!normalized) {
    throw new Error(`Invalid workspace repo path: ${repoPath}`);
  }
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid workspace repo path: ${repoPath}`);
    }
  }
  return normalized;
}

/** Per-repo VCS log id for a workspace repo path. */
const VCS_REPO_LOG_PREFIX = "vcs:repo:";
function logIdForRepoPath(repoPath: string): string {
  return `${VCS_REPO_LOG_PREFIX}${normalizeRepoPathArg(repoPath)}`;
}

function repoPathFromLogId(logId: string): string {
  return logId.startsWith(VCS_REPO_LOG_PREFIX) ? logId.slice(VCS_REPO_LOG_PREFIX.length) : logId;
}

/** §4.2/§9 file-node id: the (vcs log, repo-relative path) pair a `file` touch
 *  and the native `edited`/`committed_in` edges share — encoded exactly as the
 *  `edge_graph` view builds it (`log_id || char(1) || path`) so a file has ONE
 *  identity across native + soft edges. The separator is U+0001 (never U+0000 —
 *  SQLite truncates a TEXT value at its first NUL byte) and cannot occur in a
 *  log id or path. */
const FILE_NODE_SEP = "\u0001";
function fileNodeId(logId: string, path: string): string {
  return `${logId}${FILE_NODE_SEP}${path}`;
}
function parseFileNodeId(id: string): { logId: string; path: string } | null {
  const i = id.indexOf(FILE_NODE_SEP);
  if (i < 0) return null;
  return { logId: id.slice(0, i), path: id.slice(i + 1) };
}
/** The workspace-relative handle path for a file node (what the read tool and
 *  `provenance("<path>")` follow-on use). */
function fileHandlePath(logId: string, path: string): string {
  return `${repoPathFromLogId(logId)}/${path}`;
}

/** Protected `main` head + the active-context checkout head (`ctx:workspace`,
 *  D1/D2) + the archived-lineage prefix — the head names the delete/restore/fork
 *  DO sagas drive against the host primitives. */
const VCS_MAIN = "main";
const VCS_ACTIVE_CONTEXT_HEAD = "ctx:workspace";
const VCS_ARCHIVE_HEAD_PREFIX = "archived:";

/** Re-root a repo-relative path under its workspace repo prefix (kept identical
 *  to the host's `joinRepoPrefix`). */
function joinRepoPrefixPath(repoPath: string, relPath: string): string {
  const norm = normalizeRepoPathArg(repoPath);
  return relPath ? `${norm}/${relPath}` : norm;
}

/**
 * Rewrite a `package.json` `name` leaf to the fork's destination path, preserving
 * the existing scope (e.g. `"@workspace-panels/chat"` + `"panels/mychat"` →
 * `"@workspace-panels/mychat"`). Returns the new JSON text, or `null` if it can't
 * parse or has no string `name`. Ported from the host so the fork rename is a
 * DO-owned bootstrap commit (narrow-host boundary refactor Phase 4).
 */
function renameWorkspacePackage(jsonText: string, toPath: string): string | null {
  let pkg: { name?: unknown } & Record<string, unknown>;
  try {
    pkg = JSON.parse(jsonText) as { name?: unknown } & Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof pkg.name !== "string") return null;
  const leaf = toPath.split("/").pop() ?? toPath;
  const slash = pkg.name.lastIndexOf("/");
  pkg.name = slash >= 0 ? `${pkg.name.slice(0, slash + 1)}${leaf}` : leaf;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// ── Host content-store / refs access (P5b merge engine, P5c edit engine) ────

/** One recursive tree-listing entry from the host content store. */
interface HostTreeListEntry {
  path: string;
  kind: string;
  contentHash?: string;
  mode?: number;
}

/** One directory-node entry for `putTree` (the content store's wire shape). */
type HostTreeEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

/**
 * The slice of the host `blobstore.*` RPC surface the VCS engines need:
 * mirrored tree listings for states this store has not recorded, blob bytes
 * (base64 on the wire — workerd has no Buffer), and tree writes so states
 * COMPOSED HERE satisfy the mirroring invariant (every handed-out state hash
 * resolves to a full tree in the content store).
 */
interface HostContentStore {
  listTree(
    ref: string,
    opts?: { prefix?: string; limit?: number }
  ): Promise<HostTreeListEntry[] | null>;
  /** Entries of one tree node, or null when absent — the cheap "is this state
   *  already mirrored?" probe (the `state:` node is always written last). */
  getTree(ref: string): Promise<unknown | null>;
  getBase64(digest: string): Promise<string | null>;
  putBase64(bytesBase64: string): Promise<{ digest: string; size: number }>;
  putTree(
    entries: HostTreeEntry[],
    opts?: { root?: boolean }
  ): Promise<{ treeHash: string; stateHash?: string }>;
}

/** The slice of the host `refs.*` RPC surface the VCS semantics need:
 *  reading a repo's protected `main` (the compose-base / status baseline) and
 *  enumerating every repo's protected refs (workspace-view composition). */
interface HostRefsStore {
  readMain(repoPath: string): Promise<{ stateHash: string } | null>;
  listMains(): Promise<Array<{ repoPath: string; stateHash: string }>>;
  /** P3: atomic group compare-and-swap over protected mains — the ONE
   *  ref-write path (§2.1). Approval-gated host-side; the DO is the single
   *  admitted writer. `invocationToken` names the on-behalf-of principal (§4).
   *  Throws a structured conflict when any `expectedOld` no longer matches. */
  updateMains(input: {
    entries: Array<{ repoPath: string; expectedOld: string | null; next: string | null }>;
    reason?: string;
    operation: "push" | "import" | "delete" | "restore";
    invocationToken?: string;
  }): Promise<{ updated: Array<{ repoPath: string; stateHash: string | null; seq: number }> }>;
  /** The host main-ref movement log for a repo (§2 audit trail: operation,
   *  host-verified writer + token-resolved on-behalf-of principal, reason,
   *  old→new). Render paths read main-advance attribution from here; the
   *  stale-intent discard consults it, not just current values (§6). `sinceId`
   *  pages movements after a known id (omit for the full log). */
  listMainRefLog(
    repoPath: string,
    sinceId?: number
  ): Promise<
    Array<{
      id: number;
      operation: string;
      old: string | null;
      new: string | null;
      writer: string | null;
      onBehalfOf: unknown;
      reason: string | null;
      createdAt: number;
    }>
  >;
}

/** The slice of the host `build.*` RPC surface the push gate needs (§2.2):
 *  a pure, cached validate over a candidate workspace VIEW hash. */
interface HostBuildStore {
  validate(input: {
    viewHash: string;
    repoPaths: string[];
    baseViewHash?: string;
  }): Promise<Array<{ required?: boolean; status: string; [k: string]: unknown }>>;
}

/** The slice of the host `worktree.*` RPC surface: the pure disk-scan
 *  primitive. `scan` reads a (repoPath, head) working tree into the CAS and
 *  returns its content-addressed `{ stateHash, files }` — no commit, no ref
 *  advance, no history. The DO composes it with the content/refs primitives to
 *  own the scan-adopt semantics itself. */
interface HostWorktreeStore {
  scan(
    repoPath: string,
    head: string
  ): Promise<{
    stateHash: string;
    files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
  }>;
  /** CAS→disk projection primitive — materialize `stateHash` onto the
   *  (repoPath, head) working tree (restore/fork re-materialize into
   *  `ctx:workspace`). Semantics-free; `main` is never projected (D1). */
  project(repoPath: string, head: string, stateHash: string): Promise<{ stateHash: string }>;
  /** Build-graph dependents of `repoPath` (host-computed, content-derived) —
   *  the DO consumes this to gate a deletion without `force`. Dumb data. */
  dependentRepos(repoPath: string): Promise<string[]>;
}

/** listTree caps results; a silently truncated listing would compose/merge as
 *  mass deletions, so overflow is a loud error. */
const MERGE_LIST_TREE_LIMIT = 100_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Quote each term so user input can't inject FTS5 query syntax. */
function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => term.replace(/"/gu, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => `"${term}"`)
    .join(" ");
}

/** Split raw text into whitespace-separated word tokens (≤ `cap`), quotes and
 *  blanks stripped. Shared by the FTS and plain-mode recall query builders so
 *  steering keywords are tokenized exactly like the base query. */
function recallTokens(values: readonly string[] | null | undefined, cap = 8): string[] {
  if (!values || values.length === 0) return [];
  return values
    .flatMap((value) => value.split(/\s+/u))
    .map((term) => term.replace(/"/gu, "").trim())
    .filter(Boolean)
    .slice(0, cap);
}

/** Lowercased word tokens, used for claim dedup overlap (§8.1). */
function claimTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

/** Jaccard overlap of two token sets — corpus-independent, so the dedup
 *  threshold is deterministic rather than bm25-magnitude sensitive. */
function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Short context window around the first query-term hit. */
function snippetAround(text: string, query: string, radius = 160): string {
  const firstTerm = query.split(/\s+/u).find((term) => term.length > 0) ?? "";
  const index = firstTerm ? text.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + firstTerm.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** One bounded insight fragment for a §7.5 attachment line (whitespace
 *  collapsed, hard-capped, ellipsized) — semantics are recalled verbatim, never
 *  synthesized, so this only trims. */
function truncateInsight(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function summarizeJsonForInspection(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 240
      ? { type: "string", chars: value.length, preview: value.slice(0, 240) }
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sample = value.slice(0, 20).map((item) => summarizeJsonForInspection(item, depth + 1));
    return value.length > sample.length
      ? [...sample, { omittedItems: value.length - sample.length }]
      : sample;
  }
  if (typeof value === "object") {
    if (depth >= 4) return { type: "object" };
    const entries = Object.entries(value as Record<string, unknown>);
    const sample = entries
      .slice(0, 40)
      .map(([key, child]) => [key, summarizeJsonForInspection(child, depth + 1)]);
    const out = Object.fromEntries(sample) as Record<string, unknown>;
    if (entries.length > sample.length) out["omittedKeys"] = entries.length - sample.length;
    return out;
  }
  return String(value);
}

function isActorRefLike(value: unknown): value is {
  kind: "user" | "agent" | "system" | "panel" | "external";
  id: string;
  metadata?: Record<string, unknown>;
} {
  const kind =
    !!value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["kind"]
      : undefined;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (kind === "user" ||
      kind === "agent" ||
      kind === "system" ||
      kind === "panel" ||
      kind === "external") &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  );
}

function sanitizeRegistryMutation(mutation: RegistryMutationInput): RegistryMutationInput {
  if (mutation.kind !== "upsertMessageType") return mutation;
  const registeredBy = mutation.row.registeredBy;
  return {
    ...mutation,
    row: {
      ...mutation.row,
      ...(isActorRefLike(registeredBy)
        ? { registeredBy: publicActorRef(registeredBy) }
        : registeredBy !== undefined
          ? { registeredBy: publicParticipantMetadata(registeredBy) }
          : {}),
    },
  };
}

function findPrivateParticipantMetadataPath(value: unknown, path = "$"): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPrivateParticipantMetadataPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if ("methods" in record && Array.isArray(record["methods"])) {
    for (const [index, method] of (record["methods"] as unknown[]).entries()) {
      if (!method || typeof method !== "object" || Array.isArray(method)) continue;
      const methodRecord = method as Record<string, unknown>;
      if (
        "parameters" in methodRecord ||
        "returns" in methodRecord ||
        "description" in methodRecord
      ) {
        return `${path}.methods[${index}]`;
      }
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "parameters" || key === "returns" || key === "description") continue;
    const found = findPrivateParticipantMetadataPath(record[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function sanitizeRosterMethodSummaries(methods: unknown): unknown[] {
  const publicMethods = publicParticipantMetadata({ methods })?.methods;
  return publicMethods ?? [];
}

function sanitizeRosterSnapshotPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const details = record["details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return payload;
  const detailsRecord = details as Record<string, unknown>;
  if (detailsRecord["kind"] !== "roster.snapshot" && record["kind"] !== "roster.snapshot") {
    return payload;
  }
  const roster = detailsRecord["roster"];
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) return payload;
  const rosterRecord = roster as Record<string, unknown>;
  if (!Array.isArray(rosterRecord["participants"])) return payload;

  return {
    ...record,
    details: {
      ...detailsRecord,
      roster: {
        ...rosterRecord,
        participants: rosterRecord["participants"].map((participant) => {
          if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
            return participant;
          }
          const participantRecord = participant as Record<string, unknown>;
          const ref = participantRecord["ref"];
          return {
            ...participantRecord,
            ...(ref && typeof ref === "object" && !Array.isArray(ref)
              ? { ref: publicParticipantRef(ref as ParticipantRef) }
              : {}),
            methods: sanitizeRosterMethodSummaries(participantRecord["methods"]),
          };
        }),
      },
    },
  };
}

function sanitizeAudience(
  audience: ParticipantRef[] | ParticipantSelector | null | undefined
): ParticipantRef[] | ParticipantSelector | undefined {
  if (audience == null) return undefined;
  if (!Array.isArray(audience)) return audience;
  return audience.map((participant) => publicParticipantRef(participant));
}

function isAgenticEventPayload(payload: unknown): payload is AgenticEvent {
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)["kind"] === "string" &&
    typeof (payload as Record<string, unknown>)["actor"] === "object" &&
    typeof (payload as Record<string, unknown>)["createdAt"] === "string"
  );
}

/** Strip cross-log/turn keys so the remaining causality matches the agentic
 *  trajectory causality shape. */
function agenticCausality(
  causality: LogEventCausality | null | undefined
): Record<string, unknown> | undefined {
  if (!causality) return undefined;
  const {
    originLogId: _originLogId,
    originHead: _originHead,
    originEnvelopeId: _originEnvelopeId,
    turnId: _turnId,
    ...rest
  } = causality as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Rebuild the semantic agentic event from a unified log envelope. */
function agenticEventFromEnvelope(envelope: LogEnvelope): Record<string, unknown> {
  const causality = agenticCausality(envelope.causality);
  const turnId = envelope.causality?.turnId;
  return {
    kind: envelope.payloadKind,
    actor: envelope.actor,
    ...(turnId ? { turnId } : {}),
    ...(causality ? { causality } : {}),
    payload: envelope.payload,
    createdAt: envelope.appendedAt,
  };
}

function terminalInvocationSignatureFromEnvelope(envelope: LogEnvelope): string {
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  return canonicalJson({
    actor: envelope.actor,
    kind: envelope.payloadKind,
    turnId: causality["turnId"],
    causality: {
      invocationId: causality["invocationId"],
      modelToolCallId: causality["modelToolCallId"],
      transportCallId: causality["transportCallId"],
    },
    payload: envelope.payload,
  });
}

interface PreparedLogEvent {
  envelopeId: string;
  /** Whether the caller supplied appendedAt (idempotent replays of implicit-
   *  timestamp appends compare against the stored timestamp instead). */
  appendedAtExplicit: boolean;
  actor: ParticipantRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payloadKind: string;
  payload: unknown;
  annotations?: Record<string, unknown>;
  causality?: LogEventCausality;
  appendedAt: string;
  publish: Array<{ channelId: string; audience?: unknown }>;
}

/** camelCase edit-op provenance row (the userland vcs.* read surface). */
interface VcsEditOpRowWire {
  id: number;
  eventId: string;
  committedEventId: string | null;
  committedSeq: number | null;
  editSeq: number | null;
  outputStateHash: string | null;
  ordinal: number;
  kind: string;
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  mode: number | null;
  actorId: string | null;
  invocationId: string | null;
  turnId: string | null;
  createdAt: string | null;
  /** Raw `hunks_json` (parsed by blame consumers); null for create/delete/chmod,
   *  binary, and synthetic snapshot ops (U1). */
  hunksJson: string | null;
  /** Snapshot-style provenance (import/push/whole-file take) — blame chain-restart. */
  synthetic: boolean;
  /** The op's NEW content is binary (no line structure). */
  binary: boolean;
}

/** One contiguous line range blamed to a single op (design §5.2). Consecutive
 *  lines that resolve identically are coalesced into one range. */
interface VcsBlameLineWire {
  startLine: number;
  endLine: number;
  /** The `gad_worktree_edit_ops.id` the lines resolved to (null when the walk
   *  ran off the log with no producing op). */
  opId: number | null;
  kind: string | null;
  commitEventId: string | null;
  /** First line of the commit message (`gad_state_transitions.summary`). */
  commitMessage: string | null;
  invocationId: string | null;
  turnId: string | null;
  actorId: string | null;
  /** A degraded/semantic-stop reason when blame could not attribute a producing
   *  edit: `create` (line born here), `binary`, `synthetic` (snapshot take), or
   *  `older-than-log`. Absent when a real op authored the lines. */
  degraded: "create" | "binary" | "synthetic" | "older-than-log" | null;
}

interface LineageSegment {
  logId: string;
  head: string;
  /** Highest seq visible from the descendant's perspective (Infinity for self). */
  throughSeq: number;
}

interface LineageEventStats {
  count: number;
  firstSeq?: number;
}

interface ProjectionKey {
  logId: string;
  head: string;
}

export class GadWorkspaceDO extends DurableObjectBase {
  // v24: merge of the local v23 schema cut and origin/fabling's v23 lineage
  // schema. Both physical layouts used version 23, so the unified schema needs
  // a fresh version to force the big-bang rebuild below.
  // v23 (origin/fabling): lineage-true context fork + cherry-pick provenance:
  // vcs_context_provenance (fork breadcrumb {parent, forkPoint}) and a
  // `picked_from_json` column on gad_worktree_edit_ops (which commit / paths a
  // working row was cherry-picked from; UX-only provenance).
  // v23 (local gad-system-review): merge of the two v22 lines below; both cuts,
  // one schema.
  // v26: provenance cache key hardening — cache rows are now scoped by repo log,
  // session, recall-key, turn ordinal, content stamp, and knowledge graph version.
  // v25 (gad-provenance-fibers big bang): the provenance graph substrate —
  // gad_touches (soft behavioral signal), gad_claim_relations + gad_knowledge_ledger
  // (durable, dropPersistenceTables-exempt claim system of record; own version key
  // knowledge_ledger_version) + gad_claims content columns (claim_kind, text,
  // ledger_entry_id), gad_worktree_edit_ops.binary, trajectory_turns.ordinal,
  // gad_provenance_cache / gad_prov_metrics / gad_prov_render_log. Knowledge
  // claims/relations re-project from the ledger on a schema bump.
  // v22 (fabling): P3 narrow-host push/merge orchestration moves into the DO:
  // gad_publish_intents (write-ahead publish intents for crash self-heal) and a
  // `synthetic` column on gad_worktree_edit_ops (import snapshot chain restarts).
  // v22 (gad-system-review): removes the dead file-mutation/observation
  // projections and their state.file_* event kinds.
  // v21: worktree heads carry explicit commit_event_id, so commit ancestry is
  // keyed by event identity instead of reverse-looking-up a producer by state
  // hash.
  // v20: schema cut for structured heads. Current log pointers live on
  // log_heads(current_*), worktree states live in gad_worktree_heads, and
  // context base pins live in vcs_context_bases. VCS no longer stores or
  // discovers head state through encoded generic refs.
  // v19: VCS edits→commits→push re-architecture. gad_worktree_edit_ops gains
  // working-edit provenance (log_id, head, committed_event_id, committed_seq,
  // edit_seq, created_at, actor_id, actor_json, invocation_id, turn_id) and makes
  // output_state_hash NULLABLE (NULL ⇒ uncommitted/working row); event_id stays
  // NOT NULL (synthetic per-edit-call id for working rows). gad_transition_parents
  // gains parent_event_id (event-keyed commit DAG, so distinct commits with
  // identical content states don't conflate).
  // v18: schema cut removes unimplemented knowledge sidecar projection tables.
  // v17 changed envelope hash preimage format v2 (length-prefixed fields).
  static override schemaVersion = 26;

  /**
   * IntentIds of publish intents this live instance is actively driving — added
   * SYNCHRONOUSLY at `recordPublishIntent` and cleared in a `finally` covering
   * the whole publish attempt. A concurrent `healPublishDrift` (on-demand from
   * another push/merge/import, or host-driven `vcsHealPublishDrift`) must NOT
   * stale-reap an intent parked here across its (potentially long, human-gated)
   * `refs.updateMains` critical section — the CAS may still land. The set is
   * in-memory ON PURPOSE: it dies with the instance, which is exactly when a
   * parked intent becomes genuinely orphaned (crash / eviction after the CAS but
   * before completion); a fresh instance starts with an empty set, so its
   * startup heal correctly reaps and completes the crashed op's intent (§6).
   */
  private readonly inFlightPublishIntents = new Set<string>();

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
    void this.setOwnTitle("GAD store");
  }

  /** Set by migrate() when crossing a schema era so createTables() knows to
   *  re-project claims from the durable ledger after the fresh schema lands. */
  private pendingLedgerRebuild = false;

  protected createTables(): void {
    this.createFreshSchema();
    if (this.pendingLedgerRebuild) {
      this.pendingLedgerRebuild = false;
      // §8.1: the knowledge ledger outlives schema eras. The projection tables
      // were just dropped + recreated empty; replay the surviving ledger to
      // rebuild gad_claims + gad_claim_relations + claim FTS rows.
      this.transaction(() => this.rebuildClaimsFromLedger());
    }
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    // Big-bang schema: no data migration across versions — drop and let
    // createTables() (called after migrate by the base) recreate fresh. The
    // gad_knowledge_ledger table (and its `state` version key) survive the drop
    // and re-seed the claim projections (§8.1).
    if (fromVersion > 0) {
      this.dropPersistenceTables();
      this.pendingLedgerRebuild = true;
    }
  }

  protected override requiredTables(): readonly string[] {
    return GAD_REQUIRED_TABLES;
  }

  private dropPersistenceTables(): void {
    const rows = this.sql
      .exec(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND (
             name LIKE 'trajectory_%' OR name LIKE 'channel_%' OR name LIKE 'gad_%'
             OR name LIKE 'log_%'
             OR name IN ('vcs_context_bases', 'vcs_context_provenance', 'refs', 'ref_log', 'branches', 'sessions', 'conversation_turns',
                         'tool_calls', 'file_versions', 'tracked_files', 'blobs', 'provenance_for_file', 'edge_graph', 'claim_graph')
           )
           -- §8.1: the durable knowledge ledger is the claim system of record and
           -- must OUTLIVE schema eras — its gad_ prefix would otherwise sweep it.
           AND name NOT IN ('gad_knowledge_ledger')`
      )
      .toArray() as Array<{ type: string; name: string; sql: string | null }>;
    const isVirtual = (row: { sql: string | null }) =>
      /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "");
    // FTS5 virtual tables and their shadow tables (…_data, _idx, _content,
    // _docsize, _config) are interdependent: drop the virtual tables FIRST so
    // SQLite tears down their shadows, then drop the remaining ordinary
    // tables, skipping any name the virtual-table drop already removed.
    for (const row of rows) {
      if (row.type === "view") this.sql.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(row.name)}`);
    }
    for (const row of rows) {
      if (row.type === "table" && isVirtual(row)) {
        this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(row.name)}`);
      }
    }
    for (const row of rows) {
      if (row.type !== "table" || isVirtual(row)) continue;
      const stillExists =
        this.sql
          .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, row.name)
          .toArray().length > 0;
      if (stillExists) this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(row.name)}`);
    }
  }

  private createFreshSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_heads (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        log_kind TEXT NOT NULL,
        owner_json TEXT,
        parent_log_id TEXT,
        parent_head TEXT,
        fork_seq INTEGER,
        fork_hash TEXT,
        current_seq INTEGER NOT NULL DEFAULT 0,
        current_hash TEXT NOT NULL DEFAULT '${GENESIS_EVENT_HASH}',
        current_envelope_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_events (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_id TEXT NOT NULL,
        payload_kind TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        to_json TEXT,
        causality_json TEXT,
        annotations_json TEXT,
        payload_ref_json TEXT NOT NULL,
        appended_at TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        origin_log_id TEXT,
        origin_head TEXT,
        origin_envelope_id TEXT,
        turn_id TEXT,
        PRIMARY KEY (log_id, head, seq),
        UNIQUE (log_id, head, envelope_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_kind ON log_events(payload_kind, log_id, head, seq)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_origin ON log_events(origin_envelope_id)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_events_envelope ON log_events(envelope_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_events_turn ON log_events(turn_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_blob_refs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, envelope_id, field_path)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_blob_refs_digest ON log_blob_refs(digest)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_worktree_heads (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        commit_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_worktree_heads_head ON gad_worktree_heads(head, log_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_worktree_heads_commit ON gad_worktree_heads(commit_event_id)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vcs_context_bases (
        context_id TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // v24: a child context's fork breadcrumb — which context it forked from and
    // the shared base view (forkPoint) at the fork. Metadata only (UX lineage);
    // the true merge-base connection is the shared committed state node in the
    // transition DAG, not this row. NOT replay-rebuildable — dropped on a schema
    // bump like every other projection (acceptable: UX-only, big-bang pre-release).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vcs_context_provenance (
        context_id TEXT PRIMARY KEY,
        parent_context_id TEXT NOT NULL,
        fork_point_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        ref_name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ref_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_name TEXT NOT NULL,
        old_target_json TEXT,
        new_target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ref_log_name ON ref_log(ref_name, id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_turns (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary TEXT,
        -- §6.3 turn-decay basis: the turn's per-branch ordinal (count of prior
        -- turns on this (log_id, head) at turn.opened). Wall-clock is display-only.
        ordinal INTEGER,
        PRIMARY KEY (log_id, head, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_messages (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, message_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_message_blocks (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        block_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        invocation_id TEXT,
        PRIMARY KEY (log_id, head, block_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_invocations (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        transport_call_id TEXT,
        kind TEXT,
        status TEXT NOT NULL,
        terminal_outcome TEXT,
        terminal_reason_code TEXT,
        request_ref_json TEXT,
        result_ref_json TEXT,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_transport ON trajectory_invocations(transport_call_id)`
    );
    // invocation→turn traversal (file → edit → invocation → turn): editsByTurn
    // joins edit-op rows to their invocation's turn through this.
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_turn ON trajectory_invocations(turn_id)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_invocation_outputs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_approvals (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        requested_by_json TEXT,
        resolved_by_json TEXT,
        requested_event_id TEXT,
        resolved_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, approval_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_usage_rollups (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (log_id, head, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_checkpoints (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        anchor_event_hash TEXT NOT NULL,
        materialized_blob_json TEXT NOT NULL,
        materializer_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, anchor_event_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_message_types (
        channel_id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        display_mode TEXT,
        source_json TEXT,
        imports_json TEXT,
        schema_json TEXT,
        registered_by_json TEXT,
        updated_at_seq INTEGER NOT NULL DEFAULT -1,
        cleared_at_seq INTEGER,
        PRIMARY KEY (channel_id, type_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_roster (
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        left_at TEXT,
        roles_json TEXT,
        PRIMARY KEY (channel_id, participant_id, joined_at)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_worktree_states (
        state_hash TEXT PRIMARY KEY,
        manifest_root_hash TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_file_versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mode INTEGER NOT NULL DEFAULT 33188,
        created_at TEXT NOT NULL,
        UNIQUE (path, content_hash, mode)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_file_versions_path ON gad_file_versions(path)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_nodes (
        manifest_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_entries (
        manifest_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        child_manifest_hash TEXT,
        file_version_id INTEGER,
        PRIMARY KEY (manifest_hash, name)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_state_transitions (
        event_id TEXT PRIMARY KEY,
        invocation_id TEXT,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        summary TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_state_transitions_output ON gad_state_transitions(output_state_hash)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_transition_parents (
        event_id TEXT NOT NULL,
        parent_state_hash TEXT NOT NULL,
        parent_event_id TEXT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (event_id, ordinal)
      )
    `);
    // Event-keyed commit DAG: walk child→parents (idx_event) and parent→children
    // (idx_parent_event). Commit identity is event_id, never output_state_hash
    // (content dedupes, so a clean-merge commit can share a state with an
    // existing commit) — so ancestry traverses parent_event_id.
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_transition_parents_event ON gad_transition_parents(event_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_transition_parents_parent_event ON gad_transition_parents(parent_event_id)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_worktree_edit_ops (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        log_id TEXT,
        head TEXT,
        committed_event_id TEXT,
        committed_seq INTEGER,
        edit_seq INTEGER,
        output_state_hash TEXT,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        old_content_hash TEXT,
        new_content_hash TEXT,
        hunks_json TEXT,
        mode INTEGER,
        actor_id TEXT,
        actor_json TEXT,
        invocation_id TEXT,
        turn_id TEXT,
        created_at TEXT,
        -- P3/A2: a synthetic op carries no true first-parent hunks (for
        -- example an import snapshot). Blame treats synthetic
        -- rows as chain RESTARTS (like create), never mis-blaming or tripping
        -- the first-parent chain-continuity check.
        synthetic INTEGER,
        -- v25/U1: the op's NEW content is binary (reuses the engine's binary
        -- detection). Binary write/create rows carry no hunks and are chain
        -- restarts for blame; a replace over binary is rejected upstream.
        binary INTEGER NOT NULL DEFAULT 0,
        -- v24: cherry-pick provenance — the source a working row was picked
        -- from (JSON {kind:"commit",logId,eventId} or {kind:"paths",
        -- sourceContextId}). UX breadcrumb only, never load-bearing for replay.
        picked_from_json TEXT
      )
    `);
    // Two sequencing orders: edit_seq is per edit CALL on a (log_id, head) and
    // defines working REPLAY order (edit_seq, ordinal); committed_seq is the
    // owning commit's log seq and defines COMMIT-lineage order for blame.
    // committed_event_id NULL ⇒ uncommitted/working; output_state_hash NULL for
    // working rows (set to the commit state at commit).
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_commit ON gad_worktree_edit_ops(committed_event_id)` // commit→edits
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_working ON gad_worktree_edit_ops(log_id, head, committed_event_id, edit_seq, ordinal)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_path ON gad_worktree_edit_ops(log_id, path, committed_seq, edit_seq, ordinal)` // file blame in COMMIT-lineage order
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_actor ON gad_worktree_edit_ops(actor_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_turn ON gad_worktree_edit_ops(turn_id)` // causal: edits in a turn
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_edit_ops_invoc ON gad_worktree_edit_ops(invocation_id)` // causal: edits in a tool-call
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_edit_ops_output ON gad_worktree_edit_ops(output_state_hash)` // legacy listWorktreeEditOps
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_claims (
        claim_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        -- §8: a claim can stand as an entity, a predicate, or a full statement.
        claim_kind TEXT,
        text TEXT,
        -- §8.1: pointer to the durable ledger entry that owns this claim's
        -- content (the causality/trajectory_event_id is the era-scoped edge).
        ledger_entry_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // §8: agent-asserted claim↔claim relations. Global + event-keyed like
    // gad_state_transitions: replay/fork folds one event under multiple heads
    // and dedups by the unique identity (INSERT OR IGNORE) — never
    // check-before-insert, never copied per-head in copyProjectionKey.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_claim_relations (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        src_claim_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        dst_claim_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_claim_rel_src ON gad_claim_relations(src_claim_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_claim_rel_dst ON gad_claim_relations(dst_claim_id)`
    );
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_rel_ident ON gad_claim_relations(event_id, src_claim_id, relation, dst_claim_id)`
    );
    // §8.1: the durable knowledge ledger — append-only, EXEMPT from
    // dropPersistenceTables, its own version under state key
    // knowledge_ledger_version. The system of record for claim content; the
    // trajectory knowledge.* event carries only causality + a pointer here.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_knowledge_ledger (
        entry_id TEXT PRIMARY KEY,
        seq INTEGER,
        kind TEXT NOT NULL,          -- claim_recorded | claim_revised | claim_retracted | claims_related
        payload_json TEXT NOT NULL,  -- claim/relation content + rebuild causality
        anchor_json TEXT NOT NULL,   -- write-time snapshot (repo, commit msg, actor, iso time)
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_seq ON gad_knowledge_ledger(seq)`
    );
    if (this.getStateValue("knowledge_ledger_version") == null) {
      this.setStateValue("knowledge_ledger_version", String(KNOWLEDGE_LEDGER_VERSION));
    }
    // §4.2: the one physical soft-signal table (behavioral touches). One
    // counted row per (kind, session, target); repeats bump hits/turn_seq.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_touches (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,              -- observed | cited
        session_log_id TEXT NOT NULL,
        session_head TEXT NOT NULL,
        dst_kind TEXT NOT NULL,          -- file | claim
        dst_id TEXT NOT NULL,
        last_invocation_id TEXT,
        turn_seq INTEGER,
        hits INTEGER NOT NULL DEFAULT 1,
        last_block_sig TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_touches_dst ON gad_touches(dst_kind, dst_id, id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_touches_session ON gad_touches(session_log_id, session_head, id)`
    );
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_touches_coalesce ON gad_touches(kind, session_log_id, session_head, dst_kind, dst_id)`
    );
    // §7.3 warm cache: disposable density blocks. Keyed by every input that can
    // change the cached density leg; live exceptions stay outside the cache.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_provenance_cache (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        path TEXT NOT NULL,
        session_log_id TEXT NOT NULL,
        session_head TEXT NOT NULL,
        recall_key TEXT NOT NULL,
        turn_seq INTEGER NOT NULL,
        touch_version INTEGER NOT NULL,
        knowledge_version INTEGER NOT NULL,
        content_stamp TEXT NOT NULL,
        rendered_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, path, session_log_id, session_head, recall_key, turn_seq)
      )
    `);
    // §12 instrumentation: counted upserts for the four behavioral counters.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_prov_metrics (
        metric TEXT NOT NULL,
        bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (metric, bucket)
      )
    `);
    // §4.1 no-`included` rule: an instrumentation-only trace of pushed items
    // (feeds counter #4). NEVER a ranking input; prunable with touches.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_prov_render_log (
        id INTEGER PRIMARY KEY,
        session_log_id TEXT,
        session_head TEXT,
        path TEXT,
        item_handles_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      -- GC: two-phase blob deletion candidates (marked unreferenced; swept
      -- only when still unreferenced on a later pass).
      CREATE TABLE IF NOT EXISTS gad_gc_candidates (
        digest TEXT PRIMARY KEY,
        marked_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      -- P3: write-ahead publish intents. Recorded durably BEFORE calling the
      -- host refs.updateMains so a crash between the CAS landing and provenance
      -- recording can be healed with full fidelity (parents, message, actor
      -- labels). Deleted once provenance is recorded (a completed intent). The
      -- candidate 'next' state hashes are GC roots while the intent is pending
      -- (see runGadGcMark) so a crash cannot sweep an un-recorded candidate.
      CREATE TABLE IF NOT EXISTS gad_publish_intents (
        intent_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,          -- "push" | "import"
        -- entries: [{ repoPath, logId, expectedOld, next, parentEventId,
        --            parentStateHash, files:[{path,contentHash,mode}], editOps }]
        entries_json TEXT NOT NULL,
        message TEXT,
        actor_json TEXT,
        source_head TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // §9 SQL-first surface: edit ops ⋈ trajectory invocations ⋈ commit
    // transition (message via gad_state_transitions.summary) for a path. A pure
    // projection — dropped-and-recreated on every schema era (dropPersistenceTables
    // drops views first), never a system of record.
    this.sql.exec(`
      CREATE VIEW IF NOT EXISTS provenance_for_file AS
      SELECT
        eo.log_id             AS log_id,
        eo.path               AS path,
        eo.id                 AS op_id,
        eo.kind               AS kind,
        eo.committed_event_id AS commit_event_id,
        eo.committed_seq      AS committed_seq,
        eo.edit_seq           AS edit_seq,
        eo.ordinal            AS ordinal,
        eo.old_content_hash   AS old_content_hash,
        eo.new_content_hash   AS new_content_hash,
        eo.synthetic          AS synthetic,
        eo.binary             AS binary,
        eo.actor_id           AS actor_id,
        eo.invocation_id      AS invocation_id,
        COALESCE(eo.turn_id, ti.turn_id) AS turn_id,
        ti.transport_call_id  AS transport_call_id,
        st.summary            AS commit_message,
        st.created_at         AS committed_at,
        eo.created_at         AS created_at
      FROM gad_worktree_edit_ops eo
      LEFT JOIN trajectory_invocations ti
        ON ti.invocation_id = eo.invocation_id
      LEFT JOIN gad_state_transitions st
        ON st.event_id = eo.committed_event_id
    `);
    // §9 edge_graph: the UNION view over native edges + gad_touches in ONE
    // (kind, src_kind, src_id, dst_kind, dst_id, weight_basis) shape for ad-hoc
    // traversal. Raw + UNRANKED (§9: SQL chases a handle, never re-derives the
    // ranked block). Pure projection — dropped-and-recreated each schema era.
    //  - edited:      invocation → file  (an uncommitted/committed edit op)
    //  - committed_in file → commit       (the op's owning commit event)
    //  - asserted:    invocation → claim  (the claim's causal invocation)
    //  - observed/cited: session → file/claim (the soft behavioral touches)
    this.sql.exec(`
      CREATE VIEW IF NOT EXISTS edge_graph AS
        SELECT 'edited' AS kind, 'invocation' AS src_kind, eo.invocation_id AS src_id,
               'file' AS dst_kind, (eo.log_id || char(1) || eo.path) AS dst_id,
               1.0 AS weight_basis
          FROM gad_worktree_edit_ops eo
         WHERE eo.invocation_id IS NOT NULL
        UNION ALL
        SELECT 'committed_in', 'file', (eo.log_id || char(1) || eo.path),
               'commit', eo.committed_event_id, 1.0
          FROM gad_worktree_edit_ops eo
         WHERE eo.committed_event_id IS NOT NULL
        UNION ALL
        SELECT 'asserted', 'invocation', c.invocation_id,
               'claim', c.claim_id, 1.0
          FROM gad_claims c
         WHERE c.invocation_id IS NOT NULL
        UNION ALL
        SELECT r.relation, 'claim', r.src_claim_id, 'claim', r.dst_claim_id, r.weight
          FROM gad_claim_relations r
        UNION ALL
        SELECT t.kind, 'session', (t.session_log_id || char(1) || t.session_head),
               t.dst_kind, t.dst_id, CAST(t.hits AS REAL)
          FROM gad_touches t
    `);
    // §9 claim_graph: claims joined to their relations + the touching
    // invocation/session, for chasing a specific claim handle. Unranked.
    this.sql.exec(`
      CREATE VIEW IF NOT EXISTS claim_graph AS
        SELECT c.claim_id AS claim_id, c.status AS status, c.claim_kind AS claim_kind,
               c.text AS text, c.subject AS subject, c.predicate AS predicate,
               c.object AS object, c.invocation_id AS invocation_id,
               c.trajectory_event_id AS trajectory_event_id,
               r.relation AS relation, r.dst_claim_id AS related_claim_id,
               r.weight AS relation_weight, c.updated_at AS updated_at
          FROM gad_claims c
          LEFT JOIN gad_claim_relations r ON r.src_claim_id = c.claim_id
    `);
    this.ensureEmptyState();
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  rawSql(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    if (!readOnlySql(sql)) throw new Error("rawSql writes are disabled");
    return { rows: this.sql.exec(sql, ...bindings).toArray() as JsonRecord[] };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  query(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    return this.rawSql(sql, bindings);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  ensureBlob(hash: string, size = 0, mimeType?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)`,
      hash,
      size,
      mimeType ?? null,
      nowIso()
    );
  }

  // -------------------------------------------------------------------------
  // Structured mutable heads
  // -------------------------------------------------------------------------

  private mapWorktreeHead(row: JsonRecord): WorktreeHeadRecord {
    return {
      logId: String(row["log_id"]),
      head: String(row["head"]),
      stateHash: String(row["state_hash"]),
      commitEventId: asString(row["commit_event_id"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private resolveWorktreeHeadInternal(logId: string, head: string): WorktreeHeadRecord | null {
    const row = this.sql
      .exec(`SELECT * FROM gad_worktree_heads WHERE log_id = ? AND head = ?`, logId, head)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapWorktreeHead(row) : null;
  }

  private setWorktreeHead(
    logId: string,
    head: string,
    stateHash: string,
    commitEventId: string | null
  ): WorktreeHeadRecord {
    const updatedAt = nowIso();
    this.sql.exec(
      `INSERT INTO gad_worktree_heads (log_id, head, state_hash, commit_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head) DO UPDATE SET
         state_hash = excluded.state_hash,
         commit_event_id = excluded.commit_event_id,
         updated_at = excluded.updated_at`,
      logId,
      head,
      stateHash,
      commitEventId,
      updatedAt
    );
    return { logId, head, stateHash, commitEventId, updatedAt };
  }

  private deleteWorktreeHeadInternal(logId: string, head: string): { deleted: number } {
    const existed = this.resolveWorktreeHeadInternal(logId, head) != null;
    this.sql.exec(`DELETE FROM gad_worktree_heads WHERE log_id = ? AND head = ?`, logId, head);
    return { deleted: existed ? 1 : 0 };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  resolveWorktreeHead(input: { logId: string; head: string }): WorktreeHeadRecord | null {
    this.ensureReady();
    return this.resolveWorktreeHeadInternal(input.logId, input.head);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listWorktreeHeads(
    input: { logId?: string | null; logIdPrefix?: string | null; head?: string | null } = {}
  ): WorktreeHeadRecord[] {
    this.ensureReady();
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.logId) {
      clauses.push("log_id = ?");
      bindings.push(input.logId);
    }
    if (input.logIdPrefix) {
      const upper = stringPrefixUpperBound(input.logIdPrefix);
      clauses.push(upper ? "(log_id >= ? AND log_id < ?)" : "log_id >= ?");
      bindings.push(input.logIdPrefix);
      if (upper) bindings.push(upper);
    }
    if (input.head) {
      clauses.push("head = ?");
      bindings.push(input.head);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.sql
        .exec(
          `SELECT * FROM gad_worktree_heads ${where} ORDER BY log_id ASC, head ASC`,
          ...bindings
        )
        .toArray() as JsonRecord[]
    ).map((row) => this.mapWorktreeHead(row));
  }

  @rpc({ callers: ["do", "server"] })
  deleteWorktreeHead(input: { logId: string; head: string }): { deleted: number } {
    this.ensureReady();
    return this.deleteWorktreeHeadInternal(input.logId, input.head);
  }

  @rpc({ callers: ["do", "server"] })
  setContextBase(input: { contextId: string; stateHash: string }): {
    contextId: string;
    stateHash: string;
    updatedAt: string;
  } {
    this.ensureReady();
    const updatedAt = nowIso();
    this.sql.exec(
      `INSERT INTO vcs_context_bases (context_id, state_hash, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(context_id) DO UPDATE SET
         state_hash = excluded.state_hash,
         updated_at = excluded.updated_at`,
      input.contextId,
      input.stateHash,
      updatedAt
    );
    return { contextId: input.contextId, stateHash: input.stateHash, updatedAt };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getContextBase(input: { contextId: string }): { contextId: string; stateHash: string } | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT context_id, state_hash FROM vcs_context_bases WHERE context_id = ?`,
        input.contextId
      )
      .toArray()[0] as JsonRecord | undefined;
    return row
      ? { contextId: String(row["context_id"]), stateHash: String(row["state_hash"]) }
      : null;
  }

  @rpc({ callers: ["do", "server"] })
  deleteContextBase(input: { contextId: string }): { deleted: number } {
    this.ensureReady();
    const existed = this.getContextBase(input) != null;
    this.sql.exec(`DELETE FROM vcs_context_bases WHERE context_id = ?`, input.contextId);
    return { deleted: existed ? 1 : 0 };
  }

  // -------------------------------------------------------------------------
  // Generic refs — tag-style mutable pointers. VCS heads do not live here.
  // -------------------------------------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  resolveRef(input: { refName: string }): RefRecord | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM refs WHERE ref_name = ?`, input.refName)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return {
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    };
  }

  @rpc({ callers: ["do", "server"] })
  updateRef(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    this.ensureReady();
    return this.updateRefInternal(input);
  }

  private updateRefInternal(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    const existing = this.resolveRef({ refName: input.refName });
    if ("expected" in input) {
      const expected = input.expected ?? null;
      const current = existing?.target ?? null;
      if (canonicalJson(expected) !== canonicalJson(current)) {
        throw new Error(`ref CAS conflict: ${input.refName}`);
      }
    }
    const now = nowIso();
    const targetJson = JSON.stringify(input.target);
    this.sql.exec(
      `INSERT INTO refs (ref_name, kind, target_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ref_name) DO UPDATE SET
         kind = excluded.kind,
         target_json = excluded.target_json,
         updated_at = excluded.updated_at`,
      input.refName,
      input.kind,
      targetJson,
      now
    );
    this.sql.exec(
      `INSERT INTO ref_log (ref_name, old_target_json, new_target_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      input.refName,
      existing ? JSON.stringify(existing.target) : null,
      targetJson,
      now
    );
    return { refName: input.refName, kind: input.kind, target: input.target, updatedAt: now };
  }

  @rpc({ callers: ["do", "server"] })
  deleteRef(input: { refName: string }): { deleted: number } {
    this.ensureReady();
    const existed = this.resolveRef({ refName: input.refName }) != null;
    this.sql.exec(`DELETE FROM refs WHERE ref_name = ?`, input.refName);
    return { deleted: existed ? 1 : 0 };
  }

  /**
   * Fully retire a log head: delete its own log_events (post-fork events only —
   * inherited events live on the parent), its log_heads row, BOTH its refs
   * (log-head pointer + worktree), and its edit-op rows. Deleting only the refs
   * (leaving the log_heads row + chain) leaves headPointer falling back to a
   * stale fork pointer that disagrees with the chain — the dropContext
   * integrity hazard. Atomic; idempotent.
   */
  @rpc({ callers: ["do", "server"] })
  deleteLogHead(input: { logId: string; head: string }): { deleted: boolean } {
    this.ensureReady();
    return this.transaction(() => {
      const existed = this.logHeadRow(input.logId, input.head) != null;
      // This head's OWN events (post-fork; inherited ones live on the parent).
      const eventIds = (
        this.sql
          .exec(
            `SELECT envelope_id FROM log_events WHERE log_id = ? AND head = ?`,
            input.logId,
            input.head
          )
          .toArray() as JsonRecord[]
      )
        .map((r) => asString(r["envelope_id"]))
        .filter((id): id is string => !!id);
      // Drop the commit transitions these events produced — else they orphan
      // (validateGadHashes flags "transition event is missing"). The STATES they
      // produced are content-addressed and survive (also produced by the main
      // push commit + GC-refcounted); committed edit-op rows survive too (blame
      // is keyed by log_id+path, not the dropped head's events).
      for (const eventId of eventIds) {
        this.sql.exec(`DELETE FROM gad_transition_parents WHERE event_id = ?`, eventId);
        this.sql.exec(`DELETE FROM gad_state_transitions WHERE event_id = ?`, eventId);
      }
      this.sql.exec(
        `DELETE FROM log_events WHERE log_id = ? AND head = ?`,
        input.logId,
        input.head
      );
      this.sql.exec(`DELETE FROM log_heads WHERE log_id = ? AND head = ?`, input.logId, input.head);
      // Drop only this head's UNCOMMITTED edit-ops (its committed rows are blame
      // provenance keyed by log_id+path and must survive context teardown — they
      // still resolve via fileHistory even after the head's log is gone).
      this.sql.exec(
        `DELETE FROM gad_worktree_edit_ops WHERE log_id = ? AND head = ? AND committed_event_id IS NULL`,
        input.logId,
        input.head
      );
      this.deleteWorktreeHeadInternal(input.logId, input.head);
      this.deleteStateValue(`merge:${input.logId}:${input.head}`);
      return { deleted: existed };
    });
  }

  @rpc({ callers: ["do", "server"] })
  deleteRefsByPrefix(input: { prefix: string }): { deleted: number } {
    this.ensureReady();
    const upper = stringPrefixUpperBound(input.prefix);
    const rows = this.sql
      .exec(
        upper
          ? `SELECT ref_name FROM refs WHERE ref_name >= ? AND ref_name < ?`
          : `SELECT ref_name FROM refs WHERE ref_name >= ?`,
        ...(upper ? [input.prefix, upper] : [input.prefix])
      )
      .toArray() as JsonRecord[];
    for (const row of rows) {
      this.sql.exec(`DELETE FROM refs WHERE ref_name = ?`, String(row["ref_name"]));
    }
    return { deleted: rows.length };
  }

  /**
   * Archive a repo log's `main` head: move its ENTIRE lineage — the `log_heads`
   * row, every `log_events`/`log_blob_refs` row, and the worktree + log-head refs
   * — onto a fresh, non-`main` archive head, then drop the repo's derived recall
   * index. The repo thereby leaves the live worktree-ref set (so it drops out of
   * the composed workspace view / global state), while its full history is
   * preserved under `archiveHead` and stays restorable (re-point `main` at it).
   *
   * Moving only the `head` column is integrity-safe: events are linked by content
   * hash (`hash`/`prev_hash`), not by head name, so the chain is unchanged. A
   * future repo created at the same path gets a clean `main` (no inherited
   * history). Idempotent: returns `archived:false` when there is no `main`
   * worktree head. `archiveHead` must be unique (the caller derives it).
   */
  @rpc({ callers: ["do", "server"] })
  archiveRepoMain(input: { logId: string; archiveHead: string }): {
    archived: boolean;
    archiveHead: string | null;
    stateHash: string | null;
    headHash: string | null;
  } {
    this.ensureReady();
    const { logId, archiveHead } = input;
    const MAIN = "main";
    if (!archiveHead || archiveHead === MAIN) {
      throw new Error(`archiveRepoMain: invalid archive head ${JSON.stringify(archiveHead)}`);
    }
    const mainWorktree = this.resolveWorktreeHeadInternal(logId, MAIN);
    if (!mainWorktree) {
      return { archived: false, archiveHead: null, stateHash: null, headHash: null };
    }
    if (
      this.logHeadRow(logId, archiveHead) ||
      this.resolveWorktreeHeadInternal(logId, archiveHead)
    ) {
      throw new Error(`archiveRepoMain: archive head already exists: ${logId}:${archiveHead}`);
    }
    const stateHash = mainWorktree.stateHash;
    const mainLog = this.headPointer(logId, MAIN);
    const headHash = mainLog.hash;

    // Re-key the head's lineage main → archiveHead (events/blobs keep their
    // content hashes — the parent chain is hash-linked, not head-linked).
    this.sql.exec(
      `UPDATE log_heads SET head = ? WHERE log_id = ? AND head = ?`,
      archiveHead,
      logId,
      MAIN
    );
    this.sql.exec(
      `UPDATE log_events SET head = ? WHERE log_id = ? AND head = ?`,
      archiveHead,
      logId,
      MAIN
    );
    this.sql.exec(
      `UPDATE log_blob_refs SET head = ? WHERE log_id = ? AND head = ?`,
      archiveHead,
      logId,
      MAIN
    );
    this.sql.exec(
      `UPDATE gad_worktree_heads SET head = ? WHERE log_id = ? AND head = ?`,
      archiveHead,
      logId,
      MAIN
    );

    // The recall index is a derived projection — drop the repo's `main` rows so an
    // archived repo never surfaces in recall (re-foldable if it is ever restored).
    // ensureMemoryIndex first: the FTS table is created lazily on first use.
    this.ensureMemoryIndex();
    this.sql.exec(`DELETE FROM gad_memory_fts WHERE log_id = ? AND head = ?`, logId, MAIN);

    return { archived: true, archiveHead, stateHash, headHash };
  }

  /**
   * Reverse of {@link archiveRepoMain}: move an archived head's lineage back onto
   * `main`, recovering a deleted repo. Atomic on the single-threaded DO, so the
   * "no live main" guard and the move cannot interleave — it THROWS if a `main`
   * already exists (a different repo was slotted in at this path since deletion)
   * rather than clobbering it. Returns `restored:false` when `archiveHead` is
   * absent (nothing to restore).
   */
  @rpc({ callers: ["do", "server"] })
  restoreRepoMain(input: { logId: string; archiveHead: string }): {
    restored: boolean;
    archiveHead: string | null;
    stateHash: string | null;
    headHash: string | null;
  } {
    this.ensureReady();
    const { logId, archiveHead } = input;
    const MAIN = "main";
    if (!archiveHead || archiveHead === MAIN) {
      throw new Error(`restoreRepoMain: invalid archive head ${JSON.stringify(archiveHead)}`);
    }
    // Concurrency guard: refuse to clobber a repo that now occupies this path.
    if (this.resolveWorktreeHeadInternal(logId, MAIN)) {
      throw new Error(
        `restoreRepoMain: ${logId} already has a live main — a different repo occupies this path`
      );
    }
    const archWorktree = this.resolveWorktreeHeadInternal(logId, archiveHead);
    if (!archWorktree) {
      return { restored: false, archiveHead: null, stateHash: null, headHash: null };
    }
    const stateHash = archWorktree.stateHash;
    const archLog = this.headPointer(logId, archiveHead);
    const headHash = archLog.hash;

    // Re-key the archive head's lineage back to `main`.
    this.sql.exec(
      `UPDATE log_heads SET head = ? WHERE log_id = ? AND head = ?`,
      MAIN,
      logId,
      archiveHead
    );
    this.sql.exec(
      `UPDATE log_events SET head = ? WHERE log_id = ? AND head = ?`,
      MAIN,
      logId,
      archiveHead
    );
    this.sql.exec(
      `UPDATE log_blob_refs SET head = ? WHERE log_id = ? AND head = ?`,
      MAIN,
      logId,
      archiveHead
    );
    this.sql.exec(
      `UPDATE gad_worktree_heads SET head = ? WHERE log_id = ? AND head = ?`,
      MAIN,
      logId,
      archiveHead
    );

    return { restored: true, archiveHead, stateHash, headHash };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listRefs(input: { kind?: string | null; prefix?: string | null } = {}): RefRecord[] {
    this.ensureReady();
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      bindings.push(input.kind);
    }
    if (input.prefix) {
      const upper = stringPrefixUpperBound(input.prefix);
      clauses.push(upper ? "(ref_name >= ? AND ref_name < ?)" : "ref_name >= ?");
      bindings.push(input.prefix);
      if (upper) bindings.push(upper);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.sql
        .exec(`SELECT * FROM refs ${where} ORDER BY ref_name ASC`, ...bindings)
        .toArray() as JsonRecord[]
    ).map((row) => ({
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    }));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listRefLog(input: { refName: string; limit?: number | null }): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    return this.sql
      .exec(
        `SELECT * FROM ref_log WHERE ref_name = ? ORDER BY id ASC LIMIT ?`,
        input.refName,
        limit
      )
      .toArray() as JsonRecord[];
  }

  // -------------------------------------------------------------------------
  // Unified log core (one code path for every log kind — P5)
  // -------------------------------------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getLogHead(input: { logId: string; head: string }): LogHeadInfo | null {
    this.ensureReady();
    const row = this.logHeadRow(input.logId, input.head);
    if (!row) return null;
    const pointer = this.headPointer(input.logId, input.head, row);
    return {
      logId: input.logId,
      head: input.head,
      logKind: String(row["log_kind"]),
      seq: pointer.seq,
      hash: pointer.hash,
      envelopeId: pointer.envelopeId,
      forkSeq: row["fork_seq"] == null ? null : asNumber(row["fork_seq"]),
      forkHash: asString(row["fork_hash"]),
      parentLogId: asString(row["parent_log_id"]),
      parentHead: asString(row["parent_head"]),
    };
  }

  /**
   * The fork lineage recorded on a `log_heads` row: its parent log and the
   * `(seq, hash)` it forked at (all null for a root / un-forked head). A pure
   * read of the `parent_log_id`/`fork_seq`/`fork_hash` columns {@link forkLog}
   * populates — the LOG lineage surface (trajectory-fork provenance), distinct
   * from the state-DAG merge base a context fork shares. `head` defaults to the
   * log's primary head.
   */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getLogLineage(input: { logId: string; head?: string }): {
    parentLogId: string | null;
    forkSeq: number | null;
    forkHash: string | null;
  } {
    this.ensureReady();
    const row = this.logHeadRow(input.logId, input.head ?? CHANNEL_LOG_HEAD);
    return {
      parentLogId: row ? asString(row["parent_log_id"]) : null,
      forkSeq: row && row["fork_seq"] != null ? asNumber(row["fork_seq"]) : null,
      forkHash: row ? asString(row["fork_hash"]) : null,
    };
  }

  private logHeadRow(logId: string, head: string): JsonRecord | null {
    return (
      (this.sql
        .exec(`SELECT * FROM log_heads WHERE log_id = ? AND head = ?`, logId, head)
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  /** Current head pointer: ref target when present, else the fork point /
   *  genesis baseline. */
  private headPointer(
    logId: string,
    head: string,
    headRow?: JsonRecord | null
  ): { seq: number; hash: string; envelopeId: string | null } {
    const row = headRow ?? this.logHeadRow(logId, head);
    if (row) {
      return {
        seq: asNumber(row["current_seq"]),
        hash: asString(row["current_hash"]) ?? GENESIS_EVENT_HASH,
        envelopeId: asString(row["current_envelope_id"]),
      };
    }
    return { seq: 0, hash: GENESIS_EVENT_HASH, envelopeId: null };
  }

  /** Lineage segments, self first, each capped at the seq visible from the
   *  descendant chain. Cycle-guarded. */
  private logLineage(logId: string, head: string): LineageSegment[] {
    const segments: LineageSegment[] = [];
    const seen = new Set<string>();
    let currentLogId = logId;
    let currentHead = head;
    let cap = Number.POSITIVE_INFINITY;
    for (;;) {
      const key = `${currentLogId}\u0000${currentHead}`;
      if (seen.has(key)) throw new Error(`log lineage cycle at ${currentLogId}:${currentHead}`);
      seen.add(key);
      segments.push({ logId: currentLogId, head: currentHead, throughSeq: cap });
      const row = this.logHeadRow(currentLogId, currentHead);
      if (!row) break;
      const parentLogId = asString(row["parent_log_id"]);
      const parentHead = asString(row["parent_head"]);
      if (!parentLogId || !parentHead || row["fork_seq"] == null) break;
      cap = Math.min(cap, asNumber(row["fork_seq"]));
      currentLogId = parentLogId;
      currentHead = parentHead;
    }
    return segments;
  }

  /** Sync twin of the protocol's computeLogEnvelopeHash — same preimage
   *  builder, sync sha256 (workerd has no sync crypto and hashes are needed
   *  inside SQL transactions). */
  private computeEnvelopeHash(
    logId: string,
    head: string,
    seq: number,
    prevHash: string,
    semantic: Record<string, unknown>
  ): string {
    return sha256HexSyncText(logEnvelopeHashPreimage({ prevHash, logId, head, seq, semantic }));
  }

  /** The hash-covered slice — the protocol's logEnvelopeSemantic. */
  private semanticSlice(event: LogEnvelopeSemanticInput): Record<string, unknown> {
    return logEnvelopeSemantic(event);
  }

  /**
   * Field-level diff of two semantic slices — names which compared field(s)
   * diverge (and for `payload`, which sub-keys), with values truncated. Turns a
   * generic "id-collision: different content" into an actionable diagnostic:
   * an idempotent re-append (retry/redelivery) of the SAME envelope id must have
   * byte-identical semantic content, so any difference points at a non-deterministic
   * field leaking into the journal.
   */
  private describeSemanticDivergence(
    incoming: Record<string, unknown>,
    stored: Record<string, unknown>
  ): string {
    const isObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const trunc = (v: unknown): string => {
      const s = canonicalJson(v) ?? "undefined";
      return s.length > 160 ? `${s.slice(0, 160)}…(${s.length}b)` : s;
    };
    const parts: string[] = [];
    for (const key of new Set([...Object.keys(incoming), ...Object.keys(stored)])) {
      if (canonicalJson(incoming[key]) === canonicalJson(stored[key])) continue;
      if (key === "payload" && isObj(incoming[key]) && isObj(stored[key])) {
        const a = incoming[key] as Record<string, unknown>;
        const b = stored[key] as Record<string, unknown>;
        for (const pk of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (canonicalJson(a[pk]) === canonicalJson(b[pk])) continue;
          parts.push(`payload.${pk} (incoming=${trunc(a[pk])} stored=${trunc(b[pk])})`);
        }
      } else {
        parts.push(`${key} (incoming=${trunc(incoming[key])} stored=${trunc(stored[key])})`);
      }
    }
    return parts.length > 0
      ? parts.join(", ")
      : "(no field-level diff — likely appendedAt handling or stored-value encoding)";
  }

  private mapLogEnvelope(row: JsonRecord): LogEnvelope {
    return {
      logId: String(row["log_id"]),
      head: String(row["head"]),
      seq: asNumber(row["seq"]),
      envelopeId: brandId<EnvelopeId>(String(row["envelope_id"])),
      actor: parseRecord(asString(row["actor_json"])) as unknown as ParticipantRef,
      ...(row["to_json"] ? { to: parseJson(asString(row["to_json"])) as LogEnvelope["to"] } : {}),
      payloadKind: String(row["payload_kind"]),
      payload: parseJson(asString(row["payload_ref_json"])),
      ...(row["annotations_json"]
        ? { annotations: parseRecord(asString(row["annotations_json"])) }
        : {}),
      ...(row["causality_json"]
        ? { causality: parseRecord(asString(row["causality_json"])) as LogEventCausality }
        : {}),
      appendedAt: String(row["appended_at"]),
      prevHash: String(row["prev_hash"]),
      hash: String(row["hash"]),
    };
  }

  private logEventWhereForSegment(
    segment: LineageSegment,
    input: Pick<ReadLogInput, "afterSeq" | "beforeSeq" | "payloadKind">
  ): { where: string; bindings: SqlBinding[] } {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [segment.logId, segment.head, input.afterSeq ?? 0];
    if (Number.isFinite(segment.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(segment.throughSeq);
    }
    if (Number.isFinite(input.beforeSeq ?? Number.POSITIVE_INFINITY)) {
      clauses.push("seq < ?");
      bindings.push(input.beforeSeq ?? Number.POSITIVE_INFINITY);
    }
    if (input.payloadKind) {
      clauses.push("payload_kind = ?");
      bindings.push(input.payloadKind);
    }
    return { where: clauses.join(" AND "), bindings };
  }

  private lineageEventStats(input: ReadLogInput): LineageEventStats {
    let count = 0;
    let firstSeq: number | undefined;
    for (const segment of this.logLineage(input.logId, input.head)) {
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const row = this.sql
        .exec(
          `SELECT COUNT(*) AS cnt, MIN(seq) AS first_seq FROM log_events WHERE ${where}`,
          ...bindings
        )
        .one();
      const segmentCount = asNumber(row["cnt"]);
      count += segmentCount;
      if (segmentCount > 0) {
        const segmentFirst = asNumber(row["first_seq"]);
        firstSeq = firstSeq === undefined ? segmentFirst : Math.min(firstSeq, segmentFirst);
      }
    }
    return { count, ...(firstSeq !== undefined ? { firstSeq } : {}) };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  readLog(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit =
      input.limit != null && input.limit > 0 ? Math.max(Math.trunc(input.limit), 0) : null;
    const segments = this.logLineage(input.logId, input.head);
    const collected: LogEnvelope[] = [];
    // Ancestors hold the lowest seqs: walk root-first.
    for (const segment of [...segments].reverse()) {
      const remaining = limit != null ? limit - collected.length : null;
      if (remaining != null && remaining <= 0) return collected;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq ASC${
            remaining != null ? " LIMIT ?" : ""
          }`,
          ...(remaining != null ? [...bindings, remaining] : bindings)
        )
        .toArray() as JsonRecord[];
      for (const row of rows) {
        collected.push(this.mapLogEnvelope(row));
      }
    }
    return collected;
  }

  private readLogTail(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit = input.limit == null ? null : Math.max(Math.trunc(input.limit), 0);
    if (limit === 0) return [];
    if (limit == null) return this.readLog(input);
    const collected: JsonRecord[] = [];
    for (const segment of this.logLineage(input.logId, input.head)) {
      const remaining = limit - collected.length;
      if (remaining <= 0) break;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq DESC LIMIT ?`,
          ...bindings,
          remaining
        )
        .toArray() as JsonRecord[];
      collected.push(...rows);
    }
    return collected.reverse().map((row) => this.mapLogEnvelope(row));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getLogEvent(input: { logId: string; head: string; envelopeId: string }): LogEnvelope | null {
    this.ensureReady();
    const row = this.lineageEventRow(input.logId, input.head, input.envelopeId);
    return row ? this.mapLogEnvelope(row) : null;
  }

  private lineageEventRow(logId: string, head: string, envelopeId: string): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      const clauses = ["log_id = ?", "head = ?", "envelope_id = ?"];
      const bindings: SqlBinding[] = [segment.logId, segment.head, envelopeId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const row = this.sql
        .exec(`SELECT * FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`, ...bindings)
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }
  private lineageEventBySeq(logId: string, head: string, seq: number): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      if (Number.isFinite(segment.throughSeq) && seq > segment.throughSeq) continue;
      const row = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? AND seq = ? LIMIT 1`,
          segment.logId,
          segment.head,
          seq
        )
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }

  private lineageEventCountThrough(logId: string, head: string, throughSeq: number): number {
    let count = 0;
    for (const segment of this.logLineage(logId, head)) {
      const cap = Number.isFinite(segment.throughSeq)
        ? Math.min(segment.throughSeq, throughSeq)
        : throughSeq;
      count += asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS cnt FROM log_events WHERE log_id = ? AND head = ? AND seq <= ?`,
            segment.logId,
            segment.head,
            cap
          )
          .one()["cnt"]
      );
    }
    return count;
  }

  @rpc({ callers: ["do", "server"] })
  async appendLogEvent(input: AppendLogEventInput): Promise<AppendLogEventResult> {
    this.ensureReady();
    return this.transaction(() => this.appendLogEventInTxn(input));
  }

  private appendLogEventInTxn(input: AppendLogEventInput): AppendLogEventResult {
    if (!input.logId) throw new Error("appendLogEvent requires logId");
    if (!input.head) throw new Error("appendLogEvent requires head");
    if (!input.events.length) throw new Error("appendLogEvent requires at least one event");

    const existingHead = this.logHeadRow(input.logId, input.head);
    if (existingHead && String(existingHead["log_kind"]) !== String(input.logKind)) {
      throw new Error(
        `log kind mismatch for ${input.logId}:${input.head}: ` +
          `${String(existingHead["log_kind"])} != ${String(input.logKind)}`
      );
    }
    const logKind = existingHead ? String(existingHead["log_kind"]) : String(input.logKind);

    const prepared = input.events.map((event) => this.prepareLogEvent(logKind, event));

    // Lineage-scoped idempotent replay: skip the longest already-applied prefix.
    const replayed: LogEnvelope[] = [];
    for (const event of prepared) {
      const existing = existingHead
        ? this.lineageEventRow(input.logId, input.head, event.envelopeId)
        : null;
      if (!existing) break;
      const stored = this.mapLogEnvelope(existing);
      const incomingSemantic = this.semanticSlice({
        ...event,
        appendedAt: event.appendedAtExplicit ? event.appendedAt : stored.appendedAt,
      });
      const storedSemantic = this.semanticSlice(stored);
      if (canonicalJson(incomingSemantic) !== canonicalJson(storedSemantic)) {
        if (input.idempotency === "idempotent-by-id") {
          // Client retry with a stable id and volatile payload fields:
          // first write wins, the journaled original is the result.
          replayed.push(stored);
          continue;
        }
        const divergence = this.describeSemanticDivergence(incomingSemantic, storedSemantic);
        throw new Error(
          gadAppendErrorMessage(
            "id-collision",
            `log envelope id collision with different content: ${event.envelopeId} ` +
              `[log=${input.logId} head=${input.head}] diverged at → ${divergence}`
          )
        );
      }
      replayed.push(stored);
    }
    for (const event of prepared.slice(replayed.length)) {
      if (existingHead && this.lineageEventRow(input.logId, input.head, event.envelopeId)) {
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            `log append replay has already-applied events after a new suffix ` +
              `[log=${input.logId} head=${input.head} alreadyApplied=${event.envelopeId} ` +
              `replayedPrefix=${replayed.length}/${prepared.length}]`
          )
        );
      }
    }
    const remaining = prepared.slice(replayed.length);

    if (!existingHead) {
      this.sql.exec(
        `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.logId,
        input.head,
        logKind,
        json(input.owner ?? null),
        nowIso()
      );
    }

    const pointer = this.headPointer(input.logId, input.head);
    if (
      replayed.length === 0 &&
      "expectedHeadHash" in input &&
      (input.expectedHeadHash ?? GENESIS_EVENT_HASH) !== pointer.hash
    ) {
      throw new Error(
        gadAppendErrorMessage("head-conflict", `log head conflict for ${input.logId}:${input.head}`)
      );
    }
    if (remaining.length > 0 && replayed.length > 0) {
      const lastReplayed = replayed[replayed.length - 1]!;
      if (lastReplayed.hash !== pointer.hash) {
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            "log append replay prefix is not the current head"
          )
        );
      }
    }

    const published: AppendLogEventResult["published"] = [];
    // Recover the publication list for replayed events from the causality edges.
    for (const envelope of replayed) {
      for (const publication of this.publicationsForOrigin(
        input.logId,
        input.head,
        String(envelope.envelopeId)
      )) {
        published.push(publication);
      }
    }

    const appended: LogEnvelope[] = [];
    let seq = pointer.seq;
    let prevHash = pointer.hash;
    for (const event of remaining) {
      if (
        AGENTIC_LOG_KINDS.has(logKind) &&
        event.payloadKind === "turn.opened" &&
        event.causality?.turnId
      ) {
        this.assertTurnNotOpened(input.logId, input.head, event.causality.turnId, appended);
      }
      seq += 1;
      const semantic = this.semanticSlice(event);
      const hash = this.computeEnvelopeHash(input.logId, input.head, seq, prevHash, semantic);
      const envelope: LogEnvelope = {
        logId: input.logId,
        head: input.head,
        seq,
        envelopeId: brandId<EnvelopeId>(event.envelopeId),
        actor: event.actor,
        ...(event.to !== undefined ? { to: event.to } : {}),
        payloadKind: event.payloadKind,
        payload: event.payload,
        ...(event.annotations !== undefined ? { annotations: event.annotations } : {}),
        ...(event.causality !== undefined ? { causality: event.causality } : {}),
        appendedAt: event.appendedAt,
        prevHash,
        hash,
      };
      this.insertLogEvent(envelope);
      this.applyProjections(logKind, envelope);
      prevHash = hash;
      appended.push(envelope);

      for (const target of event.publish) {
        const pubEnvelopeId = `pub:${event.envelopeId}:${target.channelId}`;
        const result = this.appendLogEventInTxn({
          logId: target.channelId,
          head: CHANNEL_LOG_HEAD,
          logKind: "channel",
          events: [
            {
              envelopeId: pubEnvelopeId,
              actor: event.actor,
              to: (target.audience ?? null) as LogAppendEventInput["to"],
              payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
              payload: agenticEventFromEnvelope(envelope),
              causality: {
                originLogId: input.logId,
                originHead: input.head,
                originEnvelopeId: event.envelopeId,
              },
              appendedAt: event.appendedAt,
            },
          ],
        });
        void result;
        published.push({
          originEnvelopeId: event.envelopeId,
          channelId: target.channelId,
          envelopeId: pubEnvelopeId,
        });
      }
    }

    if (appended.length > 0) {
      const last = appended[appended.length - 1]!;
      this.sql.exec(
        `UPDATE log_heads
            SET current_seq = ?, current_hash = ?, current_envelope_id = ?
          WHERE log_id = ? AND head = ?`,
        last.seq,
        last.hash,
        String(last.envelopeId),
        input.logId,
        input.head
      );
    }

    const finalPointer = this.headPointer(input.logId, input.head);
    return {
      logId: input.logId,
      head: input.head,
      headSeq: finalPointer.seq,
      headHash: finalPointer.hash,
      envelopes: [...replayed, ...appended],
      published,
    };
  }

  private publicationsForOrigin(
    originLogId: string,
    originHead: string,
    originEnvelopeId: string
  ): AppendLogEventResult["published"] {
    const rows = this.sql
      .exec(
        `SELECT log_id, envelope_id FROM log_events
         WHERE origin_log_id = ? AND origin_head = ? AND origin_envelope_id = ?
         ORDER BY log_id ASC, seq ASC`,
        originLogId,
        originHead,
        originEnvelopeId
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => ({
      originEnvelopeId,
      channelId: String(row["log_id"]),
      envelopeId: String(row["envelope_id"]),
    }));
  }

  private assertTurnNotOpened(
    logId: string,
    head: string,
    turnId: string,
    pendingBatch: LogEnvelope[]
  ): void {
    for (const envelope of pendingBatch) {
      if (envelope.payloadKind === "turn.opened" && envelope.causality?.turnId === turnId) {
        throw new Error(`duplicate turn.opened for turn ${turnId}`);
      }
    }
    for (const segment of this.logLineage(logId, head)) {
      const clauses = ["log_id = ?", "head = ?", "payload_kind = 'turn.opened'", "turn_id = ?"];
      const bindings: SqlBinding[] = [segment.logId, segment.head, turnId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const exists = this.sql
        .exec(`SELECT 1 AS ok FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`, ...bindings)
        .toArray()[0];
      if (exists) throw new Error(`duplicate turn.opened for turn ${turnId}`);
    }
  }

  /** Validate + sanitize one append input into its storable form. */
  private prepareLogEvent(logKind: string, input: LogAppendEventInput): PreparedLogEvent {
    if (!input.payloadKind) throw new Error("appendLogEvent requires payloadKind");
    const envelopeId = input.envelopeId ?? crypto.randomUUID();
    const appendedAtExplicit = input.appendedAt != null;
    const appendedAt = input.appendedAt ?? nowIso();
    const actor = publicParticipantRef(input.actor) as ParticipantRef;
    const to = sanitizeAudience(input.to ?? undefined);
    let payload = input.payload;
    const causality = input.causality ?? undefined;
    let annotations = input.annotations ?? undefined;
    if (annotations && "metadata" in annotations && annotations["metadata"] != null) {
      annotations = {
        ...annotations,
        metadata: publicParticipantMetadata(annotations["metadata"] as Record<string, unknown>),
      };
    }

    const agenticKind = AGENTIC_LOG_KINDS.has(logKind) && isStoredEventKind(input.payloadKind);
    if (agenticKind) {
      const causalityForEvent = agenticCausality(causality);
      const reconstructed = storedAgenticEventSchema.parse({
        kind: input.payloadKind,
        actor: input.actor,
        ...(causality?.turnId ? { turnId: causality.turnId } : {}),
        ...(causalityForEvent ? { causality: causalityForEvent } : {}),
        payload,
        createdAt: appendedAt,
      }) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(reconstructed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = sanitizeRosterSnapshotPayload(sanitized.payload);
      if (STATE_TRANSITION_KINDS.has(input.payloadKind)) {
        this.assertStateTransitionPayloadValid(input.payloadKind, payload);
      }
    } else if (input.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      if (!isAgenticEventPayload(payload)) {
        throw new Error("agentic channel payload must be a stored agentic event");
      }
      const parsed = storedAgenticEventSchema.parse(payload) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(parsed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = {
        ...sanitized,
        payload: sanitizeRosterSnapshotPayload(sanitized.payload),
      };
    }

    return {
      envelopeId,
      appendedAtExplicit,
      actor,
      ...(to !== undefined ? { to } : {}),
      payloadKind: input.payloadKind,
      payload,
      ...(annotations !== undefined ? { annotations } : {}),
      ...(causality !== undefined ? { causality } : {}),
      appendedAt,
      publish: input.publish?.channels ?? [],
    };
  }

  /** Snapshot/merge events reference pre-created VALUES; reject appends whose
   *  output state does not exist. */
  private assertStateTransitionPayloadValid(payloadKind: string, payload: unknown): void {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const outputStateHash = asString(record["outputStateHash"]);
    if (!outputStateHash) {
      throw new Error(`${payloadKind} requires payload.outputStateHash`);
    }
    if (!this.stateExists(outputStateHash)) {
      throw new Error(`${payloadKind} output state value does not exist: ${outputStateHash}`);
    }
  }

  private insertLogEvent(envelope: LogEnvelope): void {
    this.sql.exec(
      `INSERT INTO log_events (
         log_id, head, seq, envelope_id, payload_kind, actor_json, to_json,
         causality_json, annotations_json, payload_ref_json, appended_at,
         hash, prev_hash, origin_log_id, origin_head, origin_envelope_id, turn_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.logId,
      envelope.head,
      envelope.seq,
      String(envelope.envelopeId),
      envelope.payloadKind,
      JSON.stringify(envelope.actor),
      envelope.to !== undefined ? JSON.stringify(envelope.to) : null,
      json(envelope.causality),
      json(envelope.annotations),
      JSON.stringify(envelope.payload),
      envelope.appendedAt,
      envelope.hash,
      envelope.prevHash,
      envelope.causality?.originLogId ?? null,
      envelope.causality?.originHead ?? null,
      envelope.causality?.originEnvelopeId ?? null,
      envelope.causality?.turnId ?? null
    );
    for (const { path, ref } of collectStoredValueRefs(envelope.payload)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO log_blob_refs (
           log_id, head, envelope_id, field_path, digest, purpose, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        String(envelope.envelopeId),
        path,
        ref.digest,
        "payload",
        ref.size,
        nowIso()
      );
      this.ensureBlob(
        ref.digest,
        ref.size,
        ref.encoding === "json" ? "application/json" : "text/plain"
      );
    }
  }

  @rpc({ callers: ["do", "server"] })
  forkLog(input: ForkLogInput): ForkLogResult {
    this.ensureReady();
    return this.transaction(() => {
      if (!input.fromLogId || !input.fromHead) throw new Error("forkLog requires a source");
      if (!input.toLogId || !input.toHead) throw new Error("forkLog requires a target");
      if (input.fromLogId === input.toLogId && input.fromHead === input.toHead) {
        throw new Error("forkLog requires distinct source and target");
      }
      const sourceRow = this.logHeadRow(input.fromLogId, input.fromHead);
      if (!sourceRow) {
        throw new Error(`forkLog source does not exist: ${input.fromLogId}:${input.fromHead}`);
      }
      const sourcePointer = this.headPointer(input.fromLogId, input.fromHead, sourceRow);
      const forkSeq = input.atSeq ?? sourcePointer.seq;
      if (forkSeq > sourcePointer.seq) {
        throw new Error(`forkLog atSeq ${forkSeq} is beyond the source head ${sourcePointer.seq}`);
      }
      let forkHash = GENESIS_EVENT_HASH;
      let forkEnvelopeId: string | null = null;
      if (forkSeq > 0) {
        const eventRow = this.lineageEventBySeq(input.fromLogId, input.fromHead, forkSeq);
        if (!eventRow) throw new Error(`forkLog atSeq ${forkSeq} not found in source lineage`);
        forkHash = String(eventRow["hash"]);
        forkEnvelopeId = String(eventRow["envelope_id"]);
      }

      const existing = this.logHeadRow(input.toLogId, input.toHead);
      if (existing) {
        if (
          asString(existing["parent_log_id"]) !== input.fromLogId ||
          asString(existing["parent_head"]) !== input.fromHead ||
          asNumber(existing["fork_seq"]) !== forkSeq ||
          asString(existing["fork_hash"]) !== forkHash
        ) {
          throw new Error(
            `target log already exists with different fork lineage: ${input.toLogId}:${input.toHead}`
          );
        }
        return {
          fromLogId: input.fromLogId,
          fromHead: input.fromHead,
          toLogId: input.toLogId,
          toHead: input.toHead,
          forkSeq,
          forkHash,
          inherited: this.lineageEventCountThrough(input.toLogId, input.toHead, forkSeq),
        };
      }

      const logKind = String(sourceRow["log_kind"]);
      this.sql.exec(
        `INSERT INTO log_heads (
           log_id, head, log_kind, owner_json, parent_log_id, parent_head,
           fork_seq, fork_hash, current_seq, current_hash, current_envelope_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.toLogId,
        input.toHead,
        logKind,
        json(input.owner ?? parseJson(asString(sourceRow["owner_json"]))),
        input.fromLogId,
        input.fromHead,
        forkSeq,
        forkHash,
        forkSeq,
        forkHash,
        forkEnvelopeId,
        nowIso()
      );

      // Seed the child's projection caches (P1: caches, rebuildable) by folding
      // the inherited lineage view under the child key. No log rows are copied.
      const inherited = this.readLog({
        logId: input.toLogId,
        head: input.toHead,
        limit: 0,
      });
      for (const envelope of inherited) {
        this.applyProjections(logKind, {
          ...envelope,
          logId: input.toLogId,
          head: input.toHead,
        });
      }

      return {
        fromLogId: input.fromLogId,
        fromHead: input.fromHead,
        toLogId: input.toLogId,
        toHead: input.toHead,
        forkSeq,
        forkHash,
        inherited: inherited.length,
      };
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async checkLogIntegrity(
    input: { logId?: string | null; head?: string | null } = {}
  ): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    this.ensureReady();
    const errors: JsonRecord[] = [];
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.logId) {
      clauses.push("log_id = ?");
      bindings.push(input.logId);
    }
    if (input.head) {
      clauses.push("head = ?");
      bindings.push(input.head);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const heads = this.sql
      .exec(`SELECT * FROM log_heads ${where} ORDER BY log_id, head`, ...bindings)
      .toArray() as JsonRecord[];
    for (const headRow of heads) {
      const logId = String(headRow["log_id"]);
      const head = String(headRow["head"]);
      const startSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
      const startHash = asString(headRow["fork_hash"]) ?? GENESIS_EVENT_HASH;
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq ASC`,
          logId,
          head
        )
        .toArray() as JsonRecord[];
      let expectedSeq = startSeq;
      let prevHash = startHash;
      for (const row of rows) {
        const envelope = this.mapLogEnvelope(row);
        expectedSeq += 1;
        if (envelope.seq !== expectedSeq) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq gap: expected ${expectedSeq}, found ${envelope.seq}`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
          expectedSeq = envelope.seq;
        }
        if (envelope.prevHash !== prevHash) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq ${envelope.seq} prevHash does not link`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        const recomputed = this.computeEnvelopeHash(
          logId,
          head,
          envelope.seq,
          envelope.prevHash,
          this.semanticSlice(envelope)
        );
        if (recomputed !== envelope.hash) {
          errors.push({
            type: "log-hash",
            message: `log ${logId}:${head} seq ${envelope.seq} hash mismatch (${String(envelope.envelopeId)})`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        prevHash = envelope.hash;
      }
      const pointer = this.headPointer(logId, head, headRow);
      const lastSeq = rows.length > 0 ? asNumber(rows[rows.length - 1]!["seq"]) : startSeq;
      const lastHash = rows.length > 0 ? String(rows[rows.length - 1]!["hash"]) : startHash;
      if (pointer.seq !== lastSeq || pointer.hash !== lastHash) {
        errors.push({
          type: "log-head-pointer",
          message: `log head pointer disagrees with the stored chain for ${logId}:${head}`,
          logId,
          head,
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Projections (caches over the log — P1; rebuildable at any time — P3)
  // -------------------------------------------------------------------------

  private applyProjections(logKind: string, envelope: LogEnvelope): void {
    if (envelope.payloadKind === "presence") {
      this.applyChannelRosterProjection(envelope);
      return;
    }
    if (envelope.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      this.projectMessageTypeEvent(envelope);
      return;
    }
    if (!AGENTIC_LOG_KINDS.has(logKind) || !isStoredEventKind(envelope.payloadKind)) return;
    const kind = envelope.payloadKind;
    if (kind === "turn.opened" || kind === "turn.closed") {
      this.projectTurn(envelope);
      return;
    }
    if (kind.startsWith("message.")) {
      this.projectMessage(envelope);
      return;
    }
    if (kind.startsWith("invocation.")) {
      this.projectInvocation(envelope);
      return;
    }
    if (kind.startsWith("approval.")) {
      this.projectApproval(envelope);
      return;
    }
    if (STATE_TRANSITION_KINDS.has(kind)) {
      this.projectStateTransition(envelope);
      return;
    }
    if (kind.startsWith("knowledge.")) {
      this.projectKnowledge(envelope);
    }
  }

  private projectTurn(envelope: LogEnvelope): void {
    const turnId = envelope.causality?.turnId;
    if (!turnId) return;
    const payload = envelope.payload as JsonRecord;
    if (envelope.payloadKind === "turn.opened") {
      // §6.3 turn-decay basis: stamp the per-branch ordinal = count of prior
      // turns on this (log_id, head). Fork-fold seeds inherited turns first (via
      // copyProjectionKey), so ordinals stay monotone along the branch chain.
      const priorTurns = asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS n FROM trajectory_turns WHERE log_id = ? AND head = ?`,
            envelope.logId,
            envelope.head
          )
          .one()["n"]
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_turns (log_id, head, turn_id, opened_at, summary, ordinal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        turnId,
        envelope.appendedAt,
        asString(payload["summary"]),
        priorTurns
      );
      // §7.3 speculative warm: precompute moderate blocks for the session's
      // likely-next files into the disposable cache. Best-effort, never authority.
      this.warmProvenanceForTurn(envelope.logId, envelope.head);
      return;
    }
    this.sql.exec(
      `INSERT INTO trajectory_turns (log_id, head, turn_id, closed_at, summary)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, turn_id) DO UPDATE SET
         closed_at = excluded.closed_at,
         summary = COALESCE(excluded.summary, trajectory_turns.summary)`,
      envelope.logId,
      envelope.head,
      turnId,
      envelope.appendedAt,
      asString(payload["summary"])
    );
  }

  private projectMessage(envelope: LogEnvelope): void {
    const messageId = envelope.causality?.messageId;
    if (!messageId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT role FROM trajectory_messages WHERE log_id = ? AND head = ? AND message_id = ?`,
        envelope.logId,
        envelope.head,
        messageId
      )
      .toArray()[0] as JsonRecord | undefined;
    const status =
      kind === "message.completed"
        ? "completed"
        : kind === "message.failed"
          ? "failed"
          : kind === "message.delta"
            ? "streaming"
            : "started";
    this.sql.exec(
      `INSERT INTO trajectory_messages (
         log_id, head, message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, message_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_messages.turn_id, excluded.turn_id),
         role = COALESCE(excluded.role, trajectory_messages.role),
         status = excluded.status,
         started_event_id = COALESCE(trajectory_messages.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_messages.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      messageId,
      envelope.causality?.turnId ?? null,
      asString(payload["role"]) ?? asString(existing?.["role"]) ?? envelope.actor.kind,
      status,
      kind === "message.started" ? String(envelope.envelopeId) : null,
      kind === "message.completed" || kind === "message.failed"
        ? String(envelope.envelopeId)
        : null,
      nowIso()
    );

    const blocks = Array.isArray(payload["blocks"]) ? payload["blocks"] : [];
    const memoryTexts: string[] = [];
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return;
      const record = block as JsonRecord;
      const blockId = asString(record["blockId"]) ?? `${messageId}:block:${index}`;
      this.sql.exec(
        `INSERT OR REPLACE INTO trajectory_message_blocks (
           log_id, head, block_id, message_id, block_index, block_type, invocation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        blockId,
        messageId,
        index,
        asString(record["type"]) ?? "data",
        asString(record["invocationId"])
      );
      if (record["type"] === "text" && typeof record["content"] === "string") {
        memoryTexts.push(record["content"]);
      }
    });
    // Memory index (WS4): completed message text becomes searchable.
    if (kind === "message.completed" && memoryTexts.length > 0) {
      this.indexMemoryRow({
        text: memoryTexts.join("\n"),
        kind: "message",
        logId: envelope.logId,
        head: envelope.head,
        eventId: String(envelope.envelopeId),
        anchor: { messageId, turnId: envelope.causality?.turnId ?? null },
      });
    }
  }

  private projectInvocation(envelope: LogEnvelope): void {
    const invocationId = envelope.causality?.invocationId;
    if (!invocationId) return;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT * FROM trajectory_invocations WHERE log_id = ? AND head = ? AND invocation_id = ?`,
        envelope.logId,
        envelope.head,
        invocationId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (
      TERMINAL_INVOCATION_KINDS.has(kind) &&
      existing &&
      TERMINAL_INVOCATION_KINDS.has(`invocation.${String(existing["status"])}`)
    ) {
      if (
        this.matchesExistingTerminalInvocation(envelope, existing) ||
        this.matchesExistingTerminalProjection(envelope, existing)
      ) {
        return;
      }
      throw new Error(`duplicate terminal invocation event for ${invocationId}`);
    }
    const payload = envelope.payload as JsonRecord;
    if (kind === "invocation.output" || kind === "invocation.progress") {
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_invocation_outputs (
           log_id, head, invocation_id, seq, chunk_ref_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        invocationId,
        envelope.seq,
        JSON.stringify(payload),
        envelope.appendedAt
      );
    }
    this.sql.exec(
      `INSERT INTO trajectory_invocations (
         log_id, head, invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome,
         terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, invocation_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_invocations.turn_id, excluded.turn_id),
         transport_call_id = COALESCE(excluded.transport_call_id, trajectory_invocations.transport_call_id),
         kind = COALESCE(excluded.kind, trajectory_invocations.kind),
         status = excluded.status,
         terminal_outcome = COALESCE(excluded.terminal_outcome, trajectory_invocations.terminal_outcome),
         terminal_reason_code = COALESCE(excluded.terminal_reason_code, trajectory_invocations.terminal_reason_code),
         request_ref_json = COALESCE(excluded.request_ref_json, trajectory_invocations.request_ref_json),
         result_ref_json = COALESCE(excluded.result_ref_json, trajectory_invocations.result_ref_json),
         started_event_id = COALESCE(trajectory_invocations.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_invocations.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      invocationId,
      envelope.causality?.turnId ?? null,
      envelope.causality?.transportCallId ?? null,
      asString(payload["name"]),
      kind.replace("invocation.", ""),
      asString(payload["terminalOutcome"]),
      asString(payload["terminalReasonCode"]),
      kind === "invocation.started" ? json(payload["request"]) : null,
      kind === "invocation.completed" ? json(payload["result"]) : null,
      kind === "invocation.started" ? String(envelope.envelopeId) : null,
      TERMINAL_INVOCATION_KINDS.has(kind) ? String(envelope.envelopeId) : null,
      nowIso()
    );
  }

  private matchesExistingTerminalInvocation(envelope: LogEnvelope, existing: JsonRecord): boolean {
    const completedEventId = asString(existing["completed_event_id"]);
    if (!completedEventId) return false;
    const priorRow = this.lineageEventRow(envelope.logId, envelope.head, completedEventId);
    if (!priorRow) return false;
    const prior = this.mapLogEnvelope(priorRow);
    return (
      terminalInvocationSignatureFromEnvelope(prior) ===
      terminalInvocationSignatureFromEnvelope(envelope)
    );
  }

  private matchesExistingTerminalProjection(envelope: LogEnvelope, existing: JsonRecord): boolean {
    const payload = envelope.payload as JsonRecord;
    const nextStatus = envelope.payloadKind.replace("invocation.", "");
    if (asString(existing["status"]) !== nextStatus) return false;
    if (asString(existing["terminal_outcome"]) !== asString(payload["terminalOutcome"])) {
      return false;
    }
    // The first terminal event owns the projection. Later terminals with the
    // same status/outcome can be replays from runner recovery; preserve the
    // first row, keep the raw duplicate in the log.
    return true;
  }

  private projectApproval(envelope: LogEnvelope): void {
    const approvalId = envelope.causality?.approvalId;
    if (!approvalId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const status =
      kind === "approval.resolved"
        ? payload["granted"] === true
          ? "granted"
          : "denied"
        : "requested";
    // Approvals resolve once: reject a second terminal against an already
    // granted/denied approval so a duplicate cannot overwrite the decision.
    if (kind === "approval.resolved") {
      const existing = this.sql
        .exec(
          `SELECT status FROM trajectory_approvals WHERE log_id = ? AND head = ? AND approval_id = ?`,
          envelope.logId,
          envelope.head,
          approvalId
        )
        .toArray()[0] as JsonRecord | undefined;
      const existingStatus = existing ? String(existing["status"]) : null;
      if (existingStatus === "granted" || existingStatus === "denied") {
        throw new Error(`duplicate terminal approval event for ${approvalId}`);
      }
    }
    this.sql.exec(
      `INSERT INTO trajectory_approvals (
         log_id, head, approval_id, invocation_id, status, requested_by_json, resolved_by_json,
         requested_event_id, resolved_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, approval_id) DO UPDATE SET
         status = excluded.status,
         resolved_by_json = COALESCE(excluded.resolved_by_json, trajectory_approvals.resolved_by_json),
         resolved_event_id = COALESCE(excluded.resolved_event_id, trajectory_approvals.resolved_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      approvalId,
      envelope.causality?.invocationId ?? null,
      status,
      kind === "approval.requested" ? JSON.stringify(envelope.actor) : null,
      kind === "approval.resolved" ? json(payload["resolvedBy"]) : null,
      kind === "approval.requested" ? String(envelope.envelopeId) : null,
      kind === "approval.resolved" ? String(envelope.envelopeId) : null,
      nowIso()
    );
  }

  /** Generic state-transition projector (P5 applied to worktree events):
   *  snapshot ingest and merge transitions are handled uniformly — parent rows
   *  and ref advance included. */
  private projectStateTransition(envelope: LogEnvelope): void {
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const eventId = String(envelope.envelopeId);
    const invocationId = envelope.causality?.invocationId ?? null;
    const inputStateHash =
      asString(payload["inputStateHash"]) ?? this.latestStateHash(envelope.logId, envelope.head);
    const extraParents = Array.isArray(payload["parentStateHashes"])
      ? (payload["parentStateHashes"] as unknown[]).map((value) => String(value))
      : [];
    const extraParentEventIds = Array.isArray(payload["parentEventIds"])
      ? (payload["parentEventIds"] as unknown[]).map((value) => String(value))
      : [];
    const previousHead = this.resolveWorktreeHeadInternal(envelope.logId, envelope.head);

    const declared = asString(payload["outputStateHash"]);
    if (!declared) throw new Error(`${kind} requires payload.outputStateHash`);
    if (!this.stateExists(declared)) {
      throw new Error(`${kind} output state value does not exist: ${declared}`);
    }
    const outputStateHash = declared;

    this.sql.exec(
      `INSERT OR IGNORE INTO gad_state_transitions (
         event_id, invocation_id, input_state_hash, output_state_hash,
         summary, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      invocationId,
      inputStateHash,
      outputStateHash,
      asString(payload["summary"]),
      JSON.stringify(payload),
      envelope.appendedAt
    );
    const parents = [
      {
        stateHash: inputStateHash,
        eventId:
          previousHead?.stateHash === inputStateHash
            ? previousHead.commitEventId
            : this.latestProducerEventId(inputStateHash),
      },
      ...extraParents.map((parentStateHash, index) => ({
        stateHash: parentStateHash,
        eventId: extraParentEventIds[index] ?? this.latestProducerEventId(parentStateHash),
      })),
    ];
    parents.forEach((parent, ordinal) => {
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_transition_parents (event_id, parent_state_hash, parent_event_id, ordinal)
         VALUES (?, ?, ?, ?)`,
        eventId,
        parent.stateHash,
        parent.eventId,
        ordinal
      );
    });

    this.setWorktreeHead(envelope.logId, envelope.head, outputStateHash, eventId);

    // T3 (§10): the mandatory commit message is the cheapest high-quality
    // semantic signal in the system, so index it into the recall leg. Every
    // message-carrying commit kind qualifies — transition_recorded/merge_applied
    // always carry one, snapshot_ingested only when present — so gate on a
    // non-empty summary. The row is event-id-keyed, so replay is idempotent
    // (indexMemoryRow deletes the prior copy before re-inserting).
    const summary = asString(payload["summary"]);
    if (summary && summary.trim()) {
      this.indexMemoryRow({
        text: summary,
        kind: "commit",
        logId: envelope.logId,
        head: envelope.head,
        eventId,
        anchor: { commitEventId: eventId, outputStateHash },
      });
    }
  }

  /**
   * §8.1: knowledge.* projector. Claim CONTENT is the durable ledger's system
   * of record; the trajectory event carries only causality + a `ledgerEntryId`
   * pointer (plus minimal denorm). Content is resolved through the ledger entry
   * when present, falling back to the event payload for producer-inline claims
   * that never wrote a ledger row (those are era-scoped, not resurrected on a
   * schema bump). All rows are global (keyed by claim_id / event_id, never
   * head), so fork-fold replay under a rewritten head stays correct.
   */
  private projectKnowledge(envelope: LogEnvelope): void {
    if (envelope.payloadKind === "knowledge.claims_related") {
      this.projectClaimRelations(envelope);
      return;
    }
    if (!envelope.payloadKind.startsWith("knowledge.claim_")) return;
    const payload = envelope.payload as JsonRecord;
    const ledgerEntryId = asString(payload["ledgerEntryId"]);
    const ledger = ledgerEntryId ? this.readLedgerEntry(ledgerEntryId) : null;
    // Ledger payload is the system of record; the event payload is the denorm
    // fallback when a claim was appended without a ledger entry.
    const content = (ledger?.payload ?? payload) as JsonRecord;
    const claimId =
      asString(payload["claimId"]) ??
      asString(content["claimId"]) ??
      asString(payload["id"]) ??
      String(envelope.envelopeId);
    this.applyClaimContent({
      claimId,
      eventKind: envelope.payloadKind,
      content,
      trajectoryEventId: String(envelope.envelopeId),
      invocationId: envelope.causality?.invocationId ?? null,
      ledgerEntryId,
      logId: envelope.logId,
      head: envelope.head,
      at: envelope.appendedAt,
    });
  }

  /** Materialize one claim's content into gad_claims + the claim FTS row.
   *  Shared by projectKnowledge (within an era) and the ledger rebuild (across
   *  a schema bump) — the only difference is where `content`/causality come
   *  from (trajectory event vs. ledger payload). */
  private applyClaimContent(input: {
    claimId: string;
    eventKind: string; // knowledge.claim_recorded | _updated | _retracted
    content: JsonRecord;
    trajectoryEventId: string;
    invocationId: string | null;
    ledgerEntryId: string | null;
    logId: string | null;
    head: string | null;
    at: string;
  }): void {
    if (input.eventKind === "knowledge.claim_retracted") {
      // Status change only — keep the content pointer (ledger_entry_id) pointing
      // at the claim's record/revise entry, not this retract entry.
      this.sql.exec(
        `UPDATE gad_claims
            SET status = 'retracted', trajectory_event_id = ?, updated_at = ?
          WHERE claim_id = ?`,
        input.trajectoryEventId,
        input.at,
        input.claimId
      );
      // §8.1: a retracted claim must stop surfacing — drop its FTS row so the
      // dedup-on-write probe and recall never resurrect it (the structural legs
      // already filter status!='retracted'; the FTS leg has no status column).
      this.ensureMemoryIndex();
      this.sql.exec(
        `DELETE FROM gad_memory_fts WHERE kind = 'claim' AND anchor_json = ?`,
        JSON.stringify({ claimId: input.claimId })
      );
      return;
    }
    if (
      input.eventKind !== "knowledge.claim_recorded" &&
      input.eventKind !== "knowledge.claim_updated"
    ) {
      return;
    }
    const content = input.content;
    const subject = asString(content["subject"]);
    const predicate = asString(content["predicate"]);
    const object = asString(content["object"]);
    const text = asString(content["text"]);
    const claimKind = asString(content["claimKind"]) ?? asString(content["kind"]);
    const status = asString(content["status"]) ?? "active";
    this.sql.exec(
      `INSERT INTO gad_claims (
         claim_id, trajectory_event_id, invocation_id, subject, predicate, object,
         claim_kind, text, ledger_entry_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET
         trajectory_event_id = excluded.trajectory_event_id,
         invocation_id = COALESCE(excluded.invocation_id, gad_claims.invocation_id),
         subject = COALESCE(excluded.subject, gad_claims.subject),
         predicate = COALESCE(excluded.predicate, gad_claims.predicate),
         object = COALESCE(excluded.object, gad_claims.object),
         claim_kind = COALESCE(excluded.claim_kind, gad_claims.claim_kind),
         text = COALESCE(excluded.text, gad_claims.text),
         ledger_entry_id = COALESCE(excluded.ledger_entry_id, gad_claims.ledger_entry_id),
         status = excluded.status,
         updated_at = excluded.updated_at`,
      input.claimId,
      input.trajectoryEventId,
      input.invocationId,
      subject,
      predicate,
      object,
      claimKind,
      text,
      input.ledgerEntryId,
      status,
      input.at,
      input.at
    );
    // Memory index (WS4): claims are the semantic sidecar's retrieval surface,
    // and the dedup-on-write signal. One FTS row per claim (deduped by claimId).
    // Index the MERGED row (not just this event's fields) so a partial revise
    // never truncates the searchable text to the patched slice.
    const merged = this.sql
      .exec(
        `SELECT subject, predicate, object, text FROM gad_claims WHERE claim_id = ?`,
        input.claimId
      )
      .toArray()[0] as JsonRecord | undefined;
    const claimText = merged
      ? this.claimSearchText({
          text: asString(merged["text"]),
          subject: asString(merged["subject"]),
          predicate: asString(merged["predicate"]),
          object: asString(merged["object"]),
        })
      : this.claimSearchText({ text, subject, predicate, object });
    if (claimText) {
      this.indexMemoryRow({
        text: claimText,
        kind: "claim",
        logId: input.logId,
        head: input.head,
        eventId: input.trajectoryEventId,
        anchor: { claimId: input.claimId },
      });
    }
  }

  /** §8: project a knowledge.claims_related event into gad_claim_relations.
   *  Event-keyed + INSERT OR IGNORE, so replay/fork-fold folds the same event
   *  under multiple heads without duplicating edges. */
  private projectClaimRelations(envelope: LogEnvelope): void {
    const payload = envelope.payload as JsonRecord;
    const ledgerEntryId = asString(payload["ledgerEntryId"]);
    const ledger = ledgerEntryId ? this.readLedgerEntry(ledgerEntryId) : null;
    const source = (ledger?.payload ?? payload) as JsonRecord;
    const relations = Array.isArray(source["relations"]) ? (source["relations"] as unknown[]) : [];
    // Key by the durable ledger entry id (not the trajectory envelope id) when
    // one exists, so this projection and the schema-bump ledger rebuild agree on
    // the unique identity — combining them never duplicates an edge. Inline
    // (ledger-less) relations fall back to the era-scoped envelope id.
    this.writeClaimRelations(
      ledgerEntryId ?? String(envelope.envelopeId),
      relations,
      envelope.appendedAt
    );
  }

  private writeClaimRelations(eventKey: string, relations: unknown[], at: string): void {
    for (const raw of relations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const rel = raw as JsonRecord;
      const src = asString(rel["src"]);
      const relation = asString(rel["relation"]);
      const dst = asString(rel["dst"]);
      if (!src || !relation || !dst) continue;
      const weight = typeof rel["weight"] === "number" ? rel["weight"] : 1;
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_claim_relations
           (event_id, src_claim_id, relation, dst_claim_id, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        eventKey,
        src,
        relation,
        dst,
        weight,
        at
      );
    }
  }

  // -------------------------------------------------------------------------
  // Knowledge ledger (§8.1) — the durable, schema-era-outliving claim system
  // of record. Ledger writes + a trajectory `knowledge.*` causality event are
  // one txn; projectKnowledge folds the event, resolving content through here.
  // -------------------------------------------------------------------------

  private readLedgerEntry(
    entryId: string
  ): { kind: string; payload: JsonRecord; anchor: JsonRecord } | null {
    const row = this.sql
      .exec(
        `SELECT kind, payload_json, anchor_json FROM gad_knowledge_ledger WHERE entry_id = ?`,
        entryId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return {
      kind: String(row["kind"]),
      payload: parseRecord(asString(row["payload_json"])),
      anchor: parseRecord(asString(row["anchor_json"])),
    };
  }

  private appendLedgerEntry(input: {
    entryId: string;
    kind: "claim_recorded" | "claim_revised" | "claim_retracted" | "claims_related";
    payload: Record<string, unknown>;
    anchor: Record<string, unknown>;
    createdAt: string;
  }): void {
    const next = asNumber(
      this.sql.exec(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM gad_knowledge_ledger`).one()[
        "next"
      ]
    );
    this.sql.exec(
      `INSERT INTO gad_knowledge_ledger (entry_id, seq, kind, payload_json, anchor_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.entryId,
      next,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.anchor),
      input.createdAt
    );
  }

  /** §8.1 rebuild: after a schema bump the trajectory events are gone but the
   *  ledger survived — replay it in seq order to re-project gad_claims,
   *  gad_claim_relations, and the claim FTS rows. Dangling era causality
   *  (logId/head/trajectoryEventId) is preserved from the ledger snapshot. */
  private rebuildClaimsFromLedger(): void {
    this.ensureMemoryIndex();
    const rows = this.sql
      .exec(
        `SELECT entry_id, kind, payload_json, created_at
           FROM gad_knowledge_ledger ORDER BY seq ASC, entry_id ASC`
      )
      .toArray() as JsonRecord[];
    for (const row of rows) {
      const kind = String(row["kind"]);
      const payload = parseRecord(asString(row["payload_json"]));
      const at = asString(row["created_at"]) ?? nowIso();
      const entryId = String(row["entry_id"]);
      if (kind === "claims_related") {
        const relations = Array.isArray(payload["relations"])
          ? (payload["relations"] as unknown[])
          : [];
        this.writeClaimRelations(entryId, relations, at);
        continue;
      }
      const eventKind =
        kind === "claim_retracted"
          ? "knowledge.claim_retracted"
          : kind === "claim_revised"
            ? "knowledge.claim_updated"
            : "knowledge.claim_recorded";
      this.applyClaimContent({
        claimId: asString(payload["claimId"]) ?? entryId,
        eventKind,
        content: payload,
        trajectoryEventId: asString(payload["trajectoryEventId"]) ?? entryId,
        invocationId: asString(payload["invocationId"]),
        ledgerEntryId: entryId,
        logId: asString(payload["logId"]),
        head: asString(payload["head"]),
        at,
      });
    }
  }

  private claimSearchText(claim: {
    text?: string | null;
    subject?: string | null;
    predicate?: string | null;
    object?: string | null;
  }): string {
    const text = asString(claim.text ?? null);
    if (text && text.trim()) return text.trim();
    return [claim.subject, claim.predicate, claim.object]
      .map((value) => asString(value ?? null))
      .filter((value): value is string => !!value && value.trim().length > 0)
      .join(" ")
      .trim();
  }

  /** §8.1 dedup-on-write: FTS the incoming text against existing claims, then
   *  score each candidate by token overlap. Returns candidates ranked by
   *  overlap (descending); the caller blocks on any candidate >= threshold. */
  private findDuplicateClaims(
    text: string
  ): Array<{ claimId: string; text: string; score: number }> {
    const mode = this.ensureMemoryIndex();
    let rows: JsonRecord[] = [];
    if (mode === "fts") {
      const match = sanitizeFtsQuery(text);
      if (!match) return [];
      rows = this.sql
        .exec(
          `SELECT text, anchor_json FROM gad_memory_fts
            WHERE gad_memory_fts MATCH ? AND kind = 'claim'
            ORDER BY bm25(gad_memory_fts) LIMIT ?`,
          match,
          CLAIM_DEDUP_TOP_K
        )
        .toArray() as JsonRecord[];
    } else {
      const terms = text
        .split(/\s+/u)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (terms.length === 0) return [];
      const likeClauses = terms.map(() => `text LIKE ? ESCAPE '\\'`).join(" AND ");
      rows = this.sql
        .exec(
          `SELECT text, anchor_json FROM gad_memory_fts
            WHERE kind = 'claim' AND ${likeClauses} LIMIT ?`,
          ...terms.map((term) => `%${term.replace(/[%_\\]/gu, "\\$&")}%`),
          CLAIM_DEDUP_TOP_K
        )
        .toArray() as JsonRecord[];
    }
    const queryTokens = claimTokenSet(text);
    const candidates = rows
      .map((row) => {
        const anchor = parseRecord(asString(row["anchor_json"]));
        const candidateText = String(row["text"]);
        return {
          claimId: asString(anchor["claimId"]) ?? "",
          text: candidateText,
          score: jaccardOverlap(queryTokens, claimTokenSet(candidateText)),
        };
      })
      .filter((candidate) => candidate.claimId);
    // §8.1: never dedup against a retracted claim (its FTS row is dropped on
    // retract, but guard the query leg too so a stale row can't block a rewrite).
    const retracted = this.retractedClaimIds(candidates.map((c) => c.claimId));
    return candidates
      .filter((candidate) => !retracted.has(candidate.claimId))
      .sort((a, b) => b.score - a.score);
  }

  /** The subset of the given claim ids whose claim is currently retracted.
   *  Used to keep retracted claims out of the FTS-backed dedup/recall legs (the
   *  FTS row is deleted on retract; this is the belt-and-suspenders query guard). */
  private retractedClaimIds(ids: Array<string | null | undefined>): Set<string> {
    const out = new Set<string>();
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return out;
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.sql
      .exec(
        `SELECT claim_id FROM gad_claims WHERE status = 'retracted' AND claim_id IN (${placeholders})`,
        ...unique
      )
      .toArray() as JsonRecord[];
    for (const row of rows) out.add(String(row["claim_id"]));
    return out;
  }

  /** The trajectory log's owner as a plain {kind,id} — the claim's actor. Falls
   *  back to an `agent` participant (trajectory logs are agent-owned) since the
   *  transport caller kinds (server/shell/do/worker) are not participant kinds. */
  private trajectoryOwner(logId: string, head: string): { kind: string; id: string } {
    const row = this.logHeadRow(logId, head);
    const owner = row ? parseJson(asString(row["owner_json"])) : null;
    if (owner && typeof owner === "object" && !Array.isArray(owner)) {
      const record = owner as JsonRecord;
      const kind = asString(record["kind"]);
      const id = asString(record["id"]);
      if (id) return { kind: PARTICIPANT_KINDS.has(kind ?? "") ? (kind as string) : "agent", id };
    }
    return { kind: "agent", id: logId };
  }

  /** §8.1 anchor snapshot: denormalize the human-readable provenance at write
   *  time so a dangling era anchor still renders after a schema bump. */
  private buildClaimAnchor(input: {
    owner: { kind: string; id: string };
    repoPath?: string | null;
    commitEventId?: string | null;
    at: string;
  }): Record<string, unknown> {
    const anchor: Record<string, unknown> = {
      actorLabel: `${input.owner.kind}:${input.owner.id}`,
      recordedAt: input.at,
    };
    if (input.repoPath) anchor["repoPath"] = input.repoPath;
    if (input.commitEventId) {
      anchor["commitEventId"] = input.commitEventId;
      const summary = asString(
        this.sql
          .exec(`SELECT summary FROM gad_state_transitions WHERE event_id = ?`, input.commitEventId)
          .toArray()[0]?.["summary"] ?? null
      );
      if (summary) anchor["commitMessage"] = summary.split(/\r?\n/u)[0];
    }
    return anchor;
  }

  private bumpProvMetric(metric: string, bucket: string): void {
    this.sql.exec(
      `INSERT INTO gad_prov_metrics (metric, bucket, count, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(metric, bucket) DO UPDATE SET
         count = gad_prov_metrics.count + 1,
         updated_at = excluded.updated_at`,
      metric,
      bucket,
      nowIso()
    );
  }

  /**
   * §4.2 soft-signal upsert: record that a session touched a target. One counted
   * row per (kind, session, target) on `idx_touches_coalesce`; a repeat bumps
   * `hits` and refreshes the latest producing invocation, the touching turn's
   * ordinal, and — for `observed` touches — the re-read-suppression block sig
   * (§7.1). COALESCE keeps a prior value when a fresh call omits the field, so
   * `turn_seq`/`last_invocation_id`/`last_block_sig` track the LATEST touch that
   * carried them. `observed` (read attachment) and `cited` (drill-down claim
   * target) are distinct kinds, hence distinct coalesced rows.
   */
  private upsertTouch(input: {
    kind: "observed" | "cited";
    sessionLogId: string;
    sessionHead: string;
    dstKind: "file" | "claim";
    dstId: string;
    invocationId?: string | null;
    turnSeq?: number | null;
    blockSig?: string | null;
  }): void {
    const now = nowIso();
    this.sql.exec(
      `INSERT INTO gad_touches (
         kind, session_log_id, session_head, dst_kind, dst_id,
         last_invocation_id, turn_seq, hits, last_block_sig, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(kind, session_log_id, session_head, dst_kind, dst_id) DO UPDATE SET
         hits = gad_touches.hits + 1,
         last_invocation_id = COALESCE(excluded.last_invocation_id, gad_touches.last_invocation_id),
         turn_seq = COALESCE(excluded.turn_seq, gad_touches.turn_seq),
         last_block_sig = COALESCE(excluded.last_block_sig, gad_touches.last_block_sig),
         updated_at = excluded.updated_at`,
      input.kind,
      input.sessionLogId,
      input.sessionHead,
      input.dstKind,
      input.dstId,
      input.invocationId ?? null,
      input.turnSeq ?? null,
      input.blockSig ?? null,
      now,
      now
    );
    // §7.3 warm-cache era stamp: touch_version marks the session's DENSITY-SEED
    // era, not its read count. A `cited` drill adds a strong claim seed (§6.1)
    // that re-ranks every other file's density leg, so it advances the stamp and
    // invalidates the warm cache. An `observed` read does NOT bump it: the version
    // is session-global, so bumping on every read would throw away the whole
    // turn.opened warm precompute after the first file touched and leave the
    // degrade stash unservable (the counter would already have moved past it by
    // the follow-on read). The safety- and redundancy-critical legs never ride on
    // this stamp — exceptions are recomputed LIVE on every read (§7.5) and re-read
    // suppression has its own block-signature key (§7.1) — so a stale density era
    // can never hide a contradiction, a cross-session collision, or a real change.
    // Claim writes advance the stamp through their own paths (they add/relate the
    // asserted seeds the density leg spreads from).
    if (input.kind === "cited") {
      this.bumpTouchVersion(input.sessionLogId, input.sessionHead);
    }
  }

  /** §7.3 per-session touch_version (state KV). Advances on every touch write;
   *  the warm cache stamps each row with the value it was computed under so a
   *  later read invalidates by comparison (never by content). */
  private touchVersionKey(sessionLogId: string, sessionHead: string): string {
    return `touchver:${sessionLogId}::${sessionHead}`;
  }

  private touchVersion(sessionLogId: string, sessionHead: string): number {
    const raw = this.getStateValue(this.touchVersionKey(sessionLogId, sessionHead));
    return raw == null ? 0 : asNumber(raw);
  }

  private bumpTouchVersion(sessionLogId: string, sessionHead: string): void {
    const next = this.touchVersion(sessionLogId, sessionHead) + 1;
    this.setStateValue(this.touchVersionKey(sessionLogId, sessionHead), String(next));
  }

  private knowledgeVersionKey(): string {
    return "knowledgever";
  }

  private knowledgeVersion(): number {
    const raw = this.getStateValue(this.knowledgeVersionKey());
    return raw == null ? 0 : asNumber(raw);
  }

  private bumpKnowledgeVersion(): void {
    const next = this.knowledgeVersion() + 1;
    this.setStateValue(this.knowledgeVersionKey(), String(next));
  }

  /**
   * §6.3 turn-decay basis: the highest turn ordinal stamped on this (log_id,
   * head) branch (projectTurn stamps `ordinal` = count of prior turns; fork-fold
   * seeds inherited turns, so ordinals stay monotone along the chain). DO-4 uses
   * this to compute `turnsAgo` for the session-recency leg and to stamp
   * `gad_touches.turn_seq`. Returns -1 when the branch has opened no turns yet.
   */
  private currentTurnOrdinal(logId: string, head: string): number {
    const max = this.sql
      .exec(
        `SELECT MAX(ordinal) AS m FROM trajectory_turns WHERE log_id = ? AND head = ?`,
        logId,
        head
      )
      .one()["m"];
    return max == null ? -1 : asNumber(max);
  }

  // -------------------------------------------------------------------------
  // Knowledge write path (§8.1 / C2) — one @rpc per tool. Each does ledger
  // write + a trajectory `knowledge.*` causality event in one txn; content of
  // record is the ledger, the event carries only the pointer + minimal denorm.
  // -------------------------------------------------------------------------

  @rpc({ callers: ["do", "server", "shell", "worker"] })
  knowledgeRecordClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claim: {
      text?: string | null;
      subject?: string | null;
      predicate?: string | null;
      object?: string | null;
      kind?: string | null;
    };
    anchor?: { commitEventId?: string | null; repoPath?: string | null } | null;
    force?: boolean | null;
  }): {
    claimId?: string;
    ledgerEntryId?: string;
    duplicates: Array<{ claimId: string; text: string; score: number }>;
  } {
    this.ensureReady();
    if (!input.logId || !input.head) {
      throw new Error("knowledgeRecordClaim requires logId and head");
    }
    const claim = input.claim ?? {};
    const searchText = this.claimSearchText(claim);
    if (!searchText) {
      throw new Error("knowledgeRecordClaim requires claim text or subject/predicate/object");
    }
    // Dedup-on-write: read-only FTS probe BEFORE the write. A near-duplicate
    // (and no `force`) returns the candidates without recording — the agent
    // revises/relates instead of forking a near-identical node.
    const duplicates = this.findDuplicateClaims(searchText);
    const nearDuplicate = duplicates.some((c) => c.score >= CLAIM_DEDUP_MIN_OVERLAP);
    if (nearDuplicate && !input.force) {
      return { duplicates };
    }
    return this.transaction(() => {
      const at = nowIso();
      const owner = this.trajectoryOwner(input.logId, input.head);
      const claimId = `claim-${crypto.randomUUID()}`;
      const ledgerEntryId = crypto.randomUUID();
      const trajectoryEventId = crypto.randomUUID();
      const anchor = this.buildClaimAnchor({
        owner,
        repoPath: input.anchor?.repoPath,
        commitEventId: input.anchor?.commitEventId,
        at,
      });
      this.appendLedgerEntry({
        entryId: ledgerEntryId,
        kind: "claim_recorded",
        payload: {
          claimId,
          text: claim.text ?? null,
          subject: claim.subject ?? null,
          predicate: claim.predicate ?? null,
          object: claim.object ?? null,
          claimKind: claim.kind ?? null,
          status: "active",
          logId: input.logId,
          head: input.head,
          trajectoryEventId,
          invocationId: input.invocationId ?? null,
        },
        anchor,
        createdAt: at,
      });
      this.appendLogEventInTxn({
        logId: input.logId,
        head: input.head,
        logKind: "trajectory",
        owner,
        events: [
          {
            envelopeId: trajectoryEventId,
            actor: owner as unknown as ParticipantRef,
            payloadKind: "knowledge.claim_recorded",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId,
              ledgerEntryId,
              ...(claim.text ? { text: claim.text } : {}),
              ...(claim.subject ? { subject: claim.subject } : {}),
              ...(claim.predicate ? { predicate: claim.predicate } : {}),
              ...(claim.object ? { object: claim.object } : {}),
              ...(claim.kind ? { kind: claim.kind } : {}),
              status: "active",
            },
            ...(input.invocationId
              ? { causality: { invocationId: brandId<InvocationId>(input.invocationId) } }
              : {}),
            appendedAt: at,
          },
        ],
      });
      // §12 counter #3: claims recorded, split commit-borne vs standalone.
      this.bumpProvMetric("claims_recorded", input.anchor?.commitEventId ? "commit" : "standalone");
      // Claim content is a global density input; invalidate every warm cache era
      // that was computed against the previous claim graph.
      this.bumpKnowledgeVersion();
      // §7.3 density-seed era: a new asserted claim re-seeds this session's
      // spreading activation (§6.1), so invalidate its warm density cache.
      this.bumpTouchVersion(input.logId, input.head);
      return { claimId, ledgerEntryId, duplicates };
    });
  }

  @rpc({ callers: ["do", "server", "shell", "worker"] })
  knowledgeRelateClaims(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    relations: Array<{ src: string; relation: string; dst: string; weight?: number | null }>;
  }): { ledgerEntryId: string; related: number } {
    this.ensureReady();
    if (!input.logId || !input.head) {
      throw new Error("knowledgeRelateClaims requires logId and head");
    }
    if (!input.relations || input.relations.length === 0) {
      throw new Error("knowledgeRelateClaims requires at least one relation");
    }
    return this.transaction(() => {
      const at = nowIso();
      const owner = this.trajectoryOwner(input.logId, input.head);
      const ledgerEntryId = crypto.randomUUID();
      const trajectoryEventId = crypto.randomUUID();
      const relations = input.relations.map((rel) => ({
        src: rel.src,
        relation: rel.relation,
        dst: rel.dst,
        ...(rel.weight != null ? { weight: rel.weight } : {}),
      }));
      const anchor = this.buildClaimAnchor({ owner, at });
      this.appendLedgerEntry({
        entryId: ledgerEntryId,
        kind: "claims_related",
        payload: {
          relations,
          logId: input.logId,
          head: input.head,
          trajectoryEventId,
          invocationId: input.invocationId ?? null,
        },
        anchor,
        createdAt: at,
      });
      this.appendLogEventInTxn({
        logId: input.logId,
        head: input.head,
        logKind: "trajectory",
        owner,
        events: [
          {
            envelopeId: trajectoryEventId,
            actor: owner as unknown as ParticipantRef,
            payloadKind: "knowledge.claims_related",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, ledgerEntryId, relations },
            ...(input.invocationId
              ? { causality: { invocationId: brandId<InvocationId>(input.invocationId) } }
              : {}),
            appendedAt: at,
          },
        ],
      });
      // §7.3 density-seed era: new claim↔claim relations change the edges the
      // §6.1 spread traverses (and the contradiction set), so invalidate the
      // session's warm density cache.
      this.bumpKnowledgeVersion();
      this.bumpTouchVersion(input.logId, input.head);
      return { ledgerEntryId, related: relations.length };
    });
  }

  @rpc({ callers: ["do", "server", "shell", "worker"] })
  knowledgeReviseClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claimId: string;
    patch: {
      text?: string | null;
      subject?: string | null;
      predicate?: string | null;
      object?: string | null;
      kind?: string | null;
    };
  }): { claimId: string; ledgerEntryId: string } {
    this.ensureReady();
    if (!input.logId || !input.head) {
      throw new Error("knowledgeReviseClaim requires logId and head");
    }
    if (!input.claimId) throw new Error("knowledgeReviseClaim requires claimId");
    const patch = input.patch ?? {};
    return this.transaction(() => {
      const at = nowIso();
      const owner = this.trajectoryOwner(input.logId, input.head);
      const ledgerEntryId = crypto.randomUUID();
      const trajectoryEventId = crypto.randomUUID();
      const anchor = this.buildClaimAnchor({ owner, at });
      this.appendLedgerEntry({
        entryId: ledgerEntryId,
        kind: "claim_revised",
        payload: {
          claimId: input.claimId,
          // Only carry the patched fields so replay applies a partial update.
          ...(patch.text != null ? { text: patch.text } : {}),
          ...(patch.subject != null ? { subject: patch.subject } : {}),
          ...(patch.predicate != null ? { predicate: patch.predicate } : {}),
          ...(patch.object != null ? { object: patch.object } : {}),
          ...(patch.kind != null ? { claimKind: patch.kind } : {}),
          logId: input.logId,
          head: input.head,
          trajectoryEventId,
          invocationId: input.invocationId ?? null,
        },
        anchor,
        createdAt: at,
      });
      this.appendLogEventInTxn({
        logId: input.logId,
        head: input.head,
        logKind: "trajectory",
        owner,
        events: [
          {
            envelopeId: trajectoryEventId,
            actor: owner as unknown as ParticipantRef,
            payloadKind: "knowledge.claim_updated",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: input.claimId,
              ledgerEntryId,
              ...(patch.text != null ? { text: patch.text } : {}),
              ...(patch.subject != null ? { subject: patch.subject } : {}),
              ...(patch.predicate != null ? { predicate: patch.predicate } : {}),
              ...(patch.object != null ? { object: patch.object } : {}),
              ...(patch.kind != null ? { kind: patch.kind } : {}),
            },
            ...(input.invocationId
              ? { causality: { invocationId: brandId<InvocationId>(input.invocationId) } }
              : {}),
            appendedAt: at,
          },
        ],
      });
      // Claim content is rendered into cacheable density items; a revise must
      // invalidate both the global claim graph era and this session's seed era.
      this.bumpKnowledgeVersion();
      this.bumpTouchVersion(input.logId, input.head);
      return { claimId: input.claimId, ledgerEntryId };
    });
  }

  @rpc({ callers: ["do", "server", "shell", "worker"] })
  knowledgeRetractClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claimId: string;
  }): { claimId: string; ledgerEntryId: string } {
    this.ensureReady();
    if (!input.logId || !input.head) {
      throw new Error("knowledgeRetractClaim requires logId and head");
    }
    if (!input.claimId) throw new Error("knowledgeRetractClaim requires claimId");
    return this.transaction(() => {
      const at = nowIso();
      const owner = this.trajectoryOwner(input.logId, input.head);
      const ledgerEntryId = crypto.randomUUID();
      const trajectoryEventId = crypto.randomUUID();
      const anchor = this.buildClaimAnchor({ owner, at });
      this.appendLedgerEntry({
        entryId: ledgerEntryId,
        kind: "claim_retracted",
        payload: {
          claimId: input.claimId,
          logId: input.logId,
          head: input.head,
          trajectoryEventId,
          invocationId: input.invocationId ?? null,
        },
        anchor,
        createdAt: at,
      });
      this.appendLogEventInTxn({
        logId: input.logId,
        head: input.head,
        logKind: "trajectory",
        owner,
        events: [
          {
            envelopeId: trajectoryEventId,
            actor: owner as unknown as ParticipantRef,
            payloadKind: "knowledge.claim_retracted",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: input.claimId,
              ledgerEntryId,
            },
            ...(input.invocationId
              ? { causality: { invocationId: brandId<InvocationId>(input.invocationId) } }
              : {}),
            appendedAt: at,
          },
        ],
      });
      // A retracted claim must stop surfacing from any cached density leg.
      this.bumpKnowledgeVersion();
      this.bumpTouchVersion(input.logId, input.head);
      return { claimId: input.claimId, ledgerEntryId };
    });
  }

  private applyChannelRosterProjection(envelope: LogEnvelope): void {
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as JsonRecord)
        : {};
    const action = asString(payload["action"]);
    if (action !== "join" && action !== "update" && action !== "leave") return;
    const actor = envelope.actor as unknown as JsonRecord;
    const participantId = asString(actor["participantId"]) ?? asString(actor["id"]);
    if (!participantId) return;
    const channelId = envelope.logId;
    const metadata = parseRecord(
      JSON.stringify(
        payload["metadata"] ?? envelope.annotations?.["metadata"] ?? actor["metadata"] ?? null
      )
    );
    const rolesJson =
      Object.keys(metadata).length > 0 ? JSON.stringify(sortForCanonicalJson(metadata)) : null;
    const openRow = this.sql
      .exec(
        `SELECT joined_at FROM channel_roster
         WHERE channel_id = ? AND participant_id = ? AND left_at IS NULL
         ORDER BY joined_at DESC
         LIMIT 1`,
        channelId,
        participantId
      )
      .toArray()[0] as JsonRecord | undefined;

    if (action === "join") {
      if (openRow) {
        if (rolesJson) {
          this.sql.exec(
            `UPDATE channel_roster
             SET roles_json = ?
             WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
            rolesJson,
            channelId,
            participantId,
            String(openRow["joined_at"])
          );
        }
        return;
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_roster (channel_id, participant_id, joined_at, roles_json)
         VALUES (?, ?, ?, ?)`,
        channelId,
        participantId,
        envelope.appendedAt,
        rolesJson
      );
      return;
    }

    if (!openRow) return;
    if (action === "update") {
      if (rolesJson) {
        this.sql.exec(
          `UPDATE channel_roster
           SET roles_json = ?
           WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
          rolesJson,
          channelId,
          participantId,
          String(openRow["joined_at"])
        );
      }
      return;
    }

    this.sql.exec(
      `UPDATE channel_roster
       SET left_at = COALESCE(left_at, ?),
           roles_json = COALESCE(?, roles_json)
       WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
      envelope.appendedAt,
      rolesJson,
      channelId,
      participantId,
      String(openRow["joined_at"])
    );
  }

  // -------------------------------------------------------------------------
  // Recursive manifests & worktree states (content-addressed VALUES — P1)
  // -------------------------------------------------------------------------

  private latestStateHash(logId: string, head: string): string {
    return this.resolveWorktreeHeadInternal(logId, head)?.stateHash ?? EMPTY_STATE_HASH;
  }

  private ensureFileVersion(path: string, contentHash: string, mode: number): number {
    this.ensureBlob(contentHash);
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_file_versions (path, content_hash, mode, created_at)
       VALUES (?, ?, ?, ?)`,
      path,
      contentHash,
      mode,
      nowIso()
    );
    return asNumber(
      this.sql
        .exec(
          `SELECT id FROM gad_file_versions WHERE path = ? AND content_hash = ? AND mode = ?`,
          path,
          contentHash,
          mode
        )
        .one()["id"]
    );
  }

  private manifestRootForState(stateHash: string): string {
    const state = this.sql
      .exec(`SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!state) throw new Error(`Unknown worktree state: ${stateHash}`);
    return asString(state["manifest_root_hash"]) ?? EMPTY_MANIFEST_HASH;
  }

  /** Whether this store has recorded a worktree state (known lineage). */
  private hasWorktreeState(stateHash: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM gad_worktree_states WHERE state_hash = ? LIMIT 1`, stateHash)
        .toArray().length > 0
    );
  }

  private manifestEntries(manifestHash: string): JsonRecord[] {
    return this.sql
      .exec(
        `SELECT e.name, e.entry_kind, e.child_manifest_hash, e.file_version_id,
                f.content_hash, f.mode
         FROM gad_manifest_entries e
         LEFT JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.manifest_hash = ?
         ORDER BY e.name ASC`,
        manifestHash
      )
      .toArray() as JsonRecord[];
  }

  /** Canonical content hash of a dir node from its entry list. */
  private manifestHashForEntries(
    entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number }
      | { name: string; kind: "dir"; childHash: string }
    >
  ): string {
    // Shared implementation — MUST stay byte-identical to the server-side
    // local hashing (see @workspace/agentic-protocol worktree-hash.ts).
    return manifestHashForEntries(entries);
  }

  private storeManifestNode(
    entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number; fileVersionId: number }
      | { name: string; kind: "dir"; childHash: string }
    >
  ): string {
    const hash = this.manifestHashForEntries(
      entries.map((entry) =>
        entry.kind === "file"
          ? { name: entry.name, kind: "file", contentHash: entry.contentHash, mode: entry.mode }
          : { name: entry.name, kind: "dir", childHash: entry.childHash }
      )
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (manifest_hash, kind, created_at) VALUES (?, 'dir', ?)`,
      hash,
      nowIso()
    );
    for (const entry of entries) {
      this.sql.exec(
        `INSERT OR REPLACE INTO gad_manifest_entries (
           manifest_hash, name, entry_kind, child_manifest_hash, file_version_id
         ) VALUES (?, ?, ?, ?, ?)`,
        hash,
        entry.name,
        entry.kind,
        entry.kind === "dir" ? entry.childHash : null,
        entry.kind === "file" ? entry.fileVersionId : null
      );
    }
    return hash;
  }

  /** Build a recursive manifest tree from a flat file list; returns root hash.
   *  Structural sharing falls out of content addressing (OR IGNORE). */
  private createManifestTree(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>
  ): string {
    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, { fileVersionId: number; contentHash: string; mode: number }>;
    }
    const root: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const segments = file.path.split("/");
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, {
        fileVersionId: file.fileVersionId,
        contentHash: file.contentHash,
        mode: file.mode,
      });
    }
    const build = (node: DirNode): string => {
      const entries: Array<
        | { name: string; kind: "file"; contentHash: string; mode: number; fileVersionId: number }
        | { name: string; kind: "dir"; childHash: string }
      > = [];
      for (const [name, child] of node.dirs) {
        entries.push({ name, kind: "dir", childHash: build(child) });
      }
      for (const [name, file] of node.files) {
        entries.push({ name, kind: "file", ...file });
      }
      return this.storeManifestNode(entries);
    };
    if (files.length === 0) {
      this.ensureEmptyState();
      return EMPTY_MANIFEST_HASH;
    }
    return build(root);
  }

  private stateHashForRoot(rootHash: string): string {
    return stateHashForRoot(rootHash);
  }

  private createWorktreeState(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>,
    metadata: Record<string, unknown>
  ): string {
    const rootHash = this.createManifestTree(files);
    const stateHash = this.stateHashForRoot(rootHash);
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?)`,
      stateHash,
      rootHash,
      JSON.stringify(metadata),
      nowIso()
    );
    return stateHash;
  }

  /** Resolve the manifest hash of the dir at `path` (root when empty). */
  private manifestDirAtPath(stateHash: string, path: string | null | undefined): string | null {
    let manifestHash = this.manifestRootForState(stateHash);
    if (!path) return manifestHash;
    for (const segment of normalizePath(path).split("/")) {
      const entry = this.sql
        .exec(
          `SELECT * FROM gad_manifest_entries WHERE manifest_hash = ? AND name = ? LIMIT 1`,
          manifestHash,
          segment
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!entry || entry["entry_kind"] !== "dir" || !entry["child_manifest_hash"]) return null;
      manifestHash = String(entry["child_manifest_hash"]);
    }
    return manifestHash;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listManifest(input: { stateHash: string; path?: string | null }): JsonRecord[] {
    this.ensureReady();
    const dirHash = this.manifestDirAtPath(input.stateHash, input.path);
    if (!dirHash) return [];
    return this.manifestEntries(dirHash).map(
      (entry): JsonRecord =>
        entry["entry_kind"] === "dir"
          ? {
              name: String(entry["name"]),
              kind: "dir",
              childManifestHash: String(entry["child_manifest_hash"]),
            }
          : {
              name: String(entry["name"]),
              kind: "file",
              fileVersionId: asNumber(entry["file_version_id"]),
              contentHash: String(entry["content_hash"]),
              mode: asNumber(entry["mode"]),
            }
    );
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  readGadFileAtState(input: { stateHash: string; path: string }): JsonRecord | null {
    this.ensureReady();
    const path = normalizePath(input.path);
    const segments = path.split("/");
    const dirHash = this.manifestDirAtPath(input.stateHash, segments.slice(0, -1).join("/"));
    if (!dirHash) return null;
    const entry = this.sql
      .exec(
        `SELECT e.*, f.content_hash, f.mode
         FROM gad_manifest_entries e
         LEFT JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.manifest_hash = ? AND e.name = ? AND e.entry_kind = 'file'
         LIMIT 1`,
        dirHash,
        segments[segments.length - 1]!
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!entry) return null;
    return {
      path,
      file_version_id: asNumber(entry["file_version_id"]),
      content_hash: String(entry["content_hash"]),
      mode: asNumber(entry["mode"]),
    };
  }

  private filesForState(stateHash: string): JsonRecord[] {
    const files: JsonRecord[] = [];
    const walk = (manifestHash: string, prefix: string): void => {
      for (const entry of this.manifestEntries(manifestHash)) {
        const name = String(entry["name"]);
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry["entry_kind"] === "dir") {
          const child = asString(entry["child_manifest_hash"]);
          if (child) walk(child, path);
        } else {
          files.push({
            path,
            file_version_id: asNumber(entry["file_version_id"]),
            content_hash: String(entry["content_hash"]),
            mode: asNumber(entry["mode"]),
          });
        }
      }
    };
    walk(this.manifestRootForState(stateHash), "");
    return files.sort((a, b) => String(a["path"]).localeCompare(String(b["path"])));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listGadBranchFiles(input: { branchId: string; trajectoryId?: string | null }): JsonRecord[] {
    this.ensureReady();
    const stateHash = input.trajectoryId
      ? this.latestStateHash(input.trajectoryId, input.branchId)
      : this.latestStateHashByHeadOnly(input.branchId);
    return this.filesForState(stateHash);
  }

  private latestStateHashByHeadOnly(head: string): string {
    const row = this.sql
      .exec(
        `SELECT state_hash FROM gad_worktree_heads WHERE head = ? ORDER BY updated_at DESC LIMIT 1`,
        head
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? String(row["state_hash"]) : EMPTY_STATE_HASH;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): {
    added: JsonRecord[];
    removed: JsonRecord[];
    changed: JsonRecord[];
  } {
    this.ensureReady();
    const added: JsonRecord[] = [];
    const removed: JsonRecord[] = [];
    const changed: JsonRecord[] = [];
    const collect = (manifestHash: string, prefix: string, sink: JsonRecord[]): void => {
      for (const entry of this.manifestEntries(manifestHash)) {
        const name = String(entry["name"]);
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry["entry_kind"] === "dir") {
          const child = asString(entry["child_manifest_hash"]);
          if (child) collect(child, path, sink);
        } else {
          sink.push({
            path,
            file_version_id: asNumber(entry["file_version_id"]),
            content_hash: String(entry["content_hash"]),
            mode: asNumber(entry["mode"]),
          });
        }
      }
    };
    const fileRecord = (entry: JsonRecord, path: string): JsonRecord => ({
      path,
      file_version_id: asNumber(entry["file_version_id"]),
      content_hash: String(entry["content_hash"]),
      mode: asNumber(entry["mode"]),
    });
    const walk = (leftHash: string | null, rightHash: string | null, prefix: string): void => {
      if (leftHash === rightHash) return; // structural-sharing prune
      const leftEntries = leftHash ? this.manifestEntries(leftHash) : [];
      const rightEntries = rightHash ? this.manifestEntries(rightHash) : [];
      const leftByName = new Map(leftEntries.map((entry) => [String(entry["name"]), entry]));
      const rightByName = new Map(rightEntries.map((entry) => [String(entry["name"]), entry]));
      for (const [name, rightEntry] of rightByName) {
        const path = prefix ? `${prefix}/${name}` : name;
        const leftEntry = leftByName.get(name);
        if (!leftEntry) {
          if (rightEntry["entry_kind"] === "dir") {
            const child = asString(rightEntry["child_manifest_hash"]);
            if (child) collect(child, path, added);
          } else {
            added.push(fileRecord(rightEntry, path));
          }
          continue;
        }
        if (leftEntry["entry_kind"] === "dir" && rightEntry["entry_kind"] === "dir") {
          walk(
            asString(leftEntry["child_manifest_hash"]),
            asString(rightEntry["child_manifest_hash"]),
            path
          );
        } else if (leftEntry["entry_kind"] === "file" && rightEntry["entry_kind"] === "file") {
          if (
            leftEntry["content_hash"] !== rightEntry["content_hash"] ||
            leftEntry["mode"] !== rightEntry["mode"]
          ) {
            changed.push({
              path,
              before: fileRecord(leftEntry, path),
              after: fileRecord(rightEntry, path),
            });
          }
        } else {
          if (leftEntry["entry_kind"] === "dir") {
            const child = asString(leftEntry["child_manifest_hash"]);
            if (child) collect(child, path, removed);
            added.push(fileRecord(rightEntry, path));
          } else {
            removed.push(fileRecord(leftEntry, path));
            const child = asString(rightEntry["child_manifest_hash"]);
            if (child) collect(child, path, added);
          }
        }
      }
      for (const [name, leftEntry] of leftByName) {
        if (rightByName.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (leftEntry["entry_kind"] === "dir") {
          const child = asString(leftEntry["child_manifest_hash"]);
          if (child) collect(child, path, removed);
        } else {
          removed.push(fileRecord(leftEntry, path));
        }
      }
    };
    walk(
      this.manifestRootForState(input.leftStateHash),
      this.manifestRootForState(input.rightStateHash),
      ""
    );
    return { added, removed, changed };
  }

  /** Full recursive file listing of a worktree state (vcs materialize; the
   *  git-bridge extension's listing fallback for pre-mirroring states). */
  @rpc({ callers: ["panel", "do", "worker", "server", "extension"] })
  listStateFiles(input: { stateHash: string }): JsonRecord[] {
    this.ensureReady();
    return this.filesForState(input.stateHash);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getGadStateProducer(input: { stateHash: string }): JsonRecord | null {
    this.ensureReady();
    return (
      (this.sql
        .exec(
          `SELECT * FROM gad_state_transitions WHERE output_state_hash = ? ORDER BY created_at DESC LIMIT 1`,
          input.stateHash
        )
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getGadStateTransition(input: { eventId: string }): JsonRecord | null {
    this.ensureReady();
    return (
      (this.sql
        .exec(`SELECT * FROM gad_state_transitions WHERE event_id = ?`, input.eventId)
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  /** The op union (provenance/intent) that authored a worktree state. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listWorktreeEditOps(input: { outputStateHash: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT ordinal, kind, path, old_content_hash, new_content_hash, hunks_json, mode
         FROM gad_worktree_edit_ops WHERE output_state_hash = ? ORDER BY ordinal ASC`,
        input.outputStateHash
      )
      .toArray() as JsonRecord[];
  }

  /** Validate a manifest tree recursively; report missing nodes and hash
   *  mismatches into `errors`. Returns the recomputed hash or null. */
  private recomputeManifestHashDeep(
    manifestHash: string,
    errors: JsonRecord[],
    seen: Map<string, string | null>
  ): string | null {
    const cached = seen.get(manifestHash);
    if (cached !== undefined) return cached;
    seen.set(manifestHash, null); // cycle guard
    const node = this.sql
      .exec(`SELECT kind FROM gad_manifest_nodes WHERE manifest_hash = ?`, manifestHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!node) {
      errors.push({
        type: "manifest",
        message: `missing manifest node ${manifestHash}`,
        manifestHash,
      });
      return null;
    }
    const entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number }
      | { name: string; kind: "dir"; childHash: string }
    > = [];
    let broken = false;
    for (const entry of this.manifestEntries(manifestHash)) {
      const name = String(entry["name"]);
      if (entry["entry_kind"] === "dir") {
        const childHash = asString(entry["child_manifest_hash"]);
        if (!childHash) {
          broken = true;
          continue;
        }
        const recomputedChild = this.recomputeManifestHashDeep(childHash, errors, seen);
        if (recomputedChild === null) {
          broken = true;
          continue;
        }
        entries.push({ name, kind: "dir", childHash: recomputedChild });
      } else {
        entries.push({
          name,
          kind: "file",
          contentHash: String(entry["content_hash"]),
          mode: asNumber(entry["mode"]),
        });
      }
    }
    if (broken) return null;
    const recomputed = this.manifestHashForEntries(entries);
    if (recomputed !== manifestHash) {
      errors.push({
        type: "manifest",
        message: `manifest hash mismatch for ${manifestHash}`,
        manifestHash,
        recomputed,
      });
    }
    seen.set(manifestHash, recomputed);
    return recomputed;
  }

  // -------------------------------------------------------------------------
  // Worktree ingest (out-of-band edits become first-class observed transitions)
  // -------------------------------------------------------------------------

  // "extension": the trusted git-bridge extension ingests git-import
  // history onto a NON-MAIN staging head (`import:*`); it is confined below
  // and can never touch a repo's protected `main` lineage. Main lineage
  // records are written ONLY by the DO's own publish path (the private
  // `ingestWorktreeStateInTxn`, reached via vcsPush/vcsMerge/vcsImportPublish),
  // never through this RPC surface. This structurally closes finding 2 (any
  // extension ingesting to main + an ungated adoption).
  @rpc({ callers: ["do", "server", "extension"] })
  async ingestWorktreeState(input: IngestWorktreeStateInput): Promise<{
    stateHash: string;
    eventId: string;
    headHash: string;
  }> {
    // READ-AT-ENTRY: capture the verified caller kind before any await.
    const callerKind = this.caller?.callerKind ?? null;
    const targetsRepoMain = input.logId.startsWith("vcs:repo:") && input.head === "main";
    // Confine sandboxed/extension callers to non-main staging heads: only the
    // trusted in-process host (`do`/`server`, e.g. fork-rename provenance,
    // group ingest, crash reconcile) may ingest onto a repo `main` lineage. An
    // over-RPC call always carries an attributed caller kind (the framework
    // refuses unattributed inbound RPC), so a present kind outside {do,server}
    // — in practice the git-bridge `extension` — is rejected here; a null kind
    // is an in-process/self call and is trusted. The DO's OWN publish path
    // writes main lineage through the private `ingestWorktreeStateInTxn`, never
    // this surface. This structurally closes finding 2.
    if (targetsRepoMain && callerKind !== null && callerKind !== "do" && callerKind !== "server") {
      throw new Error(
        `ingestWorktreeState: caller "${callerKind}" may not ingest onto a protected ` +
          `main lineage (${input.logId}). Ingest onto a non-main staging head and ` +
          `publish through vcs.push / the import-publish path.`
      );
    }
    this.ensureReady();
    return this.transaction(() => this.ingestWorktreeStateInTxn(input));
  }

  /** Body of a single worktree-state ingest, runnable inside an already-open
   *  transaction so a batch of ingests (ingestRepoGroup) commits all-or-none. */
  private ingestWorktreeStateInTxn(input: IngestWorktreeStateInput): {
    stateHash: string;
    eventId: string;
    headHash: string;
    headSeq: number;
  } {
    const currentHead = this.resolveWorktreeHeadInternal(input.logId, input.head);
    const currentStateHash = currentHead?.stateHash ?? EMPTY_STATE_HASH;
    if (
      input.expectedRefStateHash !== undefined &&
      input.expectedRefStateHash !== null &&
      input.expectedRefStateHash !== currentStateHash
    ) {
      // Repo `main` heads are NOT owned by this store: the server's
      // protected-ref service (RefService) is the single main authority,
      // and this store records main transitions as downstream PROVENANCE —
      // synchronously for user-initiated VCS ops, asynchronously through
      // the provenance follower for scan/freshness advances, and via the
      // ref→store reconciler after a crash gap. A strict head CAS here
      // would spuriously reject legitimate recording whenever this store
      // is (transiently, by design) behind the ref. So for main we treat
      // `expectedRefStateHash` as the CLAIMED PREDECESSOR instead of a
      // swap guard: the transition is accepted as long as it attaches to
      // lineage this store actually knows — the claimed predecessor must
      // be a recorded worktree state (or the empty state). An UNKNOWN
      // predecessor is genuinely inconsistent (the caller skipped
      // reconciliation, or the hash spaces diverged) and is still rejected
      // loudly. Non-main heads (ctx:*, archives) remain store-authoritative
      // and keep the strict CAS.
      const refOwnedMain = input.logId.startsWith("vcs:repo:") && input.head === "main";
      if (!refOwnedMain) {
        throw new Error(`worktree head CAS conflict: ${input.logId}:${input.head}`);
      }
      if (
        input.expectedRefStateHash !== EMPTY_STATE_HASH &&
        !this.hasWorktreeState(input.expectedRefStateHash)
      ) {
        throw new Error(
          `main provenance ingest for ${input.logId} claims unknown predecessor ` +
            `${input.expectedRefStateHash} — reconcile the store to the protected ref first`
        );
      }
    }
    const baseStateHash = input.baseStateHash ?? currentStateHash;
    const files = input.files.map((file) => {
      const path = normalizePath(file.path);
      const mode = file.mode ?? 33188;
      this.ensureBlob(file.contentHash, file.size ?? 0);
      return {
        path,
        contentHash: file.contentHash,
        mode,
        fileVersionId: this.ensureFileVersion(path, file.contentHash, mode),
      };
    });
    const stateHash = this.createWorktreeState(files, {
      ingest: true,
      ...(input.summary ? { summary: input.summary } : {}),
    });
    const existingLog = this.logHeadRow(input.logId, input.head);
    const logKind = existingLog
      ? String(existingLog["log_kind"])
      : String(input.logKind ?? "trajectory");
    const eventId = input.eventId ?? crypto.randomUUID();
    const result = this.appendLogEventInTxn({
      logId: input.logId,
      head: input.head,
      logKind,
      events: [
        {
          envelopeId: eventId,
          actor: input.actor,
          payloadKind: input.eventKind ?? "state.snapshot_ingested",
          payload: {
            protocol: "agentic.trajectory.v1",
            inputStateHash: baseStateHash,
            outputStateHash: stateHash,
            ...(input.parentStateHashes && input.parentStateHashes.length > 0
              ? { parentStateHashes: input.parentStateHashes }
              : {}),
            ...(input.parentEventIds && input.parentEventIds.length > 0
              ? { parentEventIds: input.parentEventIds }
              : {}),
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        },
      ],
    });
    if (input.editOps && input.editOps.length > 0) {
      // editOps passed to an ingest are COMMITTED rows (bootstrap/merge/fork
      // commits, and P3 push/merge provenance). The working edit→commit path
      // does NOT pass editOps — it re-keys pre-existing working rows in
      // commitRepo.
      const now = nowIso();
      const actorId = asString((input.actor as unknown as Record<string, unknown>)?.["id"]) ?? null;
      const actorJson = input.actor ? JSON.stringify(input.actor) : null;
      // A2 (U2): chain continuity vs the FIRST PARENT. Each non-synthetic op's
      // old_content_hash must equal the file's content in baseStateHash (the
      // first-parent tree). Only enforced when requested AND the base is locally
      // resolvable (main advances always attach to a recorded predecessor).
      if (input.validateFirstParentChain && this.hasWorktreeState(baseStateHash)) {
        const baseByPath = new Map<string, string>();
        for (const f of this.filesForState(baseStateHash)) {
          baseByPath.set(String(f["path"]), String(f["content_hash"]));
        }
        for (const op of input.editOps) {
          if (op.synthetic) continue;
          const path = normalizePath(op.path);
          const expected = baseByPath.get(path) ?? null;
          const claimed = op.oldContentHash ?? null;
          if (claimed !== expected) {
            throw new Error(
              `editOps chain continuity violation for ${input.logId}:${input.head} at ${path}: ` +
                `oldContentHash ${claimed ?? "∅"} does not match first-parent content ` +
                `${expected ?? "∅"} in ${baseStateHash}`
            );
          }
        }
      }
      input.editOps.forEach((op, ordinal) => {
        // U1: hunk completeness holds for ingest-supplied provenance ops too —
        // synthetic snapshot ops (import/push/whole-file takes) and binary rows
        // are the only text mutations allowed to omit hunks.
        assertHunkCompleteness(op, `${input.logId}:${input.head}`);
        this.sql.exec(
          `INSERT INTO gad_worktree_edit_ops (
               event_id, log_id, head, committed_event_id, committed_seq,
               edit_seq, output_state_hash, ordinal, kind, path,
               old_content_hash, new_content_hash, hunks_json, mode,
               actor_id, actor_json, invocation_id, turn_id, created_at, synthetic, binary
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eventId,
          input.logId,
          input.head,
          eventId,
          result.headSeq,
          stateHash,
          ordinal,
          op.kind,
          normalizePath(op.path),
          op.oldContentHash ?? null,
          op.newContentHash ?? null,
          op.hunks !== undefined ? JSON.stringify(op.hunks) : null,
          typeof op.mode === "number" ? op.mode : null,
          actorId,
          actorJson,
          input.invocationId ?? null,
          input.turnId ?? null,
          now,
          op.synthetic ? 1 : null,
          op.binary ? 1 : 0
        );
      });
    }
    return { stateHash, eventId, headHash: result.headHash, headSeq: result.headSeq };
  }

  /**
   * Atomic multi-head advance: ingest N worktree states across N (logId, head)
   * pairs inside ONE transaction. Every entry's CAS (expectedRefStateHash) +
   * state-create + log-append happens together — all heads advance or none do.
   * This is the store-level transaction boundary that backs per-repo GROUP
   * pushes; orchestrating N separate ingestWorktreeState RPCs could partially
   * commit and cannot give the all-or-none guarantee.
   */
  @rpc({ callers: ["do", "server"] })
  async ingestRepoGroup(input: { entries: IngestWorktreeStateInput[] }): Promise<{
    results: Array<{
      logId: string;
      head: string;
      stateHash: string;
      eventId: string;
      headHash: string;
    }>;
  }> {
    this.ensureReady();
    return this.transaction(() => ({
      results: input.entries.map((entry) => ({
        logId: entry.logId,
        head: entry.head,
        ...this.ingestWorktreeStateInTxn(entry),
      })),
    }));
  }

  // -------------------------------------------------------------------------
  // Working edits → commits (the edit/commit/push re-architecture)
  // -------------------------------------------------------------------------

  /** The committed state a `(logId, head)` ref currently points at, or null
   *  (no ref). The CAS anchor for working-edit inserts: a commit/merge that
   *  advances the head changes this WITHOUT changing MAX(edit_seq). */
  private resolveCommittedHeadState(logId: string, head: string): string | null {
    return this.resolveWorktreeHeadInternal(logId, head)?.stateHash ?? null;
  }

  /** The most-recent commit EVENT that produced a state (or null for the empty
   *  base / an unproduced state) — resolves a parent STATE to its parent EVENT
   *  for the event-keyed commit DAG. */
  private latestProducerEventId(stateHash: string): string | null {
    if (!stateHash || stateHash === EMPTY_STATE_HASH) return null;
    const row = this.sql
      .exec(
        `SELECT event_id FROM gad_state_transitions WHERE output_state_hash = ? ORDER BY created_at DESC LIMIT 1`,
        stateHash
      )
      .toArray()[0] as { event_id?: string } | undefined;
    return row?.event_id ?? null;
  }

  /**
   * EDIT persist (single DO txn). Insert composed edit-op rows as WORKING
   * (committed_event_id = NULL, output_state_hash = NULL) with a shared per-call
   * `edit_seq = MAX+1` per (log_id, head) and a synthetic per-call `event_id`.
   * CAS on BOTH `expectedEditSeq` (the uncommitted sequence) AND
   * `expectedCommitHead` (the committed ctx-head state, null if none) — a
   * concurrent commit/merge can move the committed head without changing
   * MAX(edit_seq), so checking only the seq would let a stale-base edit slip
   * through. On conflict {@link applyEditOps} recomputes the ops + retries.
   */
  private insertWorkingEditRows(input: {
    logId: string;
    head: string;
    actorId: string;
    actorJson: string;
    invocationId?: string | null;
    turnId?: string | null;
    eventId: string;
    ops: Array<{
      kind: string;
      path: string;
      oldContentHash?: string | null;
      newContentHash?: string | null;
      hunks?: unknown;
      mode?: number | null;
      /** U1 (Wave 1 engine flag): the op's NEW content is binary — no line
       *  structure, so hunks are legitimately absent and blame chain-restarts. */
      binary?: boolean | null;
    }>;
    expectedEditSeq: number;
    expectedCommitHead: string | null;
  }): { editSeq: number } {
    return this.transaction(() => {
      const curEditSeq = Number(
        (
          this.sql
            .exec(
              `SELECT COALESCE(MAX(edit_seq), 0) AS m FROM gad_worktree_edit_ops
               WHERE log_id = ? AND head = ? AND committed_event_id IS NULL`,
              input.logId,
              input.head
            )
            .toArray()[0] as { m: number }
        ).m ?? 0
      );
      if (curEditSeq !== input.expectedEditSeq) {
        throw new Error(
          `edit CAS conflict on ${input.head}: editSeq ${curEditSeq} != expected ${input.expectedEditSeq}`
        );
      }
      const curHead = this.resolveCommittedHeadState(input.logId, input.head);
      const expectedHead = input.expectedCommitHead ?? null;
      if ((curHead ?? null) !== expectedHead) {
        throw new Error(
          `edit CAS conflict on ${input.head}: committed head ${curHead ?? "∅"} != expected ${expectedHead ?? "∅"}`
        );
      }
      const editSeq = curEditSeq + 1;
      const now = nowIso();
      input.ops.forEach((op, ordinal) => {
        assertHunkCompleteness(op, `${input.logId}:${input.head}`);
        this.sql.exec(
          `INSERT INTO gad_worktree_edit_ops (
             event_id, log_id, head, committed_event_id, committed_seq,
             edit_seq, output_state_hash, ordinal, kind, path,
             old_content_hash, new_content_hash, hunks_json, mode,
             actor_id, actor_json, invocation_id, turn_id, created_at, binary
           ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.eventId,
          input.logId,
          input.head,
          editSeq,
          ordinal,
          op.kind,
          normalizePath(op.path),
          op.oldContentHash ?? null,
          op.newContentHash ?? null,
          op.hunks !== undefined ? JSON.stringify(op.hunks) : null,
          typeof op.mode === "number" ? op.mode : null,
          input.actorId,
          input.actorJson,
          input.invocationId ?? null,
          input.turnId ?? null,
          now,
          op.binary ? 1 : 0
        );
      });
      return { editSeq };
    });
  }

  // ── Working-content composition (P5c — the edit/commit semantics live HERE) ─

  /** Workspace repo path of a `vcs:repo:<path>` log id, or null. */
  private repoPathOfLog(logId: string): string | null {
    return logId.startsWith("vcs:repo:") ? logId.slice("vcs:repo:".length) : null;
  }

  /** A head's uncommitted edit rows, in replay order. */
  private workingEditRows(logId: string, head: string): JsonRecord[] {
    return this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops
         WHERE log_id = ? AND head = ? AND committed_event_id IS NULL
         ORDER BY edit_seq, ordinal`,
        logId,
        head
      )
      .toArray() as JsonRecord[];
  }

  /** Drop a head's uncommitted (working) edit-op rows and return how many were
   *  removed. Scoped to the exact (logId, head), committed rows untouched. Must
   *  be called inside a transaction by the caller when clearing a pending merge
   *  alongside it, so the abort is atomic. */
  private deleteUncommittedWorkingEdits(logId: string, head: string): number {
    const removed = Number(
      (
        this.sql
          .exec(
            `SELECT COUNT(*) AS c FROM gad_worktree_edit_ops
             WHERE log_id = ? AND head = ? AND committed_event_id IS NULL`,
            logId,
            head
          )
          .toArray()[0] as { c: number }
      ).c ?? 0
    );
    this.sql.exec(
      `DELETE FROM gad_worktree_edit_ops
       WHERE log_id = ? AND head = ? AND committed_event_id IS NULL`,
      logId,
      head
    );
    return removed;
  }

  /** Apply one persisted edit-op row to a working file map (replay uses the
   *  row's post-content hash; hunks are pure provenance, never applied). */
  private applyWorkingRowToFiles(files: Map<string, WorkingFileEntry>, row: JsonRecord): void {
    const kind = String(row["kind"]);
    const p = String(row["path"]);
    if (kind === "delete") {
      files.delete(p);
      return;
    }
    if (kind === "chmod") {
      const cur = files.get(p);
      if (cur) files.set(p, { ...cur, mode: Number(row["mode"] ?? cur.mode) });
      return;
    }
    const newHash = row["new_content_hash"] ? String(row["new_content_hash"]) : null;
    if (!newHash) return;
    files.set(p, {
      path: p,
      contentHash: newHash,
      mode: row["mode"] != null ? Number(row["mode"]) : (files.get(p)?.mode ?? 33188),
    });
  }

  /**
   * The COMMITTED base a repo's working content composes on: the ctx head if
   * it exists, else the context's pinned-base slice for the repo, else the
   * repo's protected `main` (read from the HOST ref store — the single main
   * authority), else the empty state. `main` heads resolve straight to the
   * protected ref (this store's recorded main is downstream provenance and may
   * lag it). Ignores any pending merge — see {@link resolveComposeBase}.
   */
  private async resolveCommittedBaseState(
    store: HostContentStore,
    logId: string,
    head: string
  ): Promise<string> {
    const repoPath = this.repoPathOfLog(logId);
    if (head === "main") {
      if (!repoPath) return this.resolveCommittedHeadState(logId, head) ?? EMPTY_STATE_HASH;
      return (await this.refsStore().readMain(repoPath))?.stateHash ?? EMPTY_STATE_HASH;
    }
    const ctxHead = this.resolveCommittedHeadState(logId, head);
    if (ctxHead) return ctxHead;
    if (head.startsWith("ctx:") && repoPath) {
      const base = this.getContextBase({ contextId: head.slice("ctx:".length) });
      if (base?.stateHash) {
        const slice = await this.pinnedSliceState(store, base.stateHash, repoPath);
        if (slice) return slice;
      }
    }
    if (repoPath) {
      const ref = await this.refsStore().readMain(repoPath);
      if (ref?.stateHash) return ref.stateHash;
    }
    return EMPTY_STATE_HASH;
  }

  /**
   * A repo's slice of a pinned (server-minted, content-store mirrored) base
   * view, minted as a LOCAL subtree-rooted state — or null when the base view
   * carries nothing under the repo path (the repo did not exist at the pin).
   */
  private async pinnedSliceState(
    store: HostContentStore,
    baseView: string,
    repoPath: string
  ): Promise<string | null> {
    const entries = await store.listTree(baseView, { prefix: repoPath });
    if (entries === null) {
      throw new Error(`pinned base view ${baseView} is not resolvable in the content store`);
    }
    if (entries.length >= MERGE_LIST_TREE_LIMIT) {
      throw new Error(`tree listing overflow for pinned base ${baseView}`);
    }
    const files = entries
      .filter((entry) => entry.kind === "file" && entry.path !== repoPath)
      .map((entry) => ({
        path: entry.path.slice(repoPath.length + 1),
        contentHash: String(entry.contentHash),
        mode: entry.mode ?? 33188,
      }));
    if (files.length === 0) return null;
    return this.transaction(() =>
      this.createWorktreeState(
        files.map((file) => {
          const path = normalizePath(file.path);
          this.ensureBlob(file.contentHash, 0);
          return {
            path,
            contentHash: file.contentHash,
            mode: file.mode,
            fileVersionId: this.ensureFileVersion(path, file.contentHash, file.mode),
          };
        }),
        { subtreeOf: baseView, prefix: repoPath }
      )
    );
  }

  /**
   * The base the working CONTENT replays over: a pending merge's provisional
   * (conflict-marked) tree while a reconcile is unresolved, else the committed
   * base. Returns the pending info (the merge's `theirs` tip is the extra
   * commit parent) and the committed lineage base alongside.
   */
  private async resolveComposeBase(
    store: HostContentStore,
    logId: string,
    head: string
  ): Promise<{
    baseStateHash: string;
    committedBaseStateHash: string;
    pending: {
      oursStateHash: string;
      theirsStateHash: string;
      theirsEventId?: string | null;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      materialized?: boolean;
    } | null;
  }> {
    const pending = this.getPendingMerge({ logId, head }).info as {
      oursStateHash: string;
      theirsStateHash: string;
      theirsEventId?: string | null;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      materialized?: boolean;
    } | null;
    const committedBaseStateHash = await this.resolveCommittedBaseState(store, logId, head);
    return {
      baseStateHash: pending ? pending.provisionalStateHash : committedBaseStateHash,
      committedBaseStateHash,
      pending,
    };
  }

  /** Reconstruct a repo's working content: the compose base's file set with
   *  the uncommitted edit-op rows replayed in (edit_seq, ordinal) order. */
  private async composeWorkingFiles(
    store: HostContentStore,
    logId: string,
    head: string,
    baseStateHash: string
  ): Promise<{ files: Map<string, WorkingFileEntry>; maxEditSeq: number; rows: JsonRecord[] }> {
    const baseFiles = await this.stateFilesFor(store, baseStateHash);
    const files = new Map<string, WorkingFileEntry>(
      baseFiles.map((f) => [f.path, { path: f.path, contentHash: f.contentHash, mode: f.mode }])
    );
    const rows = this.workingEditRows(logId, head);
    let maxEditSeq = 0;
    for (const row of rows) {
      const editSeq = Number(row["edit_seq"] ?? 0);
      if (editSeq > maxEditSeq) maxEditSeq = editSeq;
      this.applyWorkingRowToFiles(files, row);
    }
    return { files, maxEditSeq, rows };
  }

  /**
   * Mirror a composed file set into the HOST content store (bottom-up
   * `putTree`, children before parents) and assert the store agreed on the
   * state identity — the mirroring-invariant chokepoint for every state this
   * store COMPOSES itself (working states, committed sets). One `getTree`
   * probe when already mirrored (the `state:` node is written last).
   */
  private async mirrorStateToContentStore(
    store: HostContentStore,
    files: Array<{ path: string; contentHash: string; mode: number }>,
    expectStateHash: string
  ): Promise<void> {
    if ((await store.getTree(expectStateHash)) !== null) return;
    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, { contentHash: string; mode: number }>;
    }
    const root: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const segments = file.path.split("/");
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, {
        contentHash: file.contentHash,
        mode: file.mode,
      });
    }
    const entriesOf = async (node: DirNode): Promise<HostTreeEntry[]> => {
      const entries: HostTreeEntry[] = [];
      for (const [name, child] of node.dirs) {
        const childEntries = await entriesOf(child);
        const { treeHash } = await store.putTree(childEntries);
        entries.push({ name, kind: "dir", childHash: treeHash });
      }
      for (const [name, file] of node.files) {
        entries.push({ name, kind: "file", contentHash: file.contentHash, mode: file.mode });
      }
      return entries;
    };
    const result = await store.putTree(await entriesOf(root), { root: true });
    if (result.stateHash !== expectStateHash) {
      throw new Error(
        `content-store mirror disagreed on state identity (${result.stateHash} != ${expectStateHash}) — shared hashing bug`
      );
    }
  }

  /** Stage a composed file set as a local content-addressed state AND mirror
   *  it into the host content store (every handed-out hash must resolve there). */
  private async stageAndMirror(
    store: HostContentStore,
    files: Array<{ path: string; contentHash: string; mode: number; size?: number }>,
    summary: string
  ): Promise<string> {
    const list = files.map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      mode: file.mode,
      ...(file.size != null ? { size: file.size } : {}),
    }));
    const { stateHash } = this.stageWorktreeState({ files: list, summary });
    await this.mirrorStateToContentStore(
      store,
      list.map(({ path, contentHash, mode }) => ({ path, contentHash, mode })),
      stateHash
    );
    return stateHash;
  }

  /** The edit engine over the host content store's blob bytes. */
  private editEngine(store: HostContentStore): EditEngine {
    return new EditEngine({
      readBlob: async (digest) => {
        const bytesBase64 = await store.getBase64(digest);
        return bytesBase64 === null ? null : base64ToBytes(bytesBase64);
      },
      writeBlob: async (bytes) => store.putBase64(bytesToBase64(bytes)),
    });
  }

  /**
   * EDIT — record a batch of high-level edit ops as UNCOMMITTED working edits
   * on a `ctx:*` head. THE working-edit semantics live here (P5c): this store
   * composes the current working content (committed base — ctx head, pinned
   * slice, or protected `main` via the host refs bridge — plus prior
   * uncommitted ops, or a pending merge's provisional tree), applies the ops
   * through the userland edit engine (blob bytes over the content-store
   * bridge; whole-file writes get hunk-level provenance), persists the rows in
   * one txn under a two-part CAS, and stages + mirrors the new working state.
   * No head advance, no log event, no build. The HOST projects the returned
   * working state to disk and emits `working-advanced` — projection is a
   * follower, never the semantics.
   */
  @rpc({ callers: ["do", "server"] })
  async applyEditOps(input: {
    logId: string;
    head: string;
    actorId: string;
    actorJson: string;
    invocationId?: string | null;
    turnId?: string | null;
    eventId?: string | null;
    edits: VcsEditOp[];
    /** Optional optimistic guard: the composed working state the author saw. */
    baseStateHash?: string | null;
  }): Promise<{
    editSeq: number;
    stateHash: string;
    baseStateHash: string;
    changedPaths: string[];
  }> {
    this.ensureReady();
    if (input.head === "main" || !input.head.startsWith("ctx:")) {
      throw new Error(
        `edit: '${input.head}' — edits target a ctx:* head; main advances only via push`
      );
    }
    const store = this.contentStore();
    const engine = this.editEngine(store);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // 1. Current working content + the two-part fingerprint it depends on.
      const { baseStateHash } = await this.resolveComposeBase(store, input.logId, input.head);
      const anchorHead = this.resolveCommittedHeadState(input.logId, input.head);
      const working = await this.composeWorkingFiles(store, input.logId, input.head, baseStateHash);
      if (input.baseStateHash != null) {
        const currentWorkingState = await this.stageAndMirror(
          store,
          [...working.files.values()],
          `working CAS base for ${input.head}`
        );
        if (currentWorkingState !== input.baseStateHash) {
          throw new Error(
            `edit CAS conflict on ${input.head}: working state ${currentWorkingState} != expected ${input.baseStateHash}`
          );
        }
      }
      // 2. Apply ops → new file map + edit-op rows (blob bytes through the bridge).
      const { files, rows } = await engine.applyEditOps(working.files, input.edits);
      // U1 binary-boundary resolution: the engine's `binary` flag reflects the
      // NEW content, so a WRITE of text over an existing BINARY file arrives
      // `binary:false` with no hunks. There is genuinely no line structure to
      // compose through that boundary — mark it `binary` so blame chain-restarts
      // (attributing the write itself, degraded) instead of the U1 seam rejecting
      // it as a missing-hunks bug. Only the ambiguous rows pay the old-blob read.
      for (const row of rows) {
        if (
          row.kind === "write" &&
          !row.binary &&
          row.hunks === undefined &&
          row.oldContentHash &&
          row.oldContentHash !== row.newContentHash
        ) {
          const oldB64 = await store.getBase64(row.oldContentHash);
          if (oldB64 !== null && decodeUtf8Text(base64ToBytes(oldB64)) === null) {
            row.binary = true;
          }
        }
      }
      if (rows.length === 0) {
        return {
          editSeq: working.maxEditSeq,
          stateHash: await this.stageAndMirror(store, [...files.values()], `working ${input.head}`),
          baseStateHash,
          changedPaths: [],
        };
      }
      const eventId = input.eventId ?? crypto.randomUUID();
      try {
        // 3. Atomic persist (single txn) — CAS on BOTH the uncommitted sequence
        //    AND the committed ctx-head state (async compose above can interleave
        //    with a concurrent edit/commit/merge).
        const { editSeq } = this.insertWorkingEditRows({
          logId: input.logId,
          head: input.head,
          actorId: input.actorId,
          actorJson: input.actorJson,
          invocationId: input.invocationId ?? null,
          turnId: input.turnId ?? null,
          eventId,
          ops: rows,
          expectedEditSeq: working.maxEditSeq,
          expectedCommitHead: anchorHead ?? null,
        });
        // 4. Stage + mirror the new working content (outside the txn).
        const stateHash = await this.stageAndMirror(
          store,
          [...files.values()],
          `working edit on ${input.head}`
        );
        return { editSeq, stateHash, baseStateHash, changedPaths: rows.map((row) => row.path) };
      } catch (error) {
        // A concurrent edit (stale edit_seq) or commit/merge (advanced the
        // committed head) → recompute against the new working content + retry.
        if (error instanceof Error && error.message.includes("CAS conflict")) {
          lastErr = error;
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `edit: gave up after concurrent-edit retries on ${input.head}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }

  /**
   * REVERT — compute a transition's inverse patch (the pre-transition content
   * of every path it touched) and record it as a WORKING edit on `head` via
   * {@link applyEditOps} — a `git revert`, never a reset. The inverse ops
   * reference pre-transition content by blob digest (no bytes move); the edit
   * engine derives the same hunk-level provenance as any other write.
   */
  @rpc({ callers: ["do", "server"] })
  async revertWorking(input: {
    logId: string;
    head: string;
    target: { stateHash?: string | null; eventId?: string | null };
    actorId: string;
    actorJson: string;
    invocationId?: string | null;
    turnId?: string | null;
  }): Promise<{
    editSeq: number;
    stateHash: string;
    baseStateHash: string;
    changedPaths: string[];
  }> {
    this.ensureReady();
    let afterStateHash = input.target.stateHash ?? null;
    if (!afterStateHash) {
      if (!input.target.eventId) throw new Error("revert: target requires a stateHash or eventId");
      const transition = this.getGadStateTransition({ eventId: input.target.eventId });
      const output = transition?.["output_state_hash"];
      if (typeof output !== "string" || !output) {
        throw new Error(
          `revert: event ${input.target.eventId} produced no output state on ${input.head}`
        );
      }
      afterStateHash = output;
    }
    const producer = this.getGadStateProducer({ stateHash: afterStateHash });
    const beforeStateHash = producer?.["input_state_hash"];
    if (typeof beforeStateHash !== "string" || !beforeStateHash) {
      throw new Error(`revert: no transition produced ${afterStateHash} (cannot invert)`);
    }
    const diff = this.diffGadStates({
      leftStateHash: beforeStateHash,
      rightStateHash: afterStateHash,
    });
    const edits: VcsEditOp[] = [];
    // It ADDED these paths → the inverse deletes them.
    for (const file of diff.added) edits.push({ kind: "delete", path: String(file["path"]) });
    // It DELETED these → the inverse recreates them with pre-transition content.
    for (const file of diff.removed) {
      edits.push({
        kind: "create",
        path: String(file["path"]),
        content: { kind: "blob", contentHash: String(file["content_hash"]) },
        mode: asNumber(file["mode"]),
      });
    }
    // It CHANGED these → the inverse restores the pre-transition content.
    for (const file of diff.changed) {
      const before = file["before"] as JsonRecord;
      edits.push({
        kind: "write",
        path: String(file["path"]),
        content: { kind: "blob", contentHash: String(before["content_hash"]) },
        mode: asNumber(before["mode"]),
      });
    }
    if (edits.length === 0) {
      const store = this.contentStore();
      const { baseStateHash } = await this.resolveComposeBase(store, input.logId, input.head);
      return {
        editSeq: 0,
        stateHash: this.resolveCommittedHeadState(input.logId, input.head) ?? afterStateHash,
        baseStateHash,
        changedPaths: [],
      };
    }
    return this.applyEditOps({
      logId: input.logId,
      head: input.head,
      actorId: input.actorId,
      actorJson: input.actorJson,
      invocationId: input.invocationId ?? null,
      turnId: input.turnId ?? null,
      edits,
    });
  }

  /** Forward edit ops that carry `fromState` to `toState` (the dual of the
   *  inverse ops {@link revertWorking} builds): added/changed → write the AFTER
   *  content by blob digest, removed → delete. `write` create-if-absent so a
   *  pick over divergent content lands cleanly. */
  private forwardEditsBetween(fromState: string, toState: string): VcsEditOp[] {
    const diff = this.diffGadStates({ leftStateHash: fromState, rightStateHash: toState });
    const edits: VcsEditOp[] = [];
    for (const file of diff.added) {
      edits.push({
        kind: "write",
        path: String(file["path"]),
        content: { kind: "blob", contentHash: String(file["content_hash"]) },
        mode: asNumber(file["mode"]),
      });
    }
    for (const file of diff.removed) edits.push({ kind: "delete", path: String(file["path"]) });
    for (const file of diff.changed) {
      const after = file["after"] as JsonRecord;
      edits.push({
        kind: "write",
        path: String(file["path"]),
        content: { kind: "blob", contentHash: String(after["content_hash"]) },
        mode: asNumber(after["mode"]),
      });
    }
    return edits;
  }

  /**
   * Cherry-pick edits for a commit: a 3-way against an EXPLICIT base — base =
   * the commit's parent state, theirs = the commit's output state, ours = the
   * caller head's CURRENT working content — so the pick lands the commit's
   * change adapted to where the caller actually is (not a naive forward-apply
   * of the raw diff). The merged file set is diffed back against `ours` to yield
   * the working edits {@link vcsPick} records; conflict-marked content (if the
   * 3-way conflicted) lands in the working tree for the caller to resolve, just
   * as a merge resolution does.
   */
  private async pickCommitEdits(
    store: HostContentStore,
    logId: string,
    head: string,
    eventId: string
  ): Promise<VcsEditOp[]> {
    const transition = this.getGadStateTransition({ eventId });
    const theirsState = transition?.["output_state_hash"];
    if (typeof theirsState !== "string" || !theirsState) {
      throw new Error(`pick: commit ${eventId} produced no output state`);
    }
    const inputState = transition?.["input_state_hash"];
    const baseState = typeof inputState === "string" && inputState ? inputState : EMPTY_STATE_HASH;
    // ours = the caller head's current working content (compose base + rows).
    const { baseStateHash } = await this.resolveComposeBase(store, logId, head);
    const working = await this.composeWorkingFiles(store, logId, head, baseStateHash);
    const oursState = await this.stageAndMirror(
      store,
      [...working.files.values()],
      `pick base for ${head}`
    );
    const result = await this.mergeEngineFor(store).compute3(
      { base: baseState, ours: oursState, theirs: theirsState },
      { ours: head, theirs: `commit:${eventId}` }
    );
    if (result.status === "up-to-date") return [];
    const mergedState = await this.stageAndMirror(
      store,
      result.files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        mode: file.mode,
      })),
      `pick ${eventId} into ${head}`
    );
    return this.forwardEditsBetween(oursState, mergedState);
  }

  /** Path-injection edits: copy the source context's WORKING content at the
   *  requested repo-relative paths as write ops (create-if-absent). Paths absent
   *  in the source are skipped (nothing to copy). */
  private async pickPathEdits(
    store: HostContentStore,
    logId: string,
    sourceContextId: string,
    paths: string[]
  ): Promise<VcsEditOp[]> {
    const sourceState = (await this.resolveWorkingState({ logId, head: `ctx:${sourceContextId}` }))
      .stateHash;
    const byPath = new Map(
      (sourceState ? await this.stateFilesFor(store, sourceState) : []).map(
        (file) => [file.path, file] as const
      )
    );
    const edits: VcsEditOp[] = [];
    for (const path of paths) {
      const file = byPath.get(normalizePath(path));
      if (!file) continue;
      edits.push({
        kind: "write",
        path: file.path,
        content: { kind: "blob", contentHash: file.contentHash },
        mode: file.mode,
      });
    }
    return edits;
  }

  /**
   * PICK — the forward dual of {@link revertWorking}. Lands a selected change
   * onto a `ctx:*` head as UNCOMMITTED working edits (never a head advance): a
   * `commit` pick 3-way-applies a commit's patch (see {@link pickCommitEdits});
   * a `paths` pick injects another context's working content at specific paths.
   * Both feed {@link applyEditOps} (revert-parity), then tag the just-created
   * working rows with `pickedFrom` provenance (UX breadcrumb). The caller
   * reviews and commits deliberately.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsPick(input: {
    logId: string;
    head: string;
    actor: ParticipantRef;
    pick:
      | { kind: "commit"; eventId: string }
      | { kind: "paths"; sourceContextId: string; paths: string[] };
  }): Promise<{
    editSeq: number;
    stateHash: string;
    baseStateHash: string;
    changedPaths: string[];
  }> {
    this.ensureReady();
    const { logId, head } = input;
    if (head === "main" || !head.startsWith("ctx:")) {
      throw new Error(`pick: '${head}' — picks target a ctx:* head`);
    }
    const store = this.contentStore();
    const edits =
      input.pick.kind === "commit"
        ? await this.pickCommitEdits(store, logId, head, input.pick.eventId)
        : await this.pickPathEdits(store, logId, input.pick.sourceContextId, input.pick.paths);
    if (edits.length === 0) {
      const { baseStateHash } = await this.resolveComposeBase(store, logId, head);
      return {
        editSeq: this.workingEditRows(logId, head).reduce(
          (max, row) => Math.max(max, Number(row["edit_seq"] ?? 0)),
          0
        ),
        stateHash: this.resolveCommittedHeadState(logId, head) ?? baseStateHash,
        baseStateHash,
        changedPaths: [],
      };
    }
    const actorId = asString((input.actor as unknown as Record<string, unknown>)?.["id"]) ?? "";
    const result = await this.applyEditOps({
      logId,
      head,
      actorId,
      actorJson: JSON.stringify(input.actor),
      edits,
    });
    // Tag the working rows this pick just created with their provenance.
    const provenance =
      input.pick.kind === "commit"
        ? { kind: "commit", logId, eventId: input.pick.eventId }
        : { kind: "paths", sourceContextId: input.pick.sourceContextId };
    this.sql.exec(
      `UPDATE gad_worktree_edit_ops SET picked_from_json = ?
       WHERE log_id = ? AND head = ? AND edit_seq = ? AND committed_event_id IS NULL`,
      JSON.stringify(provenance),
      logId,
      head,
      result.editSeq
    );
    return result;
  }

  /**
   * The WORKING content state for a `(logId, head)` — compose base +
   * uncommitted ops — staged locally and mirrored into the content store.
   * Null when the repo does not exist for the head at all (empty base, no
   * edits): context views use that to distinguish "absent" from "empty".
   */
  @rpc({ callers: ["do", "server"] })
  async resolveWorkingState(input: {
    logId: string;
    head: string;
  }): Promise<{ stateHash: string | null }> {
    this.ensureReady();
    const store = this.contentStore();
    const { baseStateHash } = await this.resolveComposeBase(store, input.logId, input.head);
    const working = await this.composeWorkingFiles(store, input.logId, input.head, baseStateHash);
    if (baseStateHash === EMPTY_STATE_HASH && working.rows.length === 0) {
      return { stateHash: null };
    }
    return {
      stateHash: await this.stageAndMirror(
        store,
        [...working.files.values()],
        `working content for ${input.head}`
      ),
    };
  }

  /** Reject a commit whose included content still carries conflict markers in
   *  any of the merge's conflicted paths. */
  private async assertNoConflictMarkers(
    store: HostContentStore,
    files: Map<string, WorkingFileEntry>,
    conflicts: Array<{ path: string; kind: string }>
  ): Promise<void> {
    for (const conflict of conflicts) {
      const file = files.get(conflict.path);
      if (!file) continue;
      const bytesBase64 = await store.getBase64(file.contentHash);
      if (bytesBase64 === null) continue;
      const text = decodeUtf8Text(base64ToBytes(bytesBase64));
      if (text !== null && hasConflictMarkers(text)) {
        throw new Error(`commit: resolve conflict markers in ${conflict.path} first`);
      }
    }
  }

  /** Map a persisted edit-op row to the camelCase edit-op shape carried on
   *  state-advanced events and the vcs read surface. */
  private editOpFromRow(row: JsonRecord): {
    kind: string;
    path: string;
    oldContentHash: string | null;
    newContentHash: string | null;
    hunks?: unknown;
    mode?: number;
  } {
    return {
      kind: String(row["kind"]),
      path: String(row["path"]),
      oldContentHash: row["old_content_hash"] ? String(row["old_content_hash"]) : null,
      newContentHash: row["new_content_hash"] ? String(row["new_content_hash"]) : null,
      ...(row["hunks_json"] ? { hunks: JSON.parse(String(row["hunks_json"])) } : {}),
      ...(row["mode"] != null ? { mode: Number(row["mode"]) } : {}),
    };
  }

  /**
   * COMMIT — fold the uncommitted edits on a `ctx:*` head into ONE deliberate,
   * messaged snapshot. THE commit semantics live here (P5c): this store
   * composes the committed file set (committed base + included ops −
   * `exclude`; a pending merge's provisional base makes this the
   * merge-RESOLUTION commit), refuses unresolved conflict markers, ingests the
   * state + commit event + head advance in one txn (CAS on the committed
   * ctx-head state), RE-KEYS the included working rows to the commit (never
   * re-inserts), consumes any pending merge, and mirrors the committed set
   * into the content store. `unchanged` only when nothing is included AND no
   * pending merge needs sealing. The HOST re-projects the working tree and
   * emits the state-advanced event off the returned identities.
   */
  @rpc({ callers: ["do", "server"] })
  async commitWorking(input: {
    logId: string;
    head: string;
    message: string;
    actor: ParticipantRef;
    invocationId?: string | null;
    turnId?: string | null;
    /** Repo-relative paths whose working rows stay UNCOMMITTED. */
    exclude?: string[] | null;
  }): Promise<{
    status: "committed" | "unchanged";
    stateHash: string;
    eventId: string | null;
    headHash: string | null;
    committedSeq: number | null;
    editCount: number;
    /** The event basis for the host's state-advanced diff (prev committed head,
     *  or the lineage base for a first commit). */
    previousStateHash: string;
    editOps: Array<{
      kind: string;
      path: string;
      oldContentHash: string | null;
      newContentHash: string | null;
      hunks?: unknown;
      mode?: number;
    }>;
    transitionKind: "snapshot" | "merge-resolution";
  }> {
    this.ensureReady();
    if (input.head === "main" || !input.head.startsWith("ctx:")) {
      throw new Error(
        `commit: '${input.head}' — commit targets a ctx:* head; main advances only via push`
      );
    }
    if (!input.message || !input.message.trim()) {
      throw new Error("commit: a message is required");
    }
    const store = this.contentStore();
    const exclude = new Set(input.exclude ?? []);
    const { baseStateHash, committedBaseStateHash, pending } = await this.resolveComposeBase(
      store,
      input.logId,
      input.head
    );
    const workingRows = this.workingEditRows(input.logId, input.head);
    const includedRows = workingRows.filter((row) => !exclude.has(String(row["path"])));
    const ctxHead = this.resolveCommittedHeadState(input.logId, input.head);
    // unchanged ONLY when nothing is included AND no pending merge needs sealing.
    if (includedRows.length === 0 && !pending) {
      return {
        status: "unchanged",
        stateHash: ctxHead ?? EMPTY_STATE_HASH,
        eventId: null,
        headHash: null,
        committedSeq: null,
        editCount: 0,
        previousStateHash: ctxHead ?? EMPTY_STATE_HASH,
        editOps: [],
        transitionKind: "snapshot",
      };
    }
    // Compose the committed file set = compose base + INCLUDED ops only
    // (excluded paths stay at base content, their working rows uncommitted).
    const lineageBase = ctxHead ?? committedBaseStateHash;
    const baseFiles = await this.stateFilesFor(store, baseStateHash);
    const files = new Map<string, WorkingFileEntry>(
      baseFiles.map((f) => [f.path, { path: f.path, contentHash: f.contentHash, mode: f.mode }])
    );
    for (const row of includedRows) this.applyWorkingRowToFiles(files, row);
    // Reject unresolved conflict markers (only possible while a pending merge
    // is being resolved — applyEditOps never introduces markers).
    if (pending) await this.assertNoConflictMarkers(store, files, pending.conflicts);
    const fileList = [...files.values()].map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      mode: file.mode,
    }));
    // Merge-resolution provenance (blame invariants 1 + 2/U2): a commit that
    // seals a pending merge is a merge commit whose first parent is OURS. The
    // agent's re-keyed working rows only cover the files they hand-resolved and
    // are anchored to the PROVISIONAL base, not OURS. Synthesize the missing
    // provenance — an OURS→provisional bridge for each resolved path plus a
    // whole-file op for every cleanly-taken incoming file — so the committed
    // chain composes from OURS and nothing incoming is a blame hole. Computed
    // here (async `stateFilesFor`) before the txn; the txn's CAS re-check aborts
    // if the head moved under us, so a stale `lineageBase` can't be recorded.
    const mergeResolutionOps = pending
      ? this.mergeResolutionEditOps(
          await this.stateFilesFor(store, lineageBase),
          baseFiles,
          fileList,
          new Set(includedRows.map((row) => String(row["path"])))
        )
      : [];
    const result = this.transaction(() => {
      // CAS re-check under the txn: the async compose above may have
      // interleaved with a concurrent commit/merge on this head.
      const currentHead = this.resolveCommittedHeadState(input.logId, input.head);
      if ((currentHead ?? null) !== (ctxHead ?? null)) {
        throw new Error(
          `commit CAS conflict on ${input.head}: committed head moved during compose`
        );
      }
      const ingest = this.ingestWorktreeStateInTxn({
        logId: input.logId,
        head: input.head,
        logKind: "vcs",
        actor: input.actor,
        files: fileList,
        baseStateHash: lineageBase,
        expectedRefStateHash: ctxHead ?? EMPTY_STATE_HASH,
        eventKind: pending ? "state.merge_applied" : "state.snapshot_ingested",
        summary: input.message,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        // A2/T1: the commit's sealing tool-call attributes the commit EVENT
        // itself (not only its re-keyed ops, which carry their own edit-time
        // invocation ids). Recorded in the event metadata so the commit is
        // traceable into the agentic trajectory without a log_events schema bump.
        ...(input.invocationId ? { metadata: { commitInvocationId: input.invocationId } } : {}),
        ...(pending ? { parentStateHashes: [pending.theirsStateHash] } : {}),
        ...(pending?.theirsEventId ? { parentEventIds: [pending.theirsEventId] } : {}),
        // Merge-resolution: SYNTHESIZED provenance for cleanly-taken incoming
        // files + the OURS→provisional bridges (chain-continuous vs OURS). The
        // agent's authored resolution rows are RE-KEYED below (NEVER re-inserted
        // — invariant 10), landing ON TOP of the bridges. A plain snapshot
        // commit passes no editOps (re-key only).
        ...(mergeResolutionOps.length > 0
          ? { editOps: mergeResolutionOps, validateFirstParentChain: true }
          : {}),
      });
      for (const row of includedRows) {
        this.sql.exec(
          `UPDATE gad_worktree_edit_ops
             SET committed_event_id = ?, committed_seq = ?, output_state_hash = ?
           WHERE id = ? AND committed_event_id IS NULL`,
          ingest.eventId,
          ingest.headSeq,
          ingest.stateHash,
          Number(row["id"])
        );
      }
      const editCount = Number(
        (
          this.sql
            .exec(
              `SELECT COUNT(*) AS c FROM gad_worktree_edit_ops WHERE committed_event_id = ?`,
              ingest.eventId
            )
            .toArray()[0] as { c: number }
        ).c ?? 0
      );
      // A commit on a head with a pending merge IS the resolution — consume it.
      this.deleteStateValue(`merge:${input.logId}:${input.head}`);
      return { ingest, editCount };
    });
    // Mirroring invariant: the committed file set is in memory here.
    await this.mirrorStateToContentStore(store, fileList, result.ingest.stateHash);
    return {
      status: "committed",
      stateHash: result.ingest.stateHash,
      eventId: result.ingest.eventId,
      headHash: result.ingest.headHash,
      committedSeq: result.ingest.headSeq,
      editCount: result.editCount,
      previousStateHash: lineageBase,
      editOps: includedRows.map((row) => this.editOpFromRow(row)),
      transitionKind: pending ? "merge-resolution" : "snapshot",
    };
  }

  /** Drop a repo's uncommitted edit-op rows AND clear any pending merge on the
   *  head (abort an in-progress reconcile). Single txn. */
  @rpc({ callers: ["do", "server"] })
  discardWorkingEdits(input: { logId: string; head: string }): { discarded: number } {
    this.ensureReady();
    return this.transaction(() => {
      const discarded = this.deleteUncommittedWorkingEdits(input.logId, input.head);
      this.deleteStateValue(`merge:${input.logId}:${input.head}`);
      return { discarded };
    });
  }

  // ── Read-only traversal of the edit/commit graph (all index-backed) ────────

  /** commit → its edits, in working-replay order. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listCommitEdits(input: { commitEventId: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops WHERE committed_event_id = ? ORDER BY edit_seq, ordinal`,
        input.commitEventId
      )
      .toArray() as JsonRecord[];
  }

  /** A head's uncommitted (working) edits, in replay order. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listWorkingEdits(input: { logId: string; head: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops
         WHERE log_id = ? AND head = ? AND committed_event_id IS NULL
         ORDER BY edit_seq, ordinal`,
        input.logId,
        input.head
      )
      .toArray() as JsonRecord[];
  }

  /** Repos (logIds) that carry uncommitted edits on a head — discovery for
   *  dropContext (a repo with uncommitted-ONLY edits has no ctx head). */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listContextWorkingRepos(input: { head: string }): Array<{ logId: string }> {
    this.ensureReady();
    return (
      this.sql
        .exec(
          `SELECT DISTINCT log_id FROM gad_worktree_edit_ops
           WHERE head = ? AND committed_event_id IS NULL AND log_id IS NOT NULL`,
          input.head
        )
        .toArray() as JsonRecord[]
    ).map((r) => ({ logId: String(r["log_id"]) }));
  }

  private commitAncestorEventIds(eventId: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [eventId];
    while (queue.length > 0 && out.length < limit) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      const parents = (
        this.sql
          .exec(
            `SELECT parent_event_id FROM gad_transition_parents WHERE event_id = ? ORDER BY ordinal`,
            id
          )
          .toArray() as Array<{ parent_event_id?: string | null }>
      )
        .map((p) => p.parent_event_id)
        .filter((p): p is string => !!p);
      for (const parent of parents) if (!seen.has(parent)) queue.push(parent);
    }
    return out;
  }

  /** File history / blame: every edit to a path in COMMIT-lineage order
   *  (committed_seq — NOT raw edit_seq, which is per-head). The uncommitted tail
   *  (working rows for `head`, default `main` ⇒ none) sorts last. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  fileHistory(input: {
    logId: string;
    path: string;
    head?: string | null;
    limit?: number | null;
  }): JsonRecord[] {
    this.ensureReady();
    const head = input.head ?? "main";
    const limit = input.limit ?? 500;
    const path = normalizePath(input.path);
    const tip = this.resolveWorktreeHeadInternal(input.logId, head)?.commitEventId ?? null;
    const ancestorIds = tip ? this.commitAncestorEventIds(tip, Math.max(limit * 20, limit)) : [];
    const commitOrder = new Map(
      ancestorIds
        .slice()
        .reverse()
        .map((eventId, index) => [eventId, index])
    );
    const committedRows =
      ancestorIds.length === 0
        ? []
        : (this.sql
            .exec(
              `SELECT * FROM gad_worktree_edit_ops
               WHERE log_id = ? AND path = ?
                 AND committed_event_id IN (${ancestorIds.map(() => "?").join(", ")})`,
              input.logId,
              path,
              ...ancestorIds
            )
            .toArray() as JsonRecord[]);
    committedRows.sort((a, b) => {
      const aEvent = asString(a["committed_event_id"]) ?? "";
      const bEvent = asString(b["committed_event_id"]) ?? "";
      const byCommit = (commitOrder.get(aEvent) ?? 0) - (commitOrder.get(bEvent) ?? 0);
      if (byCommit !== 0) return byCommit;
      const bySeq = Number(a["edit_seq"] ?? 0) - Number(b["edit_seq"] ?? 0);
      if (bySeq !== 0) return bySeq;
      return Number(a["ordinal"] ?? 0) - Number(b["ordinal"] ?? 0);
    });
    const workingRows = this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops
         WHERE log_id = ? AND head = ? AND path = ? AND committed_event_id IS NULL
         ORDER BY edit_seq, ordinal`,
        input.logId,
        head,
        path
      )
      .toArray() as JsonRecord[];
    return [...committedRows, ...workingRows].slice(0, limit);
  }

  /** Edits authored by an actor, newest-lineage last. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  editsByActor(input: { actorId: string; limit?: number | null }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops WHERE actor_id = ?
         ORDER BY (committed_seq IS NULL), committed_seq, edit_seq, ordinal LIMIT ?`,
        input.actorId,
        input.limit ?? 500
      )
      .toArray() as JsonRecord[];
  }

  /**
   * Causal: every edit authored in an agent turn. Turn is reached by TRAVERSAL
   * — edit-op rows carry `invocation_id` (the trajectory edge), and the
   * invocation→turn mapping lives in `trajectory_invocations` (single source of
   * truth, not denormalized onto the edit). Also includes any rows tagged with
   * `turn_id` directly (bootstrap/merge commits that supplied it).
   */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  editsByTurn(input: { turnId: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT eo.* FROM gad_worktree_edit_ops eo
         WHERE eo.turn_id = ?1
            OR EXISTS (
              SELECT 1 FROM trajectory_invocations ti
              WHERE ti.invocation_id = eo.invocation_id AND ti.turn_id = ?1
            )
         ORDER BY (eo.committed_seq IS NULL), eo.committed_seq, eo.edit_seq, eo.ordinal`,
        input.turnId
      )
      .toArray() as JsonRecord[];
  }

  /** Causal: every edit authored in a single tool-call invocation. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  editsByInvocation(input: { invocationId: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops WHERE invocation_id = ?
         ORDER BY (committed_seq IS NULL), committed_seq, edit_seq, ordinal`,
        input.invocationId
      )
      .toArray() as JsonRecord[];
  }

  /** Commit DAG ancestry by EVENT id (walks parent_event_id). Distinguishes two
   *  distinct commits that share an identical output_state_hash (clean-merge
   *  content collision) — commit identity is event_id, never the state hash. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  commitAncestors(input: {
    eventId: string;
    limit?: number | null;
  }): Array<{ eventId: string; stateHash: string | null; parentEventIds: string[] }> {
    this.ensureReady();
    const limit = input.limit ?? 200;
    const out: Array<{ eventId: string; stateHash: string | null; parentEventIds: string[] }> = [];
    for (const id of this.commitAncestorEventIds(input.eventId, limit)) {
      const t = this.sql
        .exec(`SELECT output_state_hash FROM gad_state_transitions WHERE event_id = ?`, id)
        .toArray()[0] as { output_state_hash?: string } | undefined;
      const parents = (
        this.sql
          .exec(
            `SELECT parent_event_id FROM gad_transition_parents WHERE event_id = ? ORDER BY ordinal`,
            id
          )
          .toArray() as Array<{ parent_event_id?: string | null }>
      )
        .map((p) => p.parent_event_id)
        .filter((p): p is string => !!p);
      out.push({ eventId: id, stateHash: t?.output_state_hash ?? null, parentEventIds: parents });
    }
    return out;
  }

  // ── vcs.* read surface (P5c — userland-dispatched via the `vcs` manifest ──
  // service; positional args, camelCase rows). These are the caller-facing
  // history/read methods that used to live on the HOST vcs service; the raw
  // input-object methods above remain the store-internal primitives.

  /** Map a raw edit-op row to the camelCase VCS provenance shape. */
  private mapVcsEditOpRow(row: JsonRecord): VcsEditOpRowWire {
    const s = (v: unknown): string | null => (v == null ? null : String(v));
    const n = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: Number(row["id"]),
      eventId: String(row["event_id"]),
      committedEventId: s(row["committed_event_id"]),
      committedSeq: n(row["committed_seq"]),
      editSeq: n(row["edit_seq"]),
      outputStateHash: s(row["output_state_hash"]),
      ordinal: Number(row["ordinal"] ?? 0),
      kind: String(row["kind"]),
      path: String(row["path"]),
      oldContentHash: s(row["old_content_hash"]),
      newContentHash: s(row["new_content_hash"]),
      mode: n(row["mode"]),
      actorId: s(row["actor_id"]),
      invocationId: s(row["invocation_id"]),
      turnId: s(row["turn_id"]),
      createdAt: s(row["created_at"]),
      hunksJson: s(row["hunks_json"]),
      synthetic: Number(row["synthetic"]) === 1,
      binary: Number(row["binary"]) === 1,
    };
  }

  /** commit → the edits it owns (by commit event id), in replay order.
   *  `repoPath` scopes the caller's intent (event ids are globally unique). */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsCommitEdits(repoPath: string, commitEventId: string): VcsEditOpRowWire[] {
    this.ensureReady();
    void normalizeRepoPathArg(repoPath);
    return this.listCommitEdits({ commitEventId }).map((row) => this.mapVcsEditOpRow(row));
  }

  /** A path's edit history / blame in COMMIT-lineage order (+ uncommitted tail). */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsFileHistory(
    repoPath: string,
    filePath: string,
    head?: string | null,
    limit?: number | null
  ): VcsEditOpRowWire[] {
    this.ensureReady();
    const norm = normalizeRepoPathArg(repoPath);
    const relPath = filePath.startsWith(`${norm}/`) ? filePath.slice(norm.length + 1) : filePath;
    return this.fileHistory({
      logId: logIdForRepoPath(norm),
      path: relPath,
      ...(head ? { head } : {}),
      ...(limit ? { limit } : {}),
    }).map((row) => this.mapVcsEditOpRow(row));
  }

  /** Walk a commit's ancestry in the event-keyed commit DAG. */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsCommitAncestors(
    repoPath: string,
    eventId: string,
    limit?: number | null
  ): Array<{ eventId: string; stateHash: string | null; parentEventIds: string[] }> {
    this.ensureReady();
    void normalizeRepoPathArg(repoPath);
    return this.commitAncestors({ eventId, ...(limit ? { limit } : {}) });
  }

  /** Edits authored by an actor (author provenance), newest-lineage last. */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsEditsByActor(actorId: string, limit?: number | null): VcsEditOpRowWire[] {
    this.ensureReady();
    return this.editsByActor({ actorId, ...(limit ? { limit } : {}) }).map((row) =>
      this.mapVcsEditOpRow(row)
    );
  }

  /** Edits authored in an agent turn (causal provenance). */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsEditsByTurn(turnId: string): VcsEditOpRowWire[] {
    this.ensureReady();
    return this.editsByTurn({ turnId }).map((row) => this.mapVcsEditOpRow(row));
  }

  /** Edits authored in a single tool-call invocation (causal provenance). */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  vcsEditsByInvocation(invocationId: string): VcsEditOpRowWire[] {
    this.ensureReady();
    return this.editsByInvocation({ invocationId }).map((row) => this.mapVcsEditOpRow(row));
  }

  /**
   * Line-level blame (design §5.2). Materializes the file at `head` (via the
   * content bridge), maps `[startLine, endLine]` to char offsets, and composes
   * each offset back along the first-parent op chain (working tail first) with
   * @workspace/vcs-engine `blameChain`. `theirs`-origin merge hits re-gather the
   * OTHER parent's first-parent chain (bounded depth) and continue there. Each
   * range carries its producing op's commit/turn/actor; `create`/`binary`/
   * `synthetic`/`older-than-log` boundaries report `degraded`. `head` defaults to
   * `main` (userland dispatch carries no caller-context head resolution).
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async vcsBlameLines(
    repoPath: string,
    filePath: string,
    startLine: number,
    endLine: number,
    head?: string | null
  ): Promise<VcsBlameLineWire[]> {
    this.ensureReady();
    const norm = normalizeRepoPathArg(repoPath);
    const logId = logIdForRepoPath(norm);
    const relPath = filePath.startsWith(`${norm}/`) ? filePath.slice(norm.length + 1) : filePath;
    const path = normalizePath(relPath);
    const resolvedHead = head ?? "main";

    const store = this.contentStore();
    // 1. Materialize the file at head; no line blame for a missing or binary file.
    const text = await this.fileTextAtHead(store, logId, resolvedHead, path);
    if (text === null || text.length === 0) return [];
    const lineSpans = computeLineSpans(text);
    const from = Math.max(1, Math.trunc(startLine));
    const to = Math.min(Math.trunc(endLine), lineSpans.length);
    if (to < from) return [];
    const offsets: number[] = [];
    const lineOffsetCounts: number[] = [];
    for (let ln = from; ln <= to; ln += 1) {
      const span = lineSpans[ln - 1]!;
      const before = offsets.length;
      if (span.end > span.start) {
        for (let offset = span.start; offset < span.end; offset += 1) offsets.push(offset);
      } else {
        offsets.push(span.start);
      }
      lineOffsetCounts.push(offsets.length - before);
    }

    // 2. Gather the head's first-parent chain and compose each offset back.
    const headOps = this.blameChainRows(logId, resolvedHead, path);
    const perOffset = blameChain(headOps, offsets).map((r) =>
      this.blameResolvedFor(logId, path, r.resolution)
    );
    const perLine: Array<Omit<VcsBlameLineWire, "startLine" | "endLine">> = [];
    let cursor = 0;
    for (const count of lineOffsetCounts) {
      perLine.push(representativeLineBlame(perOffset.slice(cursor, cursor + count)));
      cursor += count;
    }
    // 3. Coalesce contiguous identical resolutions into ranges.
    return coalesceBlameLines(from, perLine);
  }

  /** The composed working text at `head` (base + uncommitted edits), or null
   *  when the path is absent or binary. */
  private async fileTextAtHead(
    store: HostContentStore,
    logId: string,
    head: string,
    path: string
  ): Promise<string | null> {
    const { baseStateHash } = await this.resolveComposeBase(store, logId, head);
    const working = await this.composeWorkingFiles(store, logId, head, baseStateHash);
    const entry = working.files.get(path);
    if (!entry) return null;
    const b64 = await store.getBase64(entry.contentHash);
    if (b64 === null) return null;
    return decodeUtf8Text(base64ToBytes(b64));
  }

  /** Blame's first-parent op chain for a path at a head: the uncommitted working
   *  tail (newest→oldest) then the committed first-parent lineage. */
  private blameChainRows(logId: string, head: string, path: string): BlameOpRow[] {
    const ops: BlameOpRow[] = [];
    const working = this.sql
      .exec(
        `SELECT * FROM gad_worktree_edit_ops
         WHERE log_id = ? AND head = ? AND path = ? AND committed_event_id IS NULL
         ORDER BY edit_seq DESC, ordinal DESC`,
        logId,
        head,
        path
      )
      .toArray() as JsonRecord[];
    for (const row of working) ops.push(this.toBlameOpRow(row));
    const tip = this.resolveWorktreeHeadInternal(logId, head)?.commitEventId ?? null;
    ops.push(...this.committedFirstParentChainRows(logId, path, tip));
    return ops;
  }

  /** A path's committed ops along the first-parent commit lineage from `tip`
   *  (newest→oldest), bounded by {@link BLAME_MAX_COMMITS}. */
  private committedFirstParentChainRows(
    logId: string,
    path: string,
    tipEventId: string | null
  ): BlameOpRow[] {
    const ops: BlameOpRow[] = [];
    const seen = new Set<string>();
    let cur: string | null = tipEventId;
    let commits = 0;
    while (cur && !seen.has(cur) && commits < BLAME_MAX_COMMITS) {
      seen.add(cur);
      commits += 1;
      const rows = this.sql
        .exec(
          `SELECT * FROM gad_worktree_edit_ops
           WHERE log_id = ? AND path = ? AND committed_event_id = ?
           ORDER BY edit_seq DESC, ordinal DESC`,
          logId,
          path,
          cur
        )
        .toArray() as JsonRecord[];
      for (const row of rows) ops.push(this.toBlameOpRow(row));
      cur = this.parentEventIdAt(cur, 0);
    }
    return ops;
  }

  private parentEventIdAt(eventId: string, ordinal: number): string | null {
    const row = this.sql
      .exec(
        `SELECT parent_event_id FROM gad_transition_parents WHERE event_id = ? AND ordinal = ?`,
        eventId,
        ordinal
      )
      .toArray()[0] as { parent_event_id?: string | null } | undefined;
    return row?.parent_event_id ?? null;
  }

  private toBlameOpRow(row: JsonRecord): BlameOpRow {
    const hunksJson = asString(row["hunks_json"]);
    return {
      opId: Number(row["id"]),
      kind: String(row["kind"]),
      hunks: hunksJson ? (JSON.parse(hunksJson) as BlameOpRow["hunks"]) : null,
      oldContentHash: asString(row["old_content_hash"]),
      newContentHash: asString(row["new_content_hash"]),
      synthetic: Number(row["synthetic"]) === 1,
      binary: Number(row["binary"]) === 1,
    };
  }

  private blameRowById(opId: string | number): JsonRecord | null {
    const row = this.sql
      .exec(`SELECT * FROM gad_worktree_edit_ops WHERE id = ?`, Number(opId))
      .toArray()[0] as JsonRecord | undefined;
    return row ?? null;
  }

  /** Resolve one line's blame result, routing `theirs`-origin merge hits onto the
   *  other parent's chain (bounded {@link BLAME_MAX_ROUTE_DEPTH}). */
  private blameResolvedFor(
    logId: string,
    path: string,
    resolution: BlameResolution
  ): Omit<VcsBlameLineWire, "startLine" | "endLine"> {
    let res = resolution;
    let depth = 0;
    while (res.kind === "route-theirs") {
      if (depth >= BLAME_MAX_ROUTE_DEPTH) return this.blameStop("older-than-log", null);
      depth += 1;
      const mergeRow = this.blameRowById(res.opId);
      const mergeCommit = mergeRow ? asString(mergeRow["committed_event_id"]) : null;
      const theirsEvent = mergeCommit ? this.parentEventIdAt(mergeCommit, 1) : null;
      if (!theirsEvent) return this.blameStop("older-than-log", null);
      const theirsOps = this.committedFirstParentChainRows(logId, path, theirsEvent);
      res = blameChain(theirsOps, [res.theirsOffset])[0]!.resolution;
    }
    if (res.kind === "op") return this.blameAttribute(res.opId, null);
    return this.blameStop(res.reason, res.opId ?? null);
  }

  private blameAttribute(
    opId: string | number,
    degraded: VcsBlameLineWire["degraded"]
  ): Omit<VcsBlameLineWire, "startLine" | "endLine"> {
    const row = this.blameRowById(opId);
    if (!row) return this.blameStop("older-than-log", null);
    return { opId: Number(opId), ...this.blameCommitMeta(row), degraded };
  }

  private blameStop(
    reason: VcsBlameLineWire["degraded"],
    opId: string | number | null
  ): Omit<VcsBlameLineWire, "startLine" | "endLine"> {
    if (opId != null) {
      const row = this.blameRowById(opId);
      if (row) return { opId: Number(opId), ...this.blameCommitMeta(row), degraded: reason };
    }
    return {
      opId: null,
      kind: null,
      commitEventId: null,
      commitMessage: null,
      invocationId: null,
      turnId: null,
      actorId: null,
      degraded: reason,
    };
  }

  /** The commit/turn/actor attribution for one op row (commit message via
   *  `gad_state_transitions.summary`; turn via the invocation→turn join). */
  private blameCommitMeta(row: JsonRecord): {
    kind: string;
    commitEventId: string | null;
    commitMessage: string | null;
    invocationId: string | null;
    turnId: string | null;
    actorId: string | null;
  } {
    const commitEventId = asString(row["committed_event_id"]);
    const invocationId = asString(row["invocation_id"]);
    let turnId = asString(row["turn_id"]);
    if (!turnId && invocationId) {
      const t = this.sql
        .exec(
          `SELECT turn_id FROM trajectory_invocations WHERE invocation_id = ? LIMIT 1`,
          invocationId
        )
        .toArray()[0] as { turn_id?: string | null } | undefined;
      turnId = asString(t?.turn_id ?? null);
    }
    let commitMessage: string | null = null;
    if (commitEventId) {
      const s = this.sql
        .exec(`SELECT summary FROM gad_state_transitions WHERE event_id = ?`, commitEventId)
        .toArray()[0] as { summary?: string | null } | undefined;
      const summary = asString(s?.summary ?? null);
      commitMessage = summary ? (summary.split("\n")[0] ?? null) : null;
    }
    return {
      kind: String(row["kind"]),
      commitEventId,
      commitMessage,
      invocationId,
      turnId,
      actorId: asString(row["actor_id"]),
    };
  }

  // =========================================================================
  // §6/§7/§9 provenance density + read-time attachment (DO-4). One unit used by
  // the read attachment, drill-down, and the speculative warm cache. Content
  // NEVER moves onto this DO (§7.2): the pipeline is pure SQL over the native
  // graph (edit ops, claims, relations) + the soft touch table + FTS recall.
  // The soft layer is best-effort and explicitly outside integrity/replay (§7.4).
  // =========================================================================

  /**
   * §6 pipeline for one file: provenance ∪ recall, re-ranked by session density,
   * with exceptions first and a salience floor (§7.5). `tier` is the agent's
   * budget dial (§7.1). Every read leaves ONE coalesced `observed` touch, at
   * every tier, even when the block is suppressed (§7.4). Returns the
   * item-budgeted page + `{ shown, total, nextCursor, suppressed }`.
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  provenanceForFile(input: {
    repoPath: string;
    path: string;
    head: string;
    tier: "none" | "moderate" | "deep";
    sessionLogId: string;
    sessionHead: string;
    invocationId?: string | null;
    recallKeywords?: string[] | null;
    after?: string | null;
    skipSuppression?: boolean | null;
  }): ProvenanceForFileResult {
    this.ensureReady();
    const logId = logIdForRepoPath(input.repoPath);
    const norm = normalizePath(this.repoRelative(input.repoPath, input.path));
    const dstId = fileNodeId(logId, norm);
    const tier = input.tier;
    const turnSeq = this.currentTurnOrdinal(input.sessionLogId, input.sessionHead);
    const observedTurnSeq = turnSeq < 0 ? null : turnSeq;

    // §12 counter #1: tier distribution — the health check on §7.1's judgment bet.
    this.bumpProvMetric("tier", tier);

    // tier 'none': no attachment. Still record that the read happened (§7.4 — the
    // touch records what the agent did, never what a block displayed).
    if (tier === "none") {
      this.upsertTouch({
        kind: "observed",
        sessionLogId: input.sessionLogId,
        sessionHead: input.sessionHead,
        dstKind: "file",
        dstId,
        invocationId: input.invocationId ?? null,
        turnSeq: observedTurnSeq,
      });
      return { items: [], shown: 0, total: 0, suppressed: false };
    }

    const drilldown = !!input.after || !!input.skipSuppression;
    // §12 counter #2: drilldown/paging rate. A drill on a file the system
    // recently pushed is an attach→action hit (§12 counter #4).
    if (drilldown) {
      this.bumpProvMetric("drilldown", input.after ? "page" : "deepen");
      this.bumpActionRateIfRendered(`file:${fileHandlePath(logId, norm)}`);
    }

    // §7.3 warm-cache serve: the disposable cache holds the DENSITY/recall leg
    // ONLY — never the exception class. A `moderate` density leg is served only
    // when its full density fingerprint still matches; `deep` always recomputes;
    // a paging/drill request bypasses the cache (it needs the full ranked tail).
    // Exceptions are spliced in LIVE below, on every path.
    const cacheKey = this.provenanceCacheKey({
      logId,
      head: input.head,
      path: norm,
      sessionLogId: input.sessionLogId,
      sessionHead: input.sessionHead,
      turnSeq,
      recallKeywords: input.recallKeywords ?? null,
    });
    let density: ProvItem[] | null = null;
    if (tier === "moderate" && !drilldown) {
      density = this.readProvenanceCache(cacheKey);
    }

    // §7.5 exception class — asserted contradictions + cross-session concurrency —
    // is recomputed LIVE against current state on every non-'none' read, cache hit
    // or miss (§12: it "always render[s], at the top, regardless of density"). It
    // is cheap (two indexed lookups) and is exactly the state that materializes
    // AFTER a turn.opened warm precompute (another session's uncommitted edit, a
    // freshly-asserted contradiction), so it must never be served from the cache.
    const exceptions = this.fileExceptionItems(logId, norm, input.head);

    // §7.3 standalone budget: compute the density leg against the PRE-READ touch
    // state (§7.4), bounded by PROV_BUDGET_MS; an overrun stashes the density leg
    // warm for the follow-on drill and degrades to the one-line hint — but still
    // renders the live exceptions ahead of it (the safety lines never hide behind
    // a budget miss).
    if (density === null) {
      const started = Date.now();
      density = this.fileDensityBlock({
        logId,
        path: norm,
        head: input.head,
        tier,
        sessionLogId: input.sessionLogId,
        sessionHead: input.sessionHead,
        turnSeq,
        recallKeywords: input.recallKeywords ?? null,
      });
      if (!drilldown && Date.now() - started > PROV_BUDGET_MS) {
        // §7.4/§7.3 ordering: write the observed touch (it does NOT bump the
        // version), THEN stash the density leg at that same version so the
        // follow-on moderate read serves it instead of re-degrading.
        this.bumpProvMetric("degrade", "budget");
        this.upsertTouch({
          kind: "observed",
          sessionLogId: input.sessionLogId,
          sessionHead: input.sessionHead,
          dstKind: "file",
          dstId,
          invocationId: input.invocationId ?? null,
          turnSeq: observedTurnSeq,
        });
        this.writeProvenanceCache(cacheKey, density);
        const hint = this.degradeHintItem(input.repoPath, norm);
        const items = [...exceptions, hint];
        return {
          items,
          shown: items.length,
          total: items.length,
          suppressed: false,
          degraded: true,
        };
      }
    }

    // Exceptions first, then the (possibly cached) density leg — never re-sorted.
    const ordered = [...exceptions, ...density];

    // §7.1 re-read suppression: block signature over (path content hash, latest
    // edit-op id, sorted LIVE exception handles), compared on the observed touch
    // row. A drill-down (`skipSuppression`) or a page (`after`) always renders.
    const exceptionHandles = exceptions.map((item) => item.handle).sort();
    const blockSig = this.blockSignature(logId, norm, input.head, exceptionHandles);
    let suppressed = false;
    if (!input.skipSuppression && !input.after) {
      const prior = this.lastObservedBlockSig(input.sessionLogId, input.sessionHead, dstId);
      suppressed = prior !== null && prior === blockSig;
    }

    // §7.1 paging: per-tier item budget; the `after` cursor pages the ranked tail
    // unbounded. Page one always shows every exception (a safety line the agent
    // must not skim past), then fills to budget with density.
    const total = ordered.length;
    const budget = tier === "deep" ? PROV_ITEM_BUDGET_DEEP : PROV_ITEM_BUDGET_MODERATE;
    let items: ProvItem[] = [];
    let nextCursor: string | undefined;
    if (!suppressed) {
      const offset = input.after ? Math.max(0, parseInt(input.after, 10) || 0) : 0;
      const exceptionCount = ordered.filter((item) => item.exception).length;
      const pageSize = offset === 0 ? Math.max(budget, exceptionCount) : budget;
      items = ordered.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      if (nextOffset < total) nextCursor = String(nextOffset);
    }

    if (suppressed) {
      this.bumpProvMetric("suppression", "suppressed");
    } else if (items.length > 0) {
      // §4.1 no-`included` rule: an instrumentation-only trace, never a ranking
      // input — feeds the attach→action counter (#4).
      this.logRenderedItems(input.sessionLogId, input.sessionHead, norm, items);
    }

    // §7.4 ordering: write THIS read's observed touch AFTER the query resolves,
    // carrying the recomputed block signature so the next identical read
    // suppresses (and, for suppression, so re-attach fires on any change).
    this.upsertTouch({
      kind: "observed",
      sessionLogId: input.sessionLogId,
      sessionHead: input.sessionHead,
      dstKind: "file",
      dstId,
      invocationId: input.invocationId ?? null,
      turnSeq: observedTurnSeq,
      blockSig,
    });

    return {
      items,
      shown: items.length,
      total,
      ...(nextCursor ? { nextCursor } : {}),
      suppressed,
    };
  }

  /**
   * §7.6 session orientation ("what should I know before I act?") — a PULL query
   * over the whole session touch-set: exceptions first (unreconciled
   * contradictions among session-touched claims; cross-session uncommitted edits
   * on session-touched files; main movements on touched repos since the session
   * base via the host ref log), then density-ranked top claims/files.
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async provenanceForSession(input: {
    sessionLogId: string;
    sessionHead: string;
    after?: string | null;
  }): Promise<ProvenanceForSessionResult> {
    this.ensureReady();
    const turnSeq = this.currentTurnOrdinal(input.sessionLogId, input.sessionHead);
    const seeds = this.sessionSeeds(input.sessionLogId, input.sessionHead, turnSeq);
    const exceptions = await this.sessionExceptionItems(
      input.sessionLogId,
      input.sessionHead,
      seeds
    );
    const candidates: ProvCand[] = this.spreadFromSeeds(seeds, 2).map((reach) => ({
      kind: reach.kind,
      id: reach.id,
      sim: 0,
      prov: reach.prov,
      recallRank: Number.POSITIVE_INFINITY,
      ...(reach.coeditCount != null ? { coeditCount: reach.coeditCount } : {}),
    }));
    const density = this.rankCandidates(candidates, /* targetFileId */ null).filter(
      (item) => item.score >= PROV_SALIENCE_FLOOR
    );
    const ordered = [...exceptions, ...density];

    const total = ordered.length;
    const budget = PROV_ITEM_BUDGET_DEEP;
    const offset = input.after ? Math.max(0, parseInt(input.after, 10) || 0) : 0;
    const pageSize = offset === 0 ? Math.max(budget, exceptions.length) : budget;
    const items = ordered.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    if (input.after) this.bumpProvMetric("drilldown", "page");
    return {
      items,
      shown: items.length,
      total,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  /**
   * Drill-down on a claim handle (`provenance("claim#…")`). Writes a `cited`
   * soft touch (§4.1 — a real agent behavior that reinforces density) and
   * returns the claim's neighborhood: its relations, the sessions that touched
   * it, and its anchoring commit. Always renders (a drill is never suppressed).
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  provenanceForClaim(input: {
    claimId: string;
    sessionLogId: string;
    sessionHead: string;
    invocationId?: string | null;
    after?: string | null;
  }): ProvenanceForFileResult {
    this.ensureReady();
    const turnSeq = this.currentTurnOrdinal(input.sessionLogId, input.sessionHead);
    // §4.1 cited touch: the drill-down IS the signal.
    this.upsertTouch({
      kind: "cited",
      sessionLogId: input.sessionLogId,
      sessionHead: input.sessionHead,
      dstKind: "claim",
      dstId: input.claimId,
      invocationId: input.invocationId ?? null,
      turnSeq: turnSeq < 0 ? null : turnSeq,
    });
    this.bumpProvMetric("drilldown", "deepen");
    this.bumpActionRateIfRendered(`claim#${input.claimId}`);

    const items = this.claimNeighborhoodItems(input.claimId);
    const total = items.length;
    const offset = input.after ? Math.max(0, parseInt(input.after, 10) || 0) : 0;
    const page = items.slice(offset, offset + PROV_ITEM_BUDGET_DEEP);
    const nextOffset = offset + page.length;
    return {
      items: page,
      shown: page.length,
      total,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
      suppressed: false,
    };
  }

  /**
   * §7.3 speculative warm: on `turn.opened`, precompute `moderate` blocks for the
   * session's recently-edited files into the disposable cache, keyed by the full
   * density fingerprint (session era, claim graph era, file stamp, turn, recall).
   * Best-effort — a failure never breaks the append.
   */
  private warmProvenanceForTurn(sessionLogId: string, sessionHead: string): void {
    try {
      const turnSeq = this.currentTurnOrdinal(sessionLogId, sessionHead);
      const files = this.sql
        .exec(
          `SELECT eo.log_id AS log_id, eo.head AS head, eo.path AS path, MAX(eo.id) AS recency
             FROM gad_worktree_edit_ops eo
             JOIN trajectory_invocations ti ON ti.invocation_id = eo.invocation_id
            WHERE ti.log_id = ? AND ti.head = ?
            GROUP BY eo.log_id, eo.head, eo.path
            ORDER BY recency DESC
            LIMIT ?`,
          sessionLogId,
          sessionHead,
          PROV_WARM_MAX_FILES
        )
        .toArray() as JsonRecord[];
      for (const row of files) {
        const logId = String(row["log_id"]);
        const head = String(row["head"]);
        const path = String(row["path"]);
        // Warm the DENSITY leg only — exceptions are always recomputed live on the
        // read path (§7.5), so precomputing them here would only bake in a stale
        // snapshot that the read is required to override.
        const block = this.fileDensityBlock({
          logId,
          path,
          head,
          tier: "moderate",
          sessionLogId,
          sessionHead,
          turnSeq,
          recallKeywords: null,
        });
        const cacheKey = this.provenanceCacheKey({
          logId,
          head,
          path,
          sessionLogId,
          sessionHead,
          turnSeq,
          recallKeywords: null,
        });
        this.writeProvenanceCache(cacheKey, block);
      }
    } catch {
      // Warm is disposable, never authority (§7.3) — swallow and move on.
    }
  }

  /** §6.1 density leg for one file, salience-floored (§7.5) — the CACHEABLE half
   *  of the block. The exception class is deliberately NOT computed here: it is
   *  spliced in live on every read (see `provenanceForFile`), never served from
   *  the disposable warm cache. Shared by the read attachment and the warm
   *  precompute so both stash the identical density leg. */
  private fileDensityBlock(input: {
    logId: string;
    path: string;
    head: string;
    tier: "moderate" | "deep";
    sessionLogId: string;
    sessionHead: string;
    turnSeq: number;
    recallKeywords: string[] | null;
  }): ProvItem[] {
    return this.fileDensityItems(input).filter((item) => item.score >= PROV_SALIENCE_FLOOR);
  }

  /** §7.5 exception class for one file (always render, sort first, regardless of
   *  score): asserted contradictions among file-linked claims + cross-session
   *  uncommitted edits on the path. */
  private fileExceptionItems(logId: string, path: string, head: string): ProvItem[] {
    const items: ProvItem[] = [];
    // Cross-session concurrency: another (log, head) holds uncommitted edits on
    // this path — the line that prevents co-editing collisions.
    const concurrent = this.sql
      .exec(
        `SELECT head AS other_head, COUNT(*) AS n FROM gad_worktree_edit_ops
          WHERE log_id = ? AND path = ? AND committed_event_id IS NULL AND head != ?
          GROUP BY head`,
        logId,
        path,
        head
      )
      .toArray() as JsonRecord[];
    for (const row of concurrent) {
      const otherHead = String(row["other_head"]);
      const n = asNumber(row["n"]);
      items.push({
        line: `session:${otherHead} has ${n} uncommitted edit${n === 1 ? "" : "s"} on this file`,
        handle: `session:${otherHead}`,
        kind: "concurrency",
        exception: true,
        score: 0,
      });
    }
    // Asserted contradictions among the file's linked claims (claims asserted by
    // an invocation that edited this file). Relations are agent-asserted (§8).
    const fileClaims = this.fileLinkedClaimIds(logId, path);
    if (fileClaims.size > 0) {
      for (const rel of this.contradictionsAmong(fileClaims)) {
        const other = rel.other;
        const text = this.claimText(other);
        items.push({
          line: `⚠ contradicts claim#${other}${text ? ` "${truncateInsight(text, 60)}"` : ""} → provenance(claim#${other})`,
          handle: `claim#${other}`,
          kind: "contradiction",
          exception: true,
          score: 0,
        });
      }
    }
    return items;
  }

  /** §6.1 density leg for one file: commits (exact provenance, recency-scored) +
   *  bounded 2-hop spreading activation from touch(S) + the recall (FTS) leg,
   *  each scored `w_sim·sim + w_prov·idf·prov`. */
  private fileDensityItems(input: {
    logId: string;
    path: string;
    head: string;
    tier: "moderate" | "deep";
    sessionLogId: string;
    sessionHead: string;
    turnSeq: number;
    recallKeywords: string[] | null;
  }): ProvItem[] {
    const cands = new Map<string, ProvCand>();
    const ensure = (kind: ProvCand["kind"], id: string): ProvCand => {
      const key = `${kind}:${id}`;
      let cand = cands.get(key);
      if (!cand) {
        cand = { kind, id, sim: 0, prov: 0, recallRank: Number.POSITIVE_INFINITY };
        cands.set(key, cand);
      }
      return cand;
    };

    // (1) The file's own recent commits — exact provenance, "never ranked away"
    // (§6): recency-scored so the newest clears the floor, older ones decay out.
    const commits = this.fileCommits(input.logId, input.path);
    commits.forEach((commit, i) => {
      const cand = ensure("commit", commit.eventId);
      cand.prov = Math.max(cand.prov, 0.9 * Math.pow(0.6, i));
      cand.commitMessage = commit.message;
      cand.turnsAgo = this.turnsAgoForInvocation(
        commit.invocationId,
        input.sessionLogId,
        input.sessionHead,
        input.turnSeq
      );
    });

    // (2) Spreading activation seeded from touch(S) (moderate 1-hop, deep 2-hop).
    const seeds = this.sessionSeeds(input.sessionLogId, input.sessionHead, input.turnSeq);
    const hops = input.tier === "deep" ? 2 : 1;
    for (const reach of this.spreadFromSeeds(seeds, hops)) {
      const cand = ensure(reach.kind, reach.id);
      cand.prov += reach.prov;
      if (reach.coeditCount != null) {
        cand.coeditCount = Math.max(cand.coeditCount ?? 0, reach.coeditCount);
      }
    }

    // (3) Recall (similarity) leg — claims + commit messages surfaced by FTS.
    const recall = this.recallForFile(
      input.path,
      input.recallKeywords,
      input.sessionLogId,
      input.sessionHead
    );
    recall.forEach((hit, i) => {
      if (hit.kind === "claim" && hit.id) {
        const cand = ensure("claim", hit.id);
        cand.sim = 1;
        cand.recallRank = Math.min(cand.recallRank, i);
      } else if (hit.kind === "commit" && hit.id) {
        const cand = ensure("commit", hit.id);
        cand.sim = 1;
        cand.recallRank = Math.min(cand.recallRank, i);
        if (!cand.commitMessage) cand.commitMessage = hit.snippet;
      }
    });

    return this.rankCandidates([...cands.values()], fileNodeId(input.logId, input.path));
  }

  /** Score + render candidates (§6.1). `targetFileId` (when set) drops the read
   *  file itself from its own block. Sorted by score, recall-rank as tiebreak. */
  private rankCandidates(cands: ProvCand[], targetFileId: string | null): ProvItem[] {
    const items: Array<ProvItem & { rank: number }> = [];
    for (const cand of cands) {
      if (targetFileId && cand.kind === "file" && cand.id === targetFileId) continue;
      const idf = cand.prov > 0 ? this.nodeIdf(cand.kind, cand.id) : 1;
      const score = PROV_W_SIM * cand.sim + PROV_W_PROV * idf * cand.prov;
      const rendered = this.renderDensityItem(cand, score);
      if (rendered) items.push({ ...rendered, rank: cand.recallRank });
    }
    items.sort((a, b) => b.score - a.score || a.rank - b.rank);
    return items.slice(0, PROV_CANDIDATE_CAP_N).map(({ rank: _rank, ...item }) => item);
  }

  /** Bounded 2-hop spreading activation (§6.1/§6.5): carry each seed's activation
   *  outward along native + soft edges, accumulating `prov` per reached node.
   *  Fan-out capped at M per node, frontier re-capped between hops. */
  private spreadFromSeeds(
    seeds: Map<string, ProvSeed>,
    hops: number
  ): Array<{ kind: "claim" | "file"; id: string; prov: number; coeditCount?: number }> {
    const prov = new Map<
      string,
      { kind: "claim" | "file"; id: string; prov: number; coeditCount?: number }
    >();
    let frontier = [...seeds.values()];
    for (let h = 0; h < hops && frontier.length > 0; h += 1) {
      const next = new Map<string, ProvSeed>();
      for (const node of frontier) {
        const neighbors = this.nodeNeighbors(node.kind, node.id);
        const norm = 1 / Math.sqrt(Math.max(1, neighbors.length)); // §6.1 norm(src)
        for (const nb of neighbors) {
          const contribution =
            node.activation * nb.weight * this.decayHistorical(nb.laterEdits) * norm;
          if (contribution <= 0) continue;
          const key = `${nb.kind}:${nb.id}`;
          const acc = prov.get(key) ?? { kind: nb.kind, id: nb.id, prov: 0 };
          acc.prov += contribution;
          if (nb.coeditCount != null)
            acc.coeditCount = Math.max(acc.coeditCount ?? 0, nb.coeditCount);
          prov.set(key, acc);
          const cur = next.get(key);
          if (!cur || cur.activation < contribution) {
            next.set(key, { kind: nb.kind, id: nb.id, activation: contribution });
          }
        }
      }
      frontier = [...next.values()]
        .sort((a, b) => b.activation - a.activation)
        .slice(0, PROV_FANOUT_CAP_M);
    }
    return [...prov.values()];
  }

  /** touch(S): the session's seed set, reconstructed DO-side over the branch
   *  chain (§6.4 logLineage) — edits (invocation join), claims (trajectory
   *  event), touches (session index). Each seed's activation is its edge kind
   *  weight × the sublinear hits curve × the session-recency decay (§6.3). */
  private sessionSeeds(
    sessionLogId: string,
    sessionHead: string,
    curTurnSeq: number
  ): Map<string, ProvSeed> {
    const seeds = new Map<string, ProvSeed>();
    const add = (
      kind: "claim" | "file",
      id: string,
      weight: number,
      anchorTurnSeq: number | null,
      hits: number
    ): void => {
      const turnsAgo =
        curTurnSeq >= 0 && anchorTurnSeq != null ? Math.max(0, curTurnSeq - anchorTurnSeq) : 0;
      const activation = weight * PROV_HITS_CURVE(hits) * this.decaySession(turnsAgo);
      const key = `${kind}:${id}`;
      const cur = seeds.get(key);
      if (!cur || cur.activation < activation) seeds.set(key, { kind, id, activation });
    };
    for (const seg of this.logLineage(sessionLogId, sessionHead)) {
      // Files edited by the session (edited edge).
      const edits = this.sql
        .exec(
          `SELECT eo.log_id AS log_id, eo.path AS path, tt.ordinal AS ord
             FROM gad_worktree_edit_ops eo
             JOIN trajectory_invocations ti ON ti.invocation_id = eo.invocation_id
             LEFT JOIN trajectory_turns tt
               ON tt.log_id = ti.log_id AND tt.head = ti.head AND tt.turn_id = ti.turn_id
            WHERE ti.log_id = ? AND ti.head = ?
            ORDER BY eo.id DESC LIMIT ?`,
          seg.logId,
          seg.head,
          PROV_SEED_CAP_K
        )
        .toArray() as JsonRecord[];
      for (const row of edits) {
        add(
          "file",
          fileNodeId(String(row["log_id"]), String(row["path"])),
          PROV_KIND_WEIGHT.edited,
          row["ord"] == null ? null : asNumber(row["ord"]),
          1
        );
      }
      // Claims asserted by the session (asserted edge).
      const claims = this.sql
        .exec(
          `SELECT c.claim_id AS claim_id, tt.ordinal AS ord
             FROM gad_claims c
             JOIN log_events le ON le.envelope_id = c.trajectory_event_id
             LEFT JOIN trajectory_invocations ti ON ti.invocation_id = c.invocation_id
             LEFT JOIN trajectory_turns tt
               ON tt.log_id = ti.log_id AND tt.head = ti.head AND tt.turn_id = ti.turn_id
            WHERE le.log_id = ? AND le.head = ? AND c.status != 'retracted'
            ORDER BY c.rowid DESC LIMIT ?`,
          seg.logId,
          seg.head,
          PROV_SEED_CAP_K
        )
        .toArray() as JsonRecord[];
      for (const row of claims) {
        add(
          "claim",
          String(row["claim_id"]),
          PROV_KIND_WEIGHT.asserted,
          row["ord"] == null ? null : asNumber(row["ord"]),
          1
        );
      }
      // Soft touches by the session (observed files / cited claims).
      const touches = this.sql
        .exec(
          `SELECT kind, dst_kind, dst_id, turn_seq, hits FROM gad_touches
            WHERE session_log_id = ? AND session_head = ?
            ORDER BY id DESC LIMIT ?`,
          seg.logId,
          seg.head,
          PROV_SEED_CAP_K
        )
        .toArray() as JsonRecord[];
      for (const row of touches) {
        const dstKind = String(row["dst_kind"]) === "claim" ? "claim" : "file";
        const weight =
          String(row["kind"]) === "cited" ? PROV_KIND_WEIGHT.cited : PROV_KIND_WEIGHT.observed;
        add(
          dstKind,
          String(row["dst_id"]),
          weight,
          row["turn_seq"] == null ? null : asNumber(row["turn_seq"]),
          asNumber(row["hits"] ?? 1)
        );
      }
    }
    return seeds;
  }

  /** A node's outgoing edges for spreading (capped at M). Native edges only —
   *  soft touches seed the walk, they are not re-traversed as edges. */
  private nodeNeighbors(
    kind: "claim" | "file",
    id: string
  ): Array<{
    kind: "claim" | "file";
    id: string;
    weight: number;
    laterEdits: number;
    coeditCount?: number;
  }> {
    const out: Array<{
      kind: "claim" | "file";
      id: string;
      weight: number;
      laterEdits: number;
      coeditCount?: number;
    }> = [];
    if (kind === "claim") {
      // claim ↔ claim relations (both directions), agent-asserted (§8).
      const related = this.sql
        .exec(
          `SELECT dst_claim_id AS other, weight FROM gad_claim_relations WHERE src_claim_id = ?
           UNION ALL
           SELECT src_claim_id AS other, weight FROM gad_claim_relations WHERE dst_claim_id = ?
           LIMIT ?`,
          id,
          id,
          PROV_FANOUT_CAP_M
        )
        .toArray() as JsonRecord[];
      for (const row of related) {
        out.push({
          kind: "claim",
          id: String(row["other"]),
          weight: PROV_KIND_WEIGHT.relation * asNumber(row["weight"] ?? 1),
          laterEdits: 0,
        });
      }
      // claim → files its asserting invocation edited (asserted edge, reversed).
      const files = this.sql
        .exec(
          `SELECT DISTINCT eo.log_id AS log_id, eo.path AS path
             FROM gad_worktree_edit_ops eo
             JOIN gad_claims c ON c.invocation_id = eo.invocation_id
            WHERE c.claim_id = ? LIMIT ?`,
          id,
          PROV_FANOUT_CAP_M
        )
        .toArray() as JsonRecord[];
      for (const row of files) {
        out.push({
          kind: "file",
          id: fileNodeId(String(row["log_id"]), String(row["path"])),
          weight: PROV_KIND_WEIGHT.asserted,
          laterEdits: 0,
        });
      }
    } else {
      const parsed = parseFileNodeId(id);
      if (!parsed) return out;
      // file ↔ file co-edited (share a commit) — the coupling signal.
      const coedited = this.sql
        .exec(
          `SELECT b.log_id AS log_id, b.path AS path,
                  COUNT(DISTINCT b.committed_event_id) AS shared
             FROM gad_worktree_edit_ops a
             JOIN gad_worktree_edit_ops b
               ON b.committed_event_id = a.committed_event_id AND b.log_id = a.log_id
            WHERE a.log_id = ? AND a.path = ? AND a.committed_event_id IS NOT NULL
              AND b.path != a.path
            GROUP BY b.log_id, b.path
            ORDER BY shared DESC LIMIT ?`,
          parsed.logId,
          parsed.path,
          PROV_FANOUT_CAP_M
        )
        .toArray() as JsonRecord[];
      for (const row of coedited) {
        out.push({
          kind: "file",
          id: fileNodeId(String(row["log_id"]), String(row["path"])),
          weight: PROV_KIND_WEIGHT.edited,
          laterEdits: 0,
          coeditCount: asNumber(row["shared"]),
        });
      }
      // file → claims asserted by an invocation that edited it (asserted edge).
      const claims = this.sql
        .exec(
          `SELECT DISTINCT c.claim_id AS claim_id
             FROM gad_claims c
             JOIN gad_worktree_edit_ops eo ON eo.invocation_id = c.invocation_id
            WHERE eo.log_id = ? AND eo.path = ? AND c.status != 'retracted' LIMIT ?`,
          parsed.logId,
          parsed.path,
          PROV_FANOUT_CAP_M
        )
        .toArray() as JsonRecord[];
      for (const row of claims) {
        out.push({
          kind: "claim",
          id: String(row["claim_id"]),
          weight: PROV_KIND_WEIGHT.asserted,
          laterEdits: 0,
        });
      }
    }
    return out.slice(0, PROV_FANOUT_CAP_M);
  }

  /** A file's committed history, newest first (distinct commit events). */
  private fileCommits(
    logId: string,
    path: string
  ): Array<{ eventId: string; message: string | null; invocationId: string | null }> {
    const rows = this.sql
      .exec(
        `SELECT eo.committed_event_id AS event_id, MAX(eo.committed_seq) AS seq,
                st.summary AS summary, st.invocation_id AS inv
           FROM gad_worktree_edit_ops eo
           LEFT JOIN gad_state_transitions st ON st.event_id = eo.committed_event_id
          WHERE eo.log_id = ? AND eo.path = ? AND eo.committed_event_id IS NOT NULL
          GROUP BY eo.committed_event_id
          ORDER BY seq DESC
          LIMIT ?`,
        logId,
        path,
        PROV_FANOUT_CAP_M
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => {
      const summary = asString(row["summary"]);
      return {
        eventId: String(row["event_id"]),
        message: summary ? (summary.split("\n")[0] ?? null) : null,
        invocationId: asString(row["inv"]),
      };
    });
  }

  /** The recall (FTS) leg for a file: query = the path (+ steering keywords),
   *  scoped to claims + commit messages. Absent keywords, the path carries it
   *  (§7.1 — keyword steering is a bonus, never load-bearing). */
  private recallForFile(
    path: string,
    recallKeywords: string[] | null,
    _sessionLogId: string,
    _sessionHead: string
  ): Array<{ kind: "claim" | "commit"; id: string | null; snippet: string }> {
    const recall = this.recallMemory({
      query: path,
      kinds: ["claim", "commit"],
      limit: PROV_FANOUT_CAP_M,
      ...(recallKeywords && recallKeywords.length > 0 ? { recallKeywords } : {}),
    });
    return recall.results.map((row) => {
      if (row.kind === "claim") {
        const claimId =
          row.anchor && typeof row.anchor["claimId"] === "string"
            ? (row.anchor["claimId"] as string)
            : null;
        return { kind: "claim" as const, id: claimId, snippet: row.snippet };
      }
      return { kind: "commit" as const, id: row.eventId, snippet: row.snippet };
    });
  }

  /** Render one density candidate to a bounded `insight + handle` line (§7.5).
   *  Returns null for a candidate with no displayable insight (e.g. an
   *  empty/retracted claim). */
  private renderDensityItem(cand: ProvCand, score: number): ProvItem | null {
    if (cand.kind === "commit") {
      const prefix = cand.id.slice(0, 8);
      const msg = cand.commitMessage ? ` "${truncateInsight(cand.commitMessage, 60)}"` : "";
      const ago = cand.turnsAgo != null ? ` · ${cand.turnsAgo} turns ago` : "";
      return {
        line: `last commit c:${prefix}${msg}${ago}`,
        handle: `commit:${prefix}`,
        kind: "commit",
        exception: false,
        score,
      };
    }
    if (cand.kind === "claim") {
      const text = this.claimText(cand.id);
      if (!text) return null;
      const sessions = this.claimSessionCount(cand.id);
      const rel = this.claimRelationNote(cand.id);
      const touched =
        sessions > 0 ? ` · ${sessions} session${sessions === 1 ? "" : "s"} touched it` : "";
      return {
        line: `claim#${cand.id} "${truncateInsight(text, 80)}"${rel}${touched}`,
        handle: `claim#${cand.id}`,
        kind: "claim",
        exception: false,
        score,
      };
    }
    const parsed = parseFileNodeId(cand.id);
    if (!parsed) return null;
    const wsPath = fileHandlePath(parsed.logId, parsed.path);
    const times = cand.coeditCount
      ? ` ×${cand.coeditCount} commit${cand.coeditCount === 1 ? "" : "s"}`
      : "";
    return {
      line: `co-edited with ${wsPath}${times}`,
      handle: `file:${wsPath}`,
      kind: "file",
      exception: false,
      score,
    };
  }

  /** The §7.6 orientation exception class, over the whole session touch-set. */
  private async sessionExceptionItems(
    sessionLogId: string,
    sessionHead: string,
    seeds: Map<string, ProvSeed>
  ): Promise<ProvItem[]> {
    const items: ProvItem[] = [];
    // Unreconciled contradictions among session-touched claims.
    const claimIds = new Set<string>();
    for (const seed of seeds.values()) if (seed.kind === "claim") claimIds.add(seed.id);
    for (const rel of this.contradictionsAmong(claimIds)) {
      const text = this.claimText(rel.other);
      items.push({
        line: `⚠ contradiction: claim#${rel.src} contradicts claim#${rel.other}${text ? ` "${truncateInsight(text, 50)}"` : ""} → provenance(claim#${rel.other})`,
        handle: `claim#${rel.other}`,
        kind: "contradiction",
        exception: true,
        score: 0,
      });
    }
    // Cross-session uncommitted edits on session-touched files + touched repos.
    const repos = new Set<string>();
    for (const seed of seeds.values()) {
      if (seed.kind !== "file") continue;
      const parsed = parseFileNodeId(seed.id);
      if (!parsed) continue;
      repos.add(parsed.logId);
      const concurrent = this.sql
        .exec(
          `SELECT head AS other_head, COUNT(*) AS n FROM gad_worktree_edit_ops
            WHERE log_id = ? AND path = ? AND committed_event_id IS NULL
            GROUP BY head`,
          parsed.logId,
          parsed.path
        )
        .toArray() as JsonRecord[];
      // Any uncommitted edits on a touched file from ANOTHER head are a collision
      // risk (§7.6). The session's own head is not the acting agent here (session
      // orientation spans the trajectory, not one vcs head), so surface all.
      for (const row of concurrent) {
        const otherHead = String(row["other_head"]);
        const n = asNumber(row["n"]);
        items.push({
          line: `session:${otherHead} has ${n} uncommitted edit${n === 1 ? "" : "s"} on ${fileHandlePath(parsed.logId, parsed.path)}`,
          handle: `file:${fileHandlePath(parsed.logId, parsed.path)}`,
          kind: "concurrency",
          exception: true,
          score: 0,
        });
      }
    }
    // Main movements on touched repos since the session base (host ref log, §2).
    const readLog = this.refsStore().listMainRefLog?.bind(this.refsStore());
    if (readLog) {
      const sinceMs = this.sessionStartMs(sessionLogId, sessionHead);
      for (const logId of repos) {
        const repoPath = repoPathFromLogId(logId);
        let movements: Awaited<ReturnType<NonNullable<HostRefsStore["listMainRefLog"]>>>;
        try {
          movements = await readLog(repoPath);
        } catch {
          continue;
        }
        const recent = movements
          .filter((m) => m.new !== m.old && (sinceMs == null || m.createdAt >= sinceMs))
          .slice(-3);
        for (const m of recent) {
          const to = m.new ? m.new.slice(0, 12) : "<removed>";
          items.push({
            line: `main moved on ${repoPath} → ${to} (${m.operation})${m.reason ? ` — ${m.reason}` : ""}`,
            handle: `session`,
            kind: "main-moved",
            exception: true,
            score: 0,
          });
        }
      }
    }
    return items;
  }

  /** Items for a claim drill-down (§7.1): the claim's relations, its anchoring
   *  commit, and how many sessions touched it. */
  private claimNeighborhoodItems(claimId: string): ProvItem[] {
    const items: ProvItem[] = [];
    const self = this.claimText(claimId);
    if (self) {
      const sessions = this.claimSessionCount(claimId);
      items.push({
        line: `claim#${claimId} "${truncateInsight(self, 100)}"${sessions > 0 ? ` · ${sessions} session${sessions === 1 ? "" : "s"} touched it` : ""}`,
        handle: `claim#${claimId}`,
        kind: "claim",
        exception: false,
        score: 1,
      });
    }
    // §8.1 anchor: the commit the claim was recorded against (within era), or the
    // denormalized ledger snapshot marked historical once its trajectory event
    // has been dropped by a schema bump. Sorts right below the claim text.
    const anchor = this.claimAnchorItem(claimId);
    if (anchor) items.push(anchor);
    const relations = this.sql
      .exec(
        `SELECT relation, dst_claim_id AS other, weight FROM gad_claim_relations WHERE src_claim_id = ?
         UNION ALL
         SELECT relation, src_claim_id AS other, weight FROM gad_claim_relations WHERE dst_claim_id = ?
         LIMIT ?`,
        claimId,
        claimId,
        PROV_CANDIDATE_CAP_N
      )
      .toArray() as JsonRecord[];
    for (const row of relations) {
      const other = String(row["other"]);
      const relation = String(row["relation"]);
      const text = this.claimText(other);
      items.push({
        line: `·${relation}· claim#${other}${text ? ` "${truncateInsight(text, 60)}"` : ""}`,
        handle: `claim#${other}`,
        kind: relation === "contradicts" ? "contradiction" : "relation",
        exception: relation === "contradicts",
        score: relation === "contradicts" ? 0 : PROV_KIND_WEIGHT.relation,
      });
    }
    // Contradiction relations sort first (exception class).
    items.sort((a, b) => Number(b.exception) - Number(a.exception));
    return items;
  }

  /** §8.1 anchor render for a claim drill-down. Reads the denormalized snapshot
   *  from the claim's ledger entry (`gad_claims.ledger_entry_id → anchor_json`).
   *  Within its era (the trajectory causality event still resolves to a log
   *  event) it surfaces only the anchoring commit — the one anchor fact the
   *  graph does not otherwise carry. Post-era (the trajectory event was dropped
   *  by a schema bump so the causality join is empty) it degrades to the stored
   *  snapshot — actor / repo / commit / time — marked historical, never breaking. */
  private claimAnchorItem(claimId: string): ProvItem | null {
    const row = this.sql
      .exec(
        `SELECT ledger_entry_id, trajectory_event_id FROM gad_claims WHERE claim_id = ?`,
        claimId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    const ledgerEntryId = asString(row["ledger_entry_id"]);
    if (!ledgerEntryId) return null; // era-scoped inline claim: no durable anchor.
    const ledger = this.readLedgerEntry(ledgerEntryId);
    if (!ledger) return null;
    const anchor = ledger.anchor;
    const commitEventId = asString(anchor["commitEventId"]);
    const commitMessage = asString(anchor["commitMessage"]);
    const trajectoryEventId = asString(row["trajectory_event_id"]);
    const withinEra =
      !!trajectoryEventId &&
      this.sql
        .exec(`SELECT 1 FROM log_events WHERE envelope_id = ? LIMIT 1`, trajectoryEventId)
        .toArray().length > 0;
    if (withinEra) {
      if (!commitEventId) return null;
      const msg = commitMessage ? ` "${truncateInsight(commitMessage, 60)}"` : "";
      return {
        line: `recorded against commit c:${commitEventId.slice(0, 8)}${msg}`,
        handle: `commit:${commitEventId.slice(0, 8)}`,
        kind: "commit",
        exception: false,
        score: PROV_KIND_WEIGHT.relation,
      };
    }
    // Post-era: the trajectory event is gone; render the stored snapshot.
    const actorLabel = asString(anchor["actorLabel"]);
    const repoPath = asString(anchor["repoPath"]);
    const recordedAt = asString(anchor["recordedAt"]);
    const parts = [
      actorLabel,
      repoPath ? `in ${repoPath}` : null,
      commitMessage ? `commit "${truncateInsight(commitMessage, 50)}"` : null,
      recordedAt ? `recorded ${recordedAt}` : null,
    ].filter((part): part is string => !!part);
    if (parts.length === 0) return null;
    return {
      line: `↩ historical anchor · ${parts.join(" · ")}`,
      handle: `claim#${claimId}`,
      kind: "historical",
      exception: false,
      score: 0,
    };
  }

  // ---- provenance density helpers ------------------------------------------

  private repoRelative(repoPath: string, filePath: string): string {
    const norm = normalizeRepoPathArg(repoPath);
    return filePath.startsWith(`${norm}/`) ? filePath.slice(norm.length + 1) : filePath;
  }

  private decaySession(turnsAgo: number): number {
    return Math.exp(-Math.max(0, turnsAgo) / PROV_DECAY_SESSION_TURNS);
  }

  private decayHistorical(laterEdits: number): number {
    return Math.exp(-Math.max(0, laterEdits) / PROV_DECAY_HISTORICAL);
  }

  /** §6.1 idf(C) = 1 / log(2 + degree(C)) — query-time capped degree count so a
   *  node connected to everything reads as background hum. */
  private nodeIdf(kind: "claim" | "file" | "commit", id: string): number {
    let degree = 0;
    if (kind === "claim") {
      degree =
        this.cappedCount(
          `SELECT 1 FROM gad_claim_relations WHERE src_claim_id = ? OR dst_claim_id = ? LIMIT 200`,
          [id, id]
        ) +
        this.cappedCount(
          `SELECT 1 FROM gad_touches WHERE dst_kind = 'claim' AND dst_id = ? LIMIT 200`,
          [id]
        );
    } else if (kind === "file") {
      const parsed = parseFileNodeId(id);
      if (parsed) {
        degree =
          this.cappedCount(
            `SELECT 1 FROM gad_worktree_edit_ops WHERE log_id = ? AND path = ? LIMIT 200`,
            [parsed.logId, parsed.path]
          ) +
          this.cappedCount(
            `SELECT 1 FROM gad_touches WHERE dst_kind = 'file' AND dst_id = ? LIMIT 200`,
            [id]
          );
      }
    } else {
      degree = this.cappedCount(
        `SELECT 1 FROM gad_worktree_edit_ops WHERE committed_event_id = ? LIMIT 200`,
        [id]
      );
    }
    return 1 / Math.log(2 + degree);
  }

  private cappedCount(sql: string, bindings: SqlBinding[]): number {
    return (
      (this.sql.exec(`SELECT COUNT(*) AS n FROM (${sql})`, ...bindings).one()["n"] as number) ?? 0
    );
  }

  private claimText(claimId: string): string | null {
    const row = this.sql
      .exec(
        `SELECT text, subject, predicate, object FROM gad_claims WHERE claim_id = ? AND status != 'retracted'`,
        claimId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    const text = this.claimSearchText({
      text: asString(row["text"]),
      subject: asString(row["subject"]),
      predicate: asString(row["predicate"]),
      object: asString(row["object"]),
    });
    return text || null;
  }

  private claimSessionCount(claimId: string): number {
    return this.cappedCount(
      `SELECT DISTINCT session_log_id, session_head FROM gad_touches
        WHERE dst_kind = 'claim' AND dst_id = ? LIMIT 200`,
      [claimId]
    );
  }

  /** A short "·supports #x·"-style note naming one of a claim's relations. */
  private claimRelationNote(claimId: string): string {
    const row = this.sql
      .exec(
        `SELECT relation, dst_claim_id AS other FROM gad_claim_relations WHERE src_claim_id = ? LIMIT 1`,
        claimId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return "";
    return ` ·${String(row["relation"])} claim#${String(row["other"])}·`;
  }

  /** Claim ids linked to a file: claims asserted by an invocation that edited it. */
  private fileLinkedClaimIds(logId: string, path: string): Set<string> {
    const rows = this.sql
      .exec(
        `SELECT DISTINCT c.claim_id AS claim_id
           FROM gad_claims c
           JOIN gad_worktree_edit_ops eo ON eo.invocation_id = c.invocation_id
          WHERE eo.log_id = ? AND eo.path = ? AND c.status != 'retracted'`,
        logId,
        path
      )
      .toArray() as JsonRecord[];
    return new Set(rows.map((row) => String(row["claim_id"])));
  }

  /** `contradicts` relations among a claim set (both endpoints in the set). */
  private contradictionsAmong(claimIds: Set<string>): Array<{ src: string; other: string }> {
    if (claimIds.size === 0) return [];
    const out: Array<{ src: string; other: string }> = [];
    const seen = new Set<string>();
    const rows = this.sql
      .exec(
        `SELECT src_claim_id AS src, dst_claim_id AS dst FROM gad_claim_relations
          WHERE relation = 'contradicts'`
      )
      .toArray() as JsonRecord[];
    for (const row of rows) {
      const src = String(row["src"]);
      const dst = String(row["dst"]);
      if (!claimIds.has(src) || !claimIds.has(dst)) continue;
      const key = [src, dst].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ src, other: dst });
    }
    return out;
  }

  private turnsAgoForInvocation(
    invocationId: string | null,
    sessionLogId: string,
    sessionHead: string,
    curTurnSeq: number
  ): number | null {
    if (!invocationId || curTurnSeq < 0) return null;
    const row = this.sql
      .exec(
        `SELECT tt.ordinal AS ord FROM trajectory_invocations ti
           JOIN trajectory_turns tt
             ON tt.log_id = ti.log_id AND tt.head = ti.head AND tt.turn_id = ti.turn_id
          WHERE ti.invocation_id = ? AND ti.log_id = ? AND ti.head = ? LIMIT 1`,
        invocationId,
        sessionLogId,
        sessionHead
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row || row["ord"] == null) return null;
    return Math.max(0, curTurnSeq - asNumber(row["ord"]));
  }

  private sessionStartMs(sessionLogId: string, sessionHead: string): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(created_at) AS first FROM gad_touches
          WHERE session_log_id = ? AND session_head = ?`,
        sessionLogId,
        sessionHead
      )
      .toArray()[0] as JsonRecord | undefined;
    const iso = asString(row?.["first"] ?? null);
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }

  // ---- block signature, render log, warm cache -----------------------------

  private fileContentStamp(logId: string, path: string, head: string): string {
    const working = this.sql
      .exec(
        `SELECT id, new_content_hash FROM gad_worktree_edit_ops
          WHERE log_id = ? AND head = ? AND path = ? AND committed_event_id IS NULL
          ORDER BY edit_seq DESC, ordinal DESC LIMIT 1`,
        logId,
        head,
        path
      )
      .toArray()[0] as JsonRecord | undefined;
    const latest =
      working ??
      (this.sql
        .exec(
          `SELECT id, new_content_hash FROM gad_worktree_edit_ops
            WHERE log_id = ? AND path = ? AND committed_event_id IS NOT NULL
            ORDER BY committed_seq DESC, edit_seq DESC, ordinal DESC LIMIT 1`,
          logId,
          path
        )
        .toArray()[0] as JsonRecord | undefined);
    const contentHash = latest ? (asString(latest["new_content_hash"]) ?? "") : "";
    const opId = latest ? String(latest["id"]) : "";
    return `${contentHash}|${opId}`;
  }

  private provenanceRecallKey(recallKeywords: string[] | null | undefined): string {
    return JSON.stringify(recallTokens(recallKeywords));
  }

  private provenanceCacheKey(input: {
    logId: string;
    head: string;
    path: string;
    sessionLogId: string;
    sessionHead: string;
    turnSeq: number;
    recallKeywords: string[] | null;
  }): ProvenanceCacheKey {
    return {
      logId: input.logId,
      head: input.head,
      path: input.path,
      sessionLogId: input.sessionLogId,
      sessionHead: input.sessionHead,
      recallKey: this.provenanceRecallKey(input.recallKeywords),
      turnSeq: input.turnSeq,
      touchVersion: this.touchVersion(input.sessionLogId, input.sessionHead),
      knowledgeVersion: this.knowledgeVersion(),
      contentStamp: this.fileContentStamp(input.logId, input.path, input.head),
    };
  }

  /** §7.1 block signature: (path content hash, latest edit-op id, sorted
   *  exception handles). Unchanged ⇒ the block is suppressed; a content change
   *  or a new exception item re-attaches. */
  private blockSignature(
    logId: string,
    path: string,
    head: string,
    exceptionHandles: string[]
  ): string {
    return sha256HexSyncText(
      `${this.fileContentStamp(logId, path, head)}|${exceptionHandles.join(",")}`
    );
  }

  private lastObservedBlockSig(
    sessionLogId: string,
    sessionHead: string,
    dstId: string
  ): string | null {
    const row = this.sql
      .exec(
        `SELECT last_block_sig FROM gad_touches
          WHERE kind = 'observed' AND session_log_id = ? AND session_head = ?
            AND dst_kind = 'file' AND dst_id = ?`,
        sessionLogId,
        sessionHead,
        dstId
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? asString(row["last_block_sig"]) : null;
  }

  private logRenderedItems(
    sessionLogId: string,
    sessionHead: string,
    path: string,
    items: ProvItem[]
  ): void {
    this.sql.exec(
      `INSERT INTO gad_prov_render_log (session_log_id, session_head, path, item_handles_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sessionLogId,
      sessionHead,
      path,
      JSON.stringify(items.map((item) => item.handle)),
      nowIso()
    );
  }

  /** §12 counter #4 (attach→action rate): bump the numerator when a drill-down /
   *  citation target matches a handle recently PUSHED to some session (logged in
   *  gad_prov_render_log). Instrumentation-only — the render log is never a
   *  ranking input (§4.1). The denominator is the render-log volume itself. */
  private bumpActionRateIfRendered(handle: string): void {
    const rendered = this.sql
      .exec(
        `SELECT 1 FROM gad_prov_render_log
          WHERE item_handles_json LIKE ? ESCAPE '\\'
          ORDER BY id DESC LIMIT 1`,
        `%${JSON.stringify(handle).replace(/[%_\\]/gu, "\\$&")}%`
      )
      .toArray()[0];
    if (rendered) this.bumpProvMetric("action_rate", "hit");
  }

  private degradeHintItem(repoPath: string, path: string): ProvItem {
    const wsPath = `${normalizeRepoPathArg(repoPath)}/${path}`;
    return {
      line: `provenance ready — provenance("${wsPath}")`,
      handle: `file:${wsPath}`,
      kind: "hint",
      exception: false,
      score: 0,
    };
  }

  private readProvenanceCache(key: ProvenanceCacheKey): ProvItem[] | null {
    const row = this.sql
      .exec(
        `SELECT touch_version, knowledge_version, content_stamp, rendered_json
           FROM gad_provenance_cache
          WHERE log_id = ? AND head = ? AND path = ?
            AND session_log_id = ? AND session_head = ?
            AND recall_key = ? AND turn_seq = ?`,
        key.logId,
        key.head,
        key.path,
        key.sessionLogId,
        key.sessionHead,
        key.recallKey,
        key.turnSeq
      )
      .toArray()[0] as JsonRecord | undefined;
    if (
      !row ||
      asNumber(row["touch_version"]) !== key.touchVersion ||
      asNumber(row["knowledge_version"]) !== key.knowledgeVersion ||
      asString(row["content_stamp"]) !== key.contentStamp
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(asString(row["rendered_json"]) ?? "[]");
      return Array.isArray(parsed) ? (parsed as ProvItem[]) : null;
    } catch {
      return null;
    }
  }

  private writeProvenanceCache(key: ProvenanceCacheKey, items: ProvItem[]): void {
    this.sql.exec(
      `INSERT INTO gad_provenance_cache (
         log_id, head, path, session_log_id, session_head, recall_key, turn_seq,
         touch_version, knowledge_version, content_stamp, rendered_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, path, session_log_id, session_head, recall_key, turn_seq) DO UPDATE SET
         touch_version = excluded.touch_version,
         knowledge_version = excluded.knowledge_version,
         content_stamp = excluded.content_stamp,
         rendered_json = excluded.rendered_json,
         created_at = excluded.created_at`,
      key.logId,
      key.head,
      key.path,
      key.sessionLogId,
      key.sessionHead,
      key.recallKey,
      key.turnSeq,
      key.touchVersion,
      key.knowledgeVersion,
      key.contentStamp,
      JSON.stringify(items),
      nowIso()
    );
  }

  /** Recent vcs commits for a repo head, newest first. `head` defaults to
   *  `main` — userland dispatch carries no caller-context head resolution. */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server", "extension"] })
  vcsLog(
    repoPath: string,
    limit?: number | null,
    head?: string | null
  ): Array<{
    seq: number;
    envelopeId: string;
    actor: unknown;
    summary: string | null;
    outputStateHash: string | null;
    appendedAt: string;
  }> {
    this.ensureReady();
    const max = limit && limit > 0 ? limit : 50;
    const events = this.readLog({
      logId: logIdForRepoPath(repoPath),
      head: head ?? "main",
      limit: 0,
    });
    return events
      .filter(
        (event) =>
          event.payloadKind === "state.snapshot_ingested" ||
          event.payloadKind === "state.merge_applied"
      )
      .slice(-max)
      .reverse()
      .map((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return {
          seq: event.seq,
          envelopeId: event.envelopeId,
          actor: event.actor,
          summary: typeof payload["summary"] === "string" ? payload["summary"] : null,
          outputStateHash:
            typeof payload["outputStateHash"] === "string" ? payload["outputStateHash"] : null,
          appendedAt: event.appendedAt,
        };
      });
  }

  // -------------------------------------------------------------------------
  // vcs status semantics (P5d) — what "ahead / diverged / deleted / dirty"
  // MEAN lives here, behind the userland `vcs` service. The host resolves
  // caller-context heads and dispatches; it no longer owns the definitions.
  // -------------------------------------------------------------------------

  /** True iff the repo log was retired via deleteRepo (carries an `archived:*`
   *  head) — used to distinguish a deleted repo from a brand-new unpushed one. */
  private repoLogWasArchived(logId: string): boolean {
    return this.listWorktreeHeads({ logId }).some((head) => head.head.startsWith("archived:"));
  }

  /** A head's committed state: `main` resolves through the PROTECTED REF (the
   *  authority — this store's recorded main is downstream provenance), other
   *  heads through this store's worktree-head rows. */
  private async committedHeadState(
    logId: string,
    repoPath: string,
    head: string
  ): Promise<string | null> {
    if (head === "main") {
      return (await this.refsStore().readMain(repoPath))?.stateHash ?? null;
    }
    return this.resolveCommittedHeadState(logId, head);
  }

  /** Path-level diff of two states (either side may be a server-minted state —
   *  listings resolve content-store-first). Mode-only changes count as
   *  changed, matching the content store's Merkle tree diff. */
  private async diffStatePaths(
    store: HostContentStore,
    leftStateHash: string,
    rightStateHash: string
  ): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const left = new Map(
      (await this.stateFilesFor(store, leftStateHash)).map((f) => [f.path, f] as const)
    );
    const right = new Map(
      (await this.stateFilesFor(store, rightStateHash)).map((f) => [f.path, f] as const)
    );
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [path, file] of right) {
      const prev = left.get(path);
      if (!prev) added.push(path);
      else if (prev.contentHash !== file.contentHash || prev.mode !== file.mode) {
        changed.push(path);
      }
    }
    for (const path of left.keys()) {
      if (!right.has(path)) removed.push(path);
    }
    added.sort();
    removed.sort();
    changed.sort();
    return { added, removed, changed };
  }

  /**
   * State-diff of `head` against its publish lineage: the committed changes
   * unique to `head`, never upstream-only drift from `main`. Pure store
   * computation — the on-disk tree is a disposable projection and is never
   * scanned. If `head` is an ancestor of `main`, there is nothing unpublished
   * even though the states differ.
   */
  private async unpublishedDelta(
    store: HostContentStore,
    logId: string,
    repoPath: string,
    head: string
  ): Promise<{
    headStateHash: string | null;
    baseStateHash: string | null;
    diverged: boolean;
    added: string[];
    removed: string[];
    changed: string[];
  }> {
    const headStateHash = await this.committedHeadState(logId, repoPath, head);
    const baseStateHash = (await this.refsStore().readMain(repoPath))?.stateHash ?? null;
    if (!headStateHash || headStateHash === baseStateHash) {
      return { headStateHash, baseStateHash, diverged: false, added: [], removed: [], changed: [] };
    }

    let diffBaseStateHash: string;
    let diverged = false;
    if (!baseStateHash) {
      diffBaseStateHash = EMPTY_STATE_HASH;
    } else {
      const mergeBase =
        this.getMergeBase({ leftStateHash: baseStateHash, rightStateHash: headStateHash })
          .baseStateHash ?? EMPTY_STATE_HASH;
      diverged = mergeBase !== baseStateHash;
      // Upstream-only drift: the head is already contained in main.
      if (mergeBase === headStateHash) {
        return { headStateHash, baseStateHash, diverged, added: [], removed: [], changed: [] };
      }
      diffBaseStateHash = mergeBase;
    }

    const diff = await this.diffStatePaths(store, diffBaseStateHash, headStateHash);
    return { headStateHash, baseStateHash, diverged, ...diff };
  }

  /**
   * Status of a repo head: its unpublished changes against the repo's
   * protected `main` (a pure state-diff, never a worktree scan), its
   * uncommitted working-edit count, and whether the repo was deleted
   * (archived). `dirty` iff ahead of main or carrying uncommitted edits;
   * `main` is always clean (it is the baseline). `head` defaults to `main` —
   * userland dispatch carries no caller-context head resolution.
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async vcsStatus(input: { repoPath: string; head?: string | null }): Promise<{
    stateHash: string | null;
    dirty: boolean;
    uncommitted: number;
    added: string[];
    removed: string[];
    changed: string[];
    deleted: boolean;
  }> {
    this.ensureReady();
    const norm = normalizeRepoPathArg(input.repoPath);
    const logId = logIdForRepoPath(norm);
    const resolvedHead = input.head ?? "main";
    const store = this.contentStore();
    const delta = await this.unpublishedDelta(store, logId, norm, resolvedHead);
    const deleted = delta.baseStateHash === null && this.repoLogWasArchived(logId);
    const uncommitted =
      resolvedHead === "main" ? 0 : this.workingEditRows(logId, resolvedHead).length;
    return {
      stateHash: delta.headStateHash,
      dirty:
        delta.added.length > 0 ||
        delta.removed.length > 0 ||
        delta.changed.length > 0 ||
        uncommitted > 0,
      uncommitted,
      added: delta.added,
      removed: delta.removed,
      changed: delta.changed,
      deleted,
    };
  }

  /**
   * Push status for a repo: how far a head is ahead of that repo's protected
   * `main` (the committed, unpushed changes), how many UNCOMMITTED working
   * edits it carries (push rejects while > 0), and whether `main` has
   * DIVERGED (a fast-forward push is impossible without an explicit
   * vcs.merge). Per-repo; paths are repo-relative. `head` defaults to `main`.
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async vcsPushStatus(input: { repoPath: string; head?: string | null }): Promise<{
    repoPath: string;
    head: string;
    headStateHash: string | null;
    mainStateHash: string | null;
    ahead: number;
    uncommitted: number;
    diverged: boolean;
    /** The repo was deleted from the workspace (its `main` is archived/gone).
     *  A push will be refused — restore or drop the context, don't re-push. */
    deleted: boolean;
    files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  }> {
    this.ensureReady();
    const norm = normalizeRepoPathArg(input.repoPath);
    const logId = logIdForRepoPath(norm);
    const resolvedHead = input.head ?? "main";
    const store = this.contentStore();
    const delta = await this.unpublishedDelta(store, logId, norm, resolvedHead);
    const files = [
      ...delta.added.map((path) => ({ path, kind: "added" as const })),
      ...delta.removed.map((path) => ({ path, kind: "removed" as const })),
      ...delta.changed.map((path) => ({ path, kind: "changed" as const })),
    ];
    const deleted = delta.baseStateHash === null && this.repoLogWasArchived(logId);
    const uncommitted =
      resolvedHead === "main" ? 0 : this.workingEditRows(logId, resolvedHead).length;
    return {
      repoPath: norm,
      head: resolvedHead,
      headStateHash: delta.headStateHash,
      mainStateHash: delta.baseStateHash,
      ahead: files.length,
      uncommitted,
      diverged: delta.diverged,
      deleted,
      files,
    };
  }

  // -------------------------------------------------------------------------
  // Merge support (WS3.P4) — value staging, merge-base, pending-merge ref
  // -------------------------------------------------------------------------

  /**
   * Create a worktree state VALUE from a file list. Provisional merge states
   * stay as unreferenced values; authored drafts that pass base/transition
   * metadata also append a normal log-backed transition edge.
   */
  @rpc({ callers: ["do", "server"] })
  stageWorktreeState(input: {
    files: Array<{ path: string; contentHash: string; size?: number | null; mode?: number | null }>;
    summary?: string | null;
    /** When set, record a `base -> staged` ancestry edge so a draft authored
     *  off a known base is a first-class DAG node (merge-base/blame), not a
     *  dangling value. */
    baseStateHash?: string | null;
    transition?: {
      logId: string;
      head: string;
      logKind?: LogKind | string | null;
      actor: ParticipantRef;
      eventId?: string | null;
      metadata?: Record<string, unknown> | null;
    } | null;
  }): { stateHash: string; eventId: string | null; headHash: string | null } {
    this.ensureReady();
    return this.transaction(() => {
      const files = input.files.map((file) => {
        const path = normalizePath(file.path);
        const mode = file.mode ?? 33188;
        this.ensureBlob(file.contentHash, file.size ?? 0);
        return {
          path,
          contentHash: file.contentHash,
          mode,
          fileVersionId: this.ensureFileVersion(path, file.contentHash, mode),
        };
      });
      const stateHash = this.createWorktreeState(files, {
        staged: true,
        ...(input.summary ? { summary: input.summary } : {}),
      });
      let eventId: string | null = null;
      let headHash: string | null = null;
      if (input.baseStateHash && input.baseStateHash !== stateHash) {
        if (!input.transition) {
          throw new Error("stageWorktreeState with baseStateHash requires transition metadata");
        }
        const existingLog = this.logHeadRow(input.transition.logId, input.transition.head);
        const logKind = existingLog
          ? String(existingLog["log_kind"])
          : String(input.transition.logKind ?? "vcs");
        eventId = input.transition.eventId ?? crypto.randomUUID();
        const result = this.appendLogEventInTxn({
          logId: input.transition.logId,
          head: input.transition.head,
          logKind,
          events: [
            {
              envelopeId: eventId,
              actor: input.transition.actor,
              payloadKind: "state.transition_recorded",
              payload: {
                protocol: "agentic.trajectory.v1",
                inputStateHash: input.baseStateHash,
                outputStateHash: stateHash,
                ...(input.summary ? { summary: input.summary } : {}),
                ...(input.transition.metadata ? { metadata: input.transition.metadata } : {}),
              },
            },
          ],
        });
        headHash = result.headHash;
      }
      return { stateHash, eventId, headHash };
    });
  }

  /**
   * Lowest common ancestor of two worktree states over the transition DAG
   * (edges: output → input + extra parents). Multiple candidate bases pick
   * the one closest to `left` (newest-first BFS); null when histories are
   * unrelated (callers fall back to the empty state).
   */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getMergeBase(input: { leftStateHash: string; rightStateHash: string }): {
    baseStateHash: string | null;
  } {
    this.ensureReady();
    const ancestors = (start: string): Map<string, number> => {
      const seen = new Map<string, number>([[start, 0]]);
      const queue: string[] = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        const depth = seen.get(current)!;
        const rows = this.sql
          .exec(
            `SELECT t.input_state_hash AS parent FROM gad_state_transitions t
              WHERE t.output_state_hash = ?
             UNION
             SELECT p.parent_state_hash AS parent FROM gad_transition_parents p
              JOIN gad_state_transitions t2 ON t2.event_id = p.event_id
              WHERE t2.output_state_hash = ?`,
            current,
            current
          )
          .toArray() as JsonRecord[];
        for (const row of rows) {
          const parent = asString(row["parent"]);
          if (!parent || seen.has(parent)) continue;
          seen.set(parent, depth + 1);
          queue.push(parent);
        }
      }
      return seen;
    };
    const leftAncestors = ancestors(input.leftStateHash);
    const rightAncestors = ancestors(input.rightStateHash);
    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [state, depth] of leftAncestors) {
      if (!rightAncestors.has(state)) continue;
      if (depth < bestDepth) {
        best = state;
        bestDepth = depth;
      }
    }
    return { baseStateHash: best };
  }

  /**
   * Pending-merge lifecycle ref for a head: set when a conflicted merge has
   * been materialized into the head's working tree; consumed by the
   * resolution commit (which records the merge parents). One pending merge
   * per head.
   */
  @rpc({ callers: ["do", "server"] })
  setPendingMerge(input: {
    logId: string;
    head: string;
    info: {
      oursStateHash: string;
      theirsStateHash: string;
      theirsEventId?: string | null;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      /**
       * False until the provisional (conflict-marked) state has been
       * materialized into the head's working tree. Readers that see
       * `materialized: false` (crash between set and materialize) must
       * re-materialize before treating the worktree as the resolution.
       */
      materialized?: boolean;
    };
  }): void {
    this.ensureReady();
    this.setStateValue(`merge:${input.logId}:${input.head}`, JSON.stringify(input.info));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getPendingMerge(input: { logId: string; head: string }): {
    info: {
      oursStateHash: string;
      theirsStateHash: string;
      theirsEventId?: string | null;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      materialized?: boolean;
    } | null;
  } {
    this.ensureReady();
    const raw = this.getStateValue(`merge:${input.logId}:${input.head}`);
    if (!raw) return { info: null };
    try {
      return { info: JSON.parse(raw) };
    } catch {
      return { info: null };
    }
  }

  @rpc({ callers: ["do", "server"] })
  clearPendingMerge(input: { logId: string; head: string }): void {
    this.ensureReady();
    this.deleteStateValue(`merge:${input.logId}:${input.head}`);
  }

  /**
   * Flip a parked pending merge to `materialized: true` — the host's
   * projection acknowledgement (the provisional conflict-marked tree reached
   * the head's working tree on disk). The crash-recovery invariant reads this
   * flag: a pending merge that was never materialized must be re-projected
   * before a commit can treat the worktree as the resolution.
   */
  @rpc({ callers: ["do", "server"] })
  markPendingMergeMaterialized(input: { logId: string; head: string }): { marked: boolean } {
    this.ensureReady();
    const pending = this.getPendingMerge(input).info;
    if (!pending) return { marked: false };
    this.setPendingMerge({
      logId: input.logId,
      head: input.head,
      info: { ...pending, materialized: true },
    });
    return { marked: true };
  }

  // -------------------------------------------------------------------------
  // Merge orchestration (P5d) — what a MERGE IS lives here: precondition
  // checks, base/tip resolution, the 3-way computation, the merge COMMIT on
  // clean, and the parked pending merge on conflict. The host is a follower:
  // it drains the provenance follower first (a `main` source must be in
  // lockstep with the protected ref), projects the returned state to disk,
  // acknowledges materialization, and emits build/reactive events. `main`
  // TARGETS are excluded — advancing main is the host's gated push-class
  // remnant (protected-ref CAS + approval + build gate).
  // -------------------------------------------------------------------------

  /** Port of the host commit-identity guard: a non-empty head must carry its
   *  producing commit event. */
  private commitEventIdOf(
    ref: { stateHash: string; commitEventId: string | null } | null,
    label: string
  ): string | null {
    if (!ref || ref.stateHash === EMPTY_STATE_HASH) return null;
    if (!ref.commitEventId) {
      throw new Error(`${label} has state ${ref.stateHash} but no commit event identity`);
    }
    return ref.commitEventId;
  }

  /** The source head's commits not yet on the target (first-parent walk from
   *  `theirs` back to `oursState`) — the structured upstream-commits list
   *  shared by merge results and the push-divergence error. */
  private upstreamCommitsBetween(
    oursState: string,
    theirsState: string,
    theirsEventId?: string | null
  ): Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }> {
    if (theirsEventId) return this.upstreamCommitsBetweenEvents(oursState, theirsEventId);
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = theirsState;
    for (let i = 0; i < 100; i++) {
      if (!cur || cur === oursState || cur === EMPTY_STATE_HASH) break;
      const prod = this.getGadStateProducer({ stateHash: cur });
      const eventId = prod ? asString(prod["event_id"]) : null;
      if (!prod || !eventId) break;
      out.push({
        eventId,
        message: asString(prod["summary"]) ?? "",
        stateHash: cur,
        createdAt: asString(prod["created_at"]) ?? null,
      });
      cur = prod["input_state_hash"] ? String(prod["input_state_hash"]) : null;
    }
    return out;
  }

  private upstreamCommitsBetweenEvents(
    stopState: string,
    tipEventId: string
  ): Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }> {
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = tipEventId;
    for (let i = 0; i < 100; i++) {
      if (!cur) break;
      const transition = this.getGadStateTransition({ eventId: cur });
      const stateHash = transition?.["output_state_hash"]
        ? String(transition["output_state_hash"])
        : null;
      if (!stateHash || stateHash === stopState || stateHash === EMPTY_STATE_HASH) break;
      out.push({
        eventId: cur,
        message: transition?.["summary"] ? String(transition["summary"]) : "",
        stateHash,
        createdAt: transition?.["created_at"] ? String(transition["created_at"]) : null,
      });
      const ancestors = this.commitAncestors({ eventId: cur, limit: 1 });
      cur = ancestors[0]?.parentEventIds[0] ?? null;
    }
    return out;
  }

  /**
   * Provenance ops for a merge / main-advance commit: a first-parent tree diff
   * OURS → merged. Each op's `oldContentHash` is the OURS-side (first-parent)
   * content, so the ops compose against the first parent (blame invariant U2).
   * Text files the 3-way merge rewrote carry origin-annotated hunks (U3);
   * whole-file adds/removes/mode-changes record a whole-file op.
   */
  private mergeEditOps(
    oursFiles: StateFileEntry[],
    mergedFiles: Array<{ path: string; contentHash: string; mode: number; hunks?: MergeHunk[] }>
  ): ProvenanceEditOp[] {
    const ours = new Map(oursFiles.map((f) => [f.path, f]));
    const merged = new Map(mergedFiles.map((f) => [f.path, f]));
    const ops: ProvenanceEditOp[] = [];
    const paths = [...new Set([...ours.keys(), ...merged.keys()])].sort();
    for (const path of paths) {
      const o = ours.get(path);
      const m = merged.get(path);
      if (m && !o) {
        ops.push({
          kind: "create",
          path,
          oldContentHash: null,
          newContentHash: m.contentHash,
          mode: m.mode,
          ...(m.hunks ? { hunks: m.hunks } : {}),
        });
      } else if (!m && o) {
        ops.push({ kind: "delete", path, oldContentHash: o.contentHash, newContentHash: null });
      } else if (m && o) {
        if (o.contentHash !== m.contentHash) {
          // A text file the 3-way merge line-merged carries origin-annotated
          // hunks (U3) and stays non-synthetic (blame routes through it). A
          // whole-file take-ours/take-theirs (or a snapshot diff on the
          // push/import paths) has NO line-level provenance — it is SYNTHETIC
          // (U1 carve-out): hunks absent is legal and blame treats it as a
          // chain restart / degraded stop rather than a silent gap.
          ops.push({
            kind: "replace",
            path,
            oldContentHash: o.contentHash,
            newContentHash: m.contentHash,
            mode: m.mode,
            ...(m.hunks ? { hunks: m.hunks } : { synthetic: true }),
          });
        } else if (o.mode !== m.mode) {
          ops.push({
            kind: "chmod",
            path,
            oldContentHash: o.contentHash,
            newContentHash: m.contentHash,
            mode: m.mode,
          });
        }
      }
    }
    return ops;
  }

  /**
   * Provenance ops for a CONFLICTED-merge RESOLUTION commit (blame invariants
   * 1 + 2/U2). The resolution commit's first parent is OURS (`lineageBase`);
   * its committed tree is the PROVISIONAL (conflict-marked) merge base with the
   * agent's resolution working rows replayed on top. Two classes of change
   * reach this commit without a naturally chain-continuous authored op and would
   * otherwise corrupt blame:
   *
   *  (A) files the agent HAND-RESOLVED via `vcs.edit` (`workingPaths`): those
   *      working rows were composed over the PROVISIONAL base, so the first
   *      row's `old_content_hash` = provisional (conflict-marked) content ≠ OURS
   *      — a first-parent chain break (U2 false positive) and provisional-vs-
   *      ours coordinate skew for regions outside the resolving hunks. A
   *      SYNTHETIC BRIDGE op OURS→provisional is recorded FIRST (ingest ops
   *      carry `edit_seq = NULL`, which sorts BEFORE the working rows' `edit_seq
   *      ≥ 1`), restarting the per-path chain at the merge boundary so the
   *      agent's rows compose OURS→provisional→resolved while KEEPING their own
   *      authorship (invocation/turn — merge-notes invariant 4). Blame of a
   *      resolved region still lands on the agent's hunked op; a context region
   *      degrades to `synthetic` at the merge commit rather than silently onto
   *      the ours op in the wrong coordinate space.
   *
   *  (B) files the 3-way merge CLEANLY auto-took from THEIRS (clean take-theirs,
   *      new theirs creates, theirs deletes) carry NO working row at all. Each
   *      is recorded as a whole-file op OURS→final via {@link mergeEditOps}
   *      (hunkless text takes are SYNTHETIC per the U1 carve-out) so blame
   *      attributes the incoming content to the merge commit — never silently
   *      to the ours/base `create` (blame-1).
   *
   * `workingPaths` get only the bridge (their content ops are the re-keyed
   * working rows); every other path the merged tree changed vs OURS gets a
   * whole-file op. Together with the re-keyed working rows this makes the
   * resolution commit a complete, chain-continuous, blame-covered merge commit.
   */
  private mergeResolutionEditOps(
    oursFiles: StateFileEntry[],
    provisionalFiles: StateFileEntry[],
    committedFiles: Array<{ path: string; contentHash: string; mode: number }>,
    workingPaths: Set<string>
  ): ProvenanceEditOp[] {
    const oursByPath = new Map(oursFiles.map((f) => [f.path, f]));
    const provByPath = new Map(provisionalFiles.map((f) => [f.path, f]));
    const ops: ProvenanceEditOp[] = [];
    // (A) OURS→provisional bridge for each hand-resolved path (chain restart).
    for (const path of [...workingPaths].sort()) {
      const prov = provByPath.get(path);
      // No provisional content (the agent CREATED this path during resolution):
      // the working `create` restarts the chain itself — no bridge needed.
      if (!prov) continue;
      const ours = oursByPath.get(path);
      // The merge left this path at OURS content (agent edited an untouched
      // file): the first working row's old already == OURS — no bridge needed.
      if (ours && ours.contentHash === prov.contentHash) continue;
      ops.push(
        ours
          ? {
              kind: "replace",
              path,
              oldContentHash: ours.contentHash,
              newContentHash: prov.contentHash,
              mode: prov.mode,
              synthetic: true,
            }
          : {
              // theirs-added file that ALSO carried a resolution edit: the
              // working row's old = provisional; a `create` restarts the chain.
              kind: "create",
              path,
              oldContentHash: null,
              newContentHash: prov.contentHash,
              mode: prov.mode,
            }
      );
    }
    // (B) whole-file ops for every OTHER path the merged tree changed vs OURS.
    for (const op of this.mergeEditOps(oursFiles, committedFiles)) {
      if (workingPaths.has(op.path)) continue;
      ops.push(op);
    }
    return ops;
  }

  // -------------------------------------------------------------------------
  // Push — DO-owned orchestration (P3). Ports the host push pipeline: clean
  // source, fast-forward-only divergence classification, candidate
  // composition, build gate, and the write-ahead-intent → refs.updateMains →
  // provenance publish (single-writer, crash-healable).
  // -------------------------------------------------------------------------

  /**
   * Group push: fast-forward N repos' protected `main` atomically. Ports
   * {@link WorkspaceVcs.push} into the DO — divergence is classified here (never
   * auto-merged), the build gate runs over the composed candidate view via the
   * host `build.validate`, and the advance PUBLISHES through the single-writer
   * `refs.updateMains` (write-ahead intent first, provenance after). The
   * host-minted on-behalf-of token names the originating principal for the
   * approval prompt.
   */
  @rpc({ callers: ["panel", "shell", "app", "worker", "do", "server", "extension"] })
  async vcsPush(input: {
    repoPaths: string[];
    sourceHead?: string | null;
    message?: string | null;
    actor?: ParticipantRef | null;
  }): Promise<VcsPushResultDo> {
    // READ-AT-ENTRY (durable invocation-token contract): capture the
    // on-behalf-of token, the HOST-RESOLVED caller context, AND the verified
    // caller synchronously, before ANY await — a concurrent dispatch can rebind
    // any of them across an await boundary.
    const invocationToken = this.invocationToken;
    const confinement = this.pushSourceConfinement();
    // `actor` is derived from the verified caller (client-side flip: userland
    // callers no longer thread it). An explicit actor (in-process host callers)
    // still wins for parity with the pre-flip contract.
    const actor = input.actor ?? this.callerParticipant();
    this.ensureReady();
    const sourceHead = this.resolvePushSourceHead(input.sourceHead, confinement);
    // Structural source-head confinement (register row 11): a sandboxed caller
    // may only push its OWN `ctx:` head. The context is HOST-VERIFIED (threaded
    // via the relay, never client-asserted); enforced BEFORE any read/publish.
    this.assertSourceHeadConfined(sourceHead, confinement);
    return this.runVcsPush({ ...input, sourceHead, actor }, invocationToken, false);
  }

  // -------------------------------------------------------------------------
  // Delete / restore / fork — DO-owned lifecycle sagas (narrow-host boundary
  // refactor Phase 4). The `refs.updateMains` CAS stays a host PRIMITIVE the DO
  // drives (approval-gated host-side, D3 — attribution rides the relay-minted
  // on-behalf-of token). Archive/restore lineage moves, the dependent-gate
  // DECISION (over the host `worktree.dependentRepos` primitive), the fork
  // rename bootstrap commit, and disk (re)projection (`worktree.project`) are
  // orchestrated HERE. The CAS is the FINAL step, so a pre-CAS failure rolls
  // back only DO-internal state (no gated ref-compensation, Fork D).
  // -------------------------------------------------------------------------

  /**
   * Archive a repo's history and drop it from the workspace. Orchestration:
   * gate on host-computed build-graph dependents (refuse without `force`),
   * archive the log lineage (DO-internal), THEN retire the protected `main` ref
   * (the host-gated `updateMains{next:null}` — the severe deletion prompt fires
   * host-side, classified from the null-next CAS shape). Disk removal is the
   * host's exactly-once `onMainsUpdated` reaction. A gate denial / CAS conflict
   * rolls the archive back (un-archive) — DO-internal, ungated.
   */
  @rpc({ callers: ["panel", "shell", "app", "worker", "do", "server", "extension"] })
  async vcsDeleteRepo(input: {
    repoPath: string;
    actor?: ParticipantRef | null;
    force?: boolean;
  }): Promise<{
    repoPath: string;
    archived: boolean;
    archiveHead: string | null;
    removedPaths: string[];
    dependents: string[];
    stateHash: string;
  }> {
    // READ-AT-ENTRY (durable token contract): capture the on-behalf-of token
    // synchronously before any await.
    const invocationToken = this.invocationToken;
    this.ensureReady();
    const repoPath = normalizeRepoPathArg(input.repoPath);
    if (repoPath === "meta") {
      throw new Error("Refusing to delete the `meta` repo (workspace configuration).");
    }
    const logId = logIdForRepoPath(repoPath);
    const store = this.contentStore();
    const mainWorktree = this.resolveWorktreeHeadInternal(logId, VCS_MAIN);
    if (!mainWorktree) {
      throw new Error(
        `Cannot delete ${repoPath}: it has no committed \`main\` (not a tracked repo).`
      );
    }
    const mainState = mainWorktree.stateHash;
    const removedPaths = (await this.stateFilesFor(store, mainState)).map((f) =>
      joinRepoPrefixPath(repoPath, f.path)
    );

    // Dependent gate (Fork B): the DO owns only the DECISION; the build graph is
    // a dumb host primitive (`worktree.dependentRepos`). Refuse unless `force`.
    const dependents = await this.worktreeStore().dependentRepos(repoPath);
    if (dependents.length > 0 && !input.force) {
      throw new Error(
        `Cannot delete ${repoPath}: ${dependents.length} repo(s) depend on it ` +
          `(${dependents.join(", ")}). Their builds will break — pass force to delete anyway.`
      );
    }

    // Archive FIRST (DO-internal), ref CAS LAST (Fork D): a pre-CAS failure
    // needs no gated ref-compensation.
    const archive = this.archiveRepoMain({
      logId,
      archiveHead: `${VCS_ARCHIVE_HEAD_PREFIX}${mainState}`,
    });
    try {
      await this.refsStore().updateMains({
        entries: [{ repoPath, expectedOld: mainState, next: null }],
        operation: "delete",
        ...(invocationToken ? { invocationToken } : {}),
      });
    } catch (error) {
      // The gated ref delete was denied / conflicted before it landed — roll the
      // archive back onto `main` (DO-internal, ungated) so the repo is intact.
      if (archive.archived && archive.archiveHead) {
        this.restoreRepoMain({ logId, archiveHead: archive.archiveHead });
      }
      throw error;
    }
    return {
      repoPath,
      archived: archive.archived,
      archiveHead: archive.archiveHead,
      removedPaths,
      dependents,
      stateHash: await this.workspaceViewFromRefs(store),
    };
  }

  /**
   * Recover a deleted repo: re-point `main` at its newest archive head and
   * re-materialize it on disk. Orchestration: guard the path is free, un-archive
   * the lineage (DO-internal), THEN re-create the protected `main` ref (the
   * host-gated `updateMains{expectedOld:null}` — an add-repo prompt classified
   * from the CAS shape, D3), THEN re-project the repo into the ACTIVE context
   * checkout (`ctx:workspace`) via the `worktree.project` primitive so it
   * re-appears on disk (D1/D2 — `main` has no checkout). A gate denial / CAS
   * conflict re-archives the lineage (DO-internal, ungated).
   */
  @rpc({ callers: ["panel", "shell", "app", "worker", "do", "server", "extension"] })
  async vcsRestoreRepo(input: { repoPath: string; actor?: ParticipantRef | null }): Promise<{
    repoPath: string;
    restored: boolean;
    fromArchiveHead: string | null;
    restoredPaths: string[];
    stateHash: string;
  }> {
    const invocationToken = this.invocationToken;
    this.ensureReady();
    const repoPath = normalizeRepoPathArg(input.repoPath);
    const logId = logIdForRepoPath(repoPath);
    const store = this.contentStore();
    // Occupancy guard: a live main (a different repo re-created at the path)
    // must not be clobbered.
    if (this.resolveWorktreeHeadInternal(logId, VCS_MAIN)) {
      throw new Error(
        `Cannot restore ${repoPath}: a repo already occupies that path (it was re-created since deletion).`
      );
    }
    const archives = this.listWorktreeHeads({ logId })
      .filter((h) => h.head.startsWith(VCS_ARCHIVE_HEAD_PREFIX))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const newest = archives[0];
    if (!newest) {
      throw new Error(`Cannot restore ${repoPath}: no archived history found at that path.`);
    }
    const restoredPaths = (await this.stateFilesFor(store, newest.stateHash)).map((f) =>
      joinRepoPrefixPath(repoPath, f.path)
    );

    // Un-archive FIRST (DO-internal), ref CAS LAST (Fork D).
    const restore = this.restoreRepoMain({ logId, archiveHead: newest.head });
    try {
      await this.refsStore().updateMains({
        entries: [{ repoPath, expectedOld: null, next: newest.stateHash }],
        operation: "restore",
        ...(invocationToken ? { invocationToken } : {}),
      });
    } catch (error) {
      // Re-archive (DO-internal, ungated) so nothing is left half-restored.
      this.archiveRepoMain({ logId, archiveHead: newest.head });
      throw error;
    }
    // Re-materialize into the ACTIVE context checkout so the repo re-appears on
    // disk (D1/D2 — never a `main` checkout).
    await this.worktreeStore().project(repoPath, VCS_ACTIVE_CONTEXT_HEAD, newest.stateHash);
    return {
      repoPath,
      restored: restore.restored,
      fromArchiveHead: restore.archiveHead,
      restoredPaths,
      stateHash: await this.workspaceViewFromRefs(store),
    };
  }

  /**
   * Fork a repo's entire `main` history into a NEW repo at `toPath` — a no-copy
   * lineage fork. Orchestration: `forkLog` (DO-internal lineage descent), a
   * `package.json` `name` rewrite as a bootstrap commit (blob put / tree mirror
   * / provenance ingest over the content-store primitives), the ONE host-gated
   * `main` ref creation (`updateMains{expectedOld:null}`, the add-repo prompt),
   * THEN disk projection into the ACTIVE context. Errors if the source has no
   * history or the destination exists.
   */
  @rpc({ callers: ["panel", "shell", "app", "worker", "do", "server", "extension"] })
  async vcsForkRepo(input: {
    fromPath: string;
    toPath: string;
    actor?: ParticipantRef | null;
  }): Promise<{ repoPath: string; head: string; inherited: number; stateHash: string }> {
    const invocationToken = this.invocationToken;
    this.ensureReady();
    const actor = input.actor ?? this.callerParticipant();
    const from = normalizeRepoPathArg(input.fromPath);
    const to = normalizeRepoPathArg(input.toPath);
    if (from === to) throw new Error(`forkRepo: source and destination are the same (${from})`);
    const fromLogId = logIdForRepoPath(from);
    const toLogId = logIdForRepoPath(to);

    const fromMainWorktree = this.resolveWorktreeHeadInternal(fromLogId, VCS_MAIN);
    if (!fromMainWorktree) {
      throw new Error(`forkRepo: source repo "${from}" has no history to fork`);
    }
    const fromMain = fromMainWorktree.stateHash;
    if (this.resolveWorktreeHeadInternal(toLogId, VCS_MAIN)) {
      throw new Error(`forkRepo: destination repo "${to}" already exists`);
    }
    const store = this.contentStore();

    // 1. No-copy lineage fork: vcs:repo:<from> @ main → vcs:repo:<to> @ main.
    const fork = this.forkLog({
      fromLogId,
      fromHead: VCS_MAIN,
      toLogId,
      toHead: VCS_MAIN,
    });

    // 2. Rewrite package.json `name` (when present) so the fork is build-valid —
    //    a direct main-bootstrap commit on the inherited lineage (history +
    //    rename). Uses the private ingest (the public surface refuses non-do main
    //    ingests; this IS the DO's own publish path).
    let finalState = fromMain;
    const baseFiles = await this.stateFilesFor(store, fromMain);
    const pkgEntry = baseFiles.find((f) => f.path === "package.json");
    if (pkgEntry) {
      const pkgBase64 = await store.getBase64(pkgEntry.contentHash);
      const pkgText = pkgBase64 !== null ? decodeUtf8Text(base64ToBytes(pkgBase64)) : null;
      const renamed = pkgText !== null ? renameWorkspacePackage(pkgText, to) : null;
      if (renamed && renamed !== pkgText) {
        const put = await store.putBase64(bytesToBase64(new TextEncoder().encode(renamed)));
        const files = baseFiles.map((f) =>
          f.path === "package.json" ? { ...f, contentHash: put.digest } : f
        );
        const ingest = this.transaction(() =>
          this.ingestWorktreeStateInTxn({
            logId: toLogId,
            head: VCS_MAIN,
            logKind: "vcs",
            actor,
            files,
            baseStateHash: fromMain,
            expectedRefStateHash: fromMain,
            eventKind: "state.snapshot_ingested",
            summary: `forkRepo: rename package to ${to}`,
            // A bootstrap rename on inherited lineage — snapshot-style provenance
            // (no true first-parent hunks), so it is SYNTHETIC (U1): a chain
            // restart for blame on the new repo's fresh main lineage.
            editOps: [
              {
                kind: "write",
                path: "package.json",
                oldContentHash: pkgEntry.contentHash,
                newContentHash: put.digest,
                synthetic: true,
              },
            ],
          })
        );
        finalState = ingest.stateHash;
        // Mirror the composed state so the handed-out hash resolves in the
        // content store (projection materializes from there).
        await this.mirrorStateToContentStore(store, files, finalState);
      }
    }

    // 3. The ONE host-gated main-ref change: create the new repo's protected
    //    `main` (expectedOld:null = an add-repo prompt from the CAS shape).
    await this.refsStore().updateMains({
      entries: [{ repoPath: to, expectedOld: null, next: finalState }],
      operation: "import",
      ...(invocationToken ? { invocationToken } : {}),
    });

    // 4. Project the fork onto the ACTIVE context's checkout so it appears on
    //    disk (D1/D2 — `main` has no checkout).
    await this.worktreeStore().project(to, VCS_ACTIVE_CONTEXT_HEAD, finalState);
    return { repoPath: to, head: VCS_MAIN, inherited: fork.inherited, stateHash: finalState };
  }

  /**
   * Snapshot the source-head confinement inputs read-at-entry: the caller kind
   * (sandboxed vs privileged) and the HOST-RESOLVED context id threaded on the
   * dispatch. Both must be captured synchronously at handler entry.
   */
  private pushSourceConfinement(): { callerKind: string | null; callerContextId: string | null } {
    return {
      callerKind: this.caller?.callerKind ?? null,
      callerContextId: this.callerContextId ?? null,
    };
  }

  /**
   * Resolve the public `vcs.push({ sourceHead? })` shape at the DO boundary.
   * Context callers may omit it and get their HOST-VERIFIED own `ctx:*` head;
   * callers with no registered context (shell/server/mobile shell/direct DO)
   * must name the source explicitly. This keeps the shared typed API intact
   * without letting an omitted source fall through to a later undefined
   * dereference.
   */
  private resolvePushSourceHead(
    sourceHead: string | null | undefined,
    confinement: { callerKind: string | null; callerContextId: string | null }
  ): string {
    if (sourceHead !== undefined && sourceHead !== null) {
      if (typeof sourceHead !== "string" || sourceHead.length === 0) {
        throw new Error("push: sourceHead must be a non-empty string when provided");
      }
      return sourceHead;
    }
    if (confinement.callerContextId) return `ctx:${confinement.callerContextId}`;
    throw new Error(
      "push: sourceHead is required when the caller has no registered context; " +
        "pass sourceHead explicitly or call from a context runtime."
    );
  }

  /**
   * Structural source-head confinement (docs/narrow-host-vcs-plan.md §3,
   * register row 11): recovers the deleted host `resolvePushSourceHead` policy
   * from the HOST-VERIFIED context instead of trusting the client-supplied head.
   *
   * - Privileged callers (chrome `shell`, `server`, DO-internal `do`, or a
   *   system/in-process call with no verified caller) are UNRESTRICTED — they
   *   may push any source head (matching the old `isPrivilegedCaller` short-
   *   circuit and the in-process host push path).
   * - Sandboxed callers (`panel`/`app`/`worker`/`extension`) pushing a `ctx:`
   *   source head must own it: the head must equal `ctx:{host-resolved context}`.
   *   A foreign `ctx:` head is REJECTED; an absent context fails CLOSED (the old
   *   "vcs.push … requires a context" error). Only a `ctx:` head is confined — a
   *   sandboxed caller naming `main`/`import:` as a push source gains nothing (the
   *   FF/phantom guards reject it), matching the old policy's scope.
   */
  private assertSourceHeadConfined(
    sourceHead: string,
    confinement: { callerKind: string | null; callerContextId: string | null }
  ): void {
    const { callerKind, callerContextId } = confinement;
    const isSandboxed =
      callerKind === "panel" ||
      callerKind === "app" ||
      callerKind === "worker" ||
      callerKind === "extension";
    if (!isSandboxed) return;
    if (!sourceHead.startsWith("ctx:")) return;
    if (!callerContextId) {
      throw new Error(
        `push: ${callerKind} caller pushed context head "${sourceHead}" but has no registered ` +
          `context — refusing (a sandboxed push must originate from its own context).`
      );
    }
    const ownHead = `ctx:${callerContextId}`;
    if (sourceHead !== ownHead) {
      throw new Error(
        `push: ${callerKind} callers may only push their own context head (${ownHead}), ` +
          `not ${sourceHead}.`
      );
    }
  }

  /** The verified caller as a provenance participant, read synchronously at
   *  handler entry (the invocation-token contract). Falls back to the system
   *  participant when there is no active RPC caller (alarm/lifecycle). */
  private callerParticipant(): ParticipantRef {
    const caller = this.caller;
    return caller
      ? ({ id: caller.callerId, kind: caller.callerKind } as unknown as ParticipantRef)
      : SYSTEM_PARTICIPANT;
  }

  private async runVcsPush(
    input: {
      repoPaths: string[];
      sourceHead: string;
      message?: string | null;
      actor: ParticipantRef;
    },
    invocationToken: string | undefined,
    isRetry: boolean
  ): Promise<VcsPushResultDo> {
    const store = this.contentStore();
    const sourceHead = input.sourceHead;
    const repoPaths = input.repoPaths.map(normalizeRepoPathArg);
    const seen = new Set<string>();
    for (const r of repoPaths) {
      if (seen.has(r)) throw new Error(`push: duplicate repoPath "${r}"`);
      seen.add(r);
    }

    // Heal any crash-window drift (pending intents / lineage) before reading
    // mains, so the FF/divergence checks see a consistent lineage.
    await this.healPublishDrift();

    // Precondition 1 — clean source: no uncommitted edits on any ctx source repo.
    if (sourceHead.startsWith("ctx:")) {
      for (const repoPath of repoPaths) {
        if (this.workingEditRows(logIdForRepoPath(repoPath), sourceHead).length > 0) {
          throw new Error(
            `push: uncommitted edits in ${repoPath} — vcs.commit or vcs.discardEdits first`
          );
        }
      }
    }

    // Precondition 2 — fast-forward-only per repo, against the CURRENT host main.
    const advancing: Array<{
      repoPath: string;
      logId: string;
      oursState: string;
      candidateState: string;
      sourceEventId: string | null;
      files: Array<{ path: string; contentHash: string; mode: number }>;
    }> = [];
    const divergences: Extract<VcsPushResultDo, { status: "diverged" }>["divergences"] = [];

    for (const repoPath of repoPaths) {
      const logId = logIdForRepoPath(repoPath);
      const oursState = (await this.refsStore().readMain(repoPath))?.stateHash ?? EMPTY_STATE_HASH;
      // Deletion-resurrection guard: a stale context cannot revive a deleted repo.
      if (oursState === EMPTY_STATE_HASH && this.repoLogWasArchived(logId)) {
        throw new Error(
          `push: repo "${repoPath}" was deleted (its history is archived). A stale context ` +
            `cannot resurrect it by pushing. Restore it explicitly (vcs.restoreRepo) or drop/rebase your context.`
        );
      }
      let theirsState: string | undefined;
      let sourceEventId: string | null;
      if (sourceHead === "main") {
        theirsState = oursState === EMPTY_STATE_HASH ? undefined : oursState;
        sourceEventId = this.commitEventIdOf(
          this.resolveWorktreeHeadInternal(logId, "main"),
          `${repoPath}:main`
        );
      } else {
        const ref = this.resolveWorktreeHeadInternal(logId, sourceHead);
        theirsState = ref?.stateHash;
        sourceEventId = this.commitEventIdOf(ref, `${repoPath}:${sourceHead}`);
      }
      // Phantom-repo guard.
      if (oursState === EMPTY_STATE_HASH && (!theirsState || theirsState === EMPTY_STATE_HASH)) {
        throw new Error(
          `push: unknown repo "${repoPath}" — it has no main and no content on ${sourceHead}. ` +
            `Create files under ${repoPath}/ first, then push.`
        );
      }
      if (!theirsState || theirsState === oursState) continue;

      if (oursState !== EMPTY_STATE_HASH) {
        const base =
          this.getMergeBase({ leftStateHash: oursState, rightStateHash: theirsState })
            .baseStateHash ?? EMPTY_STATE_HASH;
        if (base !== oursState) {
          // Diverged: dry-run 3-way to classify clean-mergeable vs conflict.
          const dry = await this.computeMerge({
            oursStateHash: oursState,
            theirsStateHash: theirsState,
            labels: { ours: `${repoPath}:main`, theirs: `${repoPath}:${sourceHead}` },
          });
          const oursEventId = this.commitEventIdOf(
            this.resolveWorktreeHeadInternal(logId, "main"),
            `${repoPath}:main`
          );
          divergences.push({
            repoPath,
            base,
            mainTip: oursState,
            upstreamCommits: this.upstreamCommitsBetween(base, oursState, oursEventId),
            mergeable: dry.status === "conflicted" ? "conflict" : "clean",
            ...(dry.status === "conflicted"
              ? { conflictPaths: dry.conflicts.map((c) => c.path) }
              : {}),
          });
          continue;
        }
      }
      const files = (await this.stateFilesFor(store, theirsState)).map((f) => ({
        path: f.path,
        contentHash: f.contentHash,
        mode: f.mode,
      }));
      advancing.push({
        repoPath,
        logId,
        oursState,
        candidateState: theirsState,
        sourceEventId,
        files,
      });
    }

    if (divergences.length > 0) return { status: "diverged", divergences };
    if (advancing.length === 0) return { status: "up-to-date", repoPaths, reports: [] };

    // Build gate over the composed candidate view (every repo at main, pushed
    // repos overlaid at their candidate states).
    const baseStates = await this.collectRepoMainStatesFromRefs();
    const overlay = new Map(baseStates.map((s) => [normalizeRepoPathArg(s.repoPath), s.stateHash]));
    for (const c of advancing) overlay.set(c.repoPath, c.candidateState);
    const baseView = await this.composeRepoStatesMirrored(store, baseStates);
    const candidateView = await this.composeRepoStatesMirrored(
      store,
      [...overlay].map(([repoPath, stateHash]) => ({ repoPath, stateHash }))
    );
    const reports = await this.buildStore().validate({
      viewHash: candidateView,
      repoPaths: advancing.map((c) => c.repoPath),
      baseViewHash: baseView,
    });
    if (reports.some((r) => r.required && r.status === "failed")) {
      return { status: "build-failed", reports };
    }

    // PUBLISH — write-ahead intent, then the single-writer group CAS, then
    // provenance. On CAS conflict: discard intent, re-read, bounded retry.
    const entries: PublishIntentEntry[] = [];
    for (const c of advancing) {
      const oursFiles =
        c.oursState === EMPTY_STATE_HASH ? [] : await this.stateFilesFor(store, c.oursState);
      entries.push({
        repoPath: c.repoPath,
        logId: c.logId,
        expectedOld: c.oursState === EMPTY_STATE_HASH ? null : c.oursState,
        next: c.candidateState,
        parentEventId: c.sourceEventId,
        parentStateHash: c.candidateState,
        files: c.files,
        editOps: this.mergeEditOps(oursFiles, c.files),
      });
    }
    const intent: PublishIntent = {
      intentId: crypto.randomUUID(),
      operation: "push",
      entries,
      message: input.message ?? null,
      actor: input.actor,
      sourceHead,
    };
    // Mark in-flight BEFORE the durable record + the (human-gated) CAS window so
    // a concurrent heal never stale-reaps this parked intent (see field doc).
    this.inFlightPublishIntents.add(intent.intentId);
    this.transaction(() => this.recordPublishIntent(intent));
    try {
      try {
        await this.refsStore().updateMains({
          entries: entries.map((e) => ({
            repoPath: e.repoPath,
            expectedOld: e.expectedOld,
            next: e.next,
          })),
          reason: input.message ?? `push ${repoPaths.join(", ")} from ${sourceHead}`,
          operation: "push",
          ...(invocationToken ? { invocationToken } : {}),
        });
      } catch (error) {
        if (this.isRefConflictError(error)) {
          // A conflict may be our OWN duplicate POST: attempt 1 committed
          // host-side, its response was lost, and the auto-retry then hit the ref
          // we already advanced. Do NOT delete before classifying — if our
          // candidate IS the current main the CAS landed and we owe provenance,
          // not a spurious success without it.
          //
          // First-attempt conflict: re-drive with a fresh intent. THIS intent
          // stays parked; the re-drive's entry heal (healPublishDrift) completes
          // it if our CAS actually landed (lost response) — it is in-flight, so
          // that heal never stale-reaps it — else a later heal discards it against
          // the ref log. The outer finally clears this intent's in-flight marker.
          if (!isRetry) return this.runVcsPush(input, invocationToken, true);
          const race = await this.pushRaceResult(advancing, reports);
          if (race) {
            // up-to-date ⇒ every candidate equals the current main ⇒ our CAS
            // landed (lost response): record provenance (idempotent — skips
            // entries whose recorded main already equals `next`) before returning,
            // instead of reporting success with the provenance thrown away.
            if (race.status === "up-to-date") this.completePublishIntent(intent);
            return race;
          }
          // Indeterminate conflict: leave the intent parked; healPublishDrift
          // completes it if the CAS landed or discards it against the ref log.
          throw error;
        }
        // Non-conflict failure (approval denial, or a lost-response transport
        // error that may or may not have applied): do NOT delete. The write-ahead
        // intent exists precisely to survive a crash between the CAS and its
        // provenance — healPublishDrift completes it if the CAS landed, else
        // discards it against the ref log. Deleting here would fall back to the
        // unrecoverable no-intent drift (lineage/attribution/hunk loss).
        throw error;
      }

      // Success: record provenance with full fidelity, then complete (delete) the
      // intent. A crash between the CAS and here is healed on next start / push.
      this.completePublishIntent(intent);
      for (const c of advancing) {
        await this.mirrorStateToContentStore(store, c.files, c.candidateState);
      }
      // Re-pin the ctx source's base view to the freshly-published workspace view
      // (host did this at workspaceVcs.ts push tail): the context now reads from
      // the advanced main, so subsequent reads/edits diff against it, not the
      // stale pre-push base.
      if (sourceHead.startsWith("ctx:")) {
        await this.vcsPinContext({
          contextId: sourceHead.slice("ctx:".length),
          baseView: candidateView,
        }).catch(() => {});
      }
      return { status: "pushed", repoPaths: advancing.map((c) => c.repoPath), reports };
    } finally {
      this.inFlightPublishIntents.delete(intent.intentId);
    }
  }

  /**
   * Publish an imported repo tree onto its protected `main`. The git-bridge
   * ingests the outside-world git history onto a NON-MAIN `import:*` staging
   * head (preserving commit messages/authors), then calls this method; the
   * advance goes through the SAME write-ahead-intent → single-writer
   * `refs.updateMains({ operation: "import" })` → provenance machinery as push,
   * so it is approval-gated and attributed to the originating extension via the
   * host-minted invocation token. `expectedOld` is the current main (null for a
   * brand-new repo). No-ops when main already equals the staged state. This
   * replaces the deleted ungated `vcs.adoptImportedRepo` /
   * `WorkspaceVcs.adoptMainFromStore` adoption (closes finding 2).
   */
  @rpc({ callers: ["extension", "server", "do"] })
  async vcsImportPublish(input: {
    repoPath: string;
    sourceHead: string;
    message?: string | null;
    actor?: ParticipantRef | null;
  }): Promise<VcsImportPublishResultDo> {
    // READ-AT-ENTRY (invocation-token contract): capture the on-behalf-of token
    // and verified caller synchronously, before any await.
    const invocationToken = this.invocationToken;
    const actor = input.actor ?? this.callerParticipant();
    this.ensureReady();
    return this.runVcsImportPublish({ ...input, actor }, invocationToken);
  }

  private async runVcsImportPublish(
    input: { repoPath: string; sourceHead: string; message?: string | null; actor: ParticipantRef },
    invocationToken: string | undefined
  ): Promise<VcsImportPublishResultDo> {
    const store = this.contentStore();
    const repoPath = normalizeRepoPathArg(input.repoPath);
    const logId = logIdForRepoPath(repoPath);
    if (input.sourceHead === "main" || !input.sourceHead.startsWith("import:")) {
      throw new Error(
        `import publish: sourceHead must be a non-main import staging head, got "${input.sourceHead}"`
      );
    }

    // Heal any crash-window drift before reading main so the CAS sees a
    // consistent lineage.
    await this.healPublishDrift();

    // The staging lineage the bridge ingested the imported history onto.
    const stagingRef = this.resolveWorktreeHeadInternal(logId, input.sourceHead);
    const candidateState = stagingRef?.stateHash;
    if (!candidateState || candidateState === EMPTY_STATE_HASH) {
      throw new Error(
        `import publish: staging head ${input.sourceHead} for ${repoPath} has no ingested state`
      );
    }

    const oursState = (await this.refsStore().readMain(repoPath))?.stateHash ?? EMPTY_STATE_HASH;
    if (candidateState === oursState) {
      return { status: "up-to-date", repoPath, stateHash: oursState };
    }

    const files = (await this.stateFilesFor(store, candidateState)).map((f) => ({
      path: f.path,
      contentHash: f.contentHash,
      mode: f.mode,
    }));
    const oursFiles =
      oursState === EMPTY_STATE_HASH ? [] : await this.stateFilesFor(store, oursState);
    // Import provenance ops (main → imported tree). True per-line hunks are
    // unavailable for an external git snapshot, so the ops are stamped SYNTHETIC
    // (blame treats them as a chain restart, A2) and skip first-parent
    // chain-continuity validation at completion.
    const editOps = this.mergeEditOps(oursFiles, files).map((op) => ({
      ...op,
      synthetic: true as const,
    }));
    const sourceEventId = this.commitEventIdOf(stagingRef, `${repoPath}:${input.sourceHead}`);
    const entry: PublishIntentEntry = {
      repoPath,
      logId,
      expectedOld: oursState === EMPTY_STATE_HASH ? null : oursState,
      next: candidateState,
      parentEventId: sourceEventId,
      parentStateHash: candidateState,
      files,
      editOps,
      synthetic: true,
    };
    const intent: PublishIntent = {
      intentId: crypto.randomUUID(),
      operation: "import",
      entries: [entry],
      message: input.message ?? null,
      actor: input.actor,
      sourceHead: input.sourceHead,
    };
    // Mark in-flight BEFORE the durable record + the (human-gated) CAS window so
    // a concurrent heal never stale-reaps this parked intent (see field doc).
    this.inFlightPublishIntents.add(intent.intentId);
    this.transaction(() => this.recordPublishIntent(intent));
    try {
      try {
        await this.refsStore().updateMains({
          entries: [{ repoPath: entry.repoPath, expectedOld: entry.expectedOld, next: entry.next }],
          reason: input.message ?? `import ${repoPath} from git`,
          operation: "import",
          ...(invocationToken ? { invocationToken } : {}),
        });
      } catch (error) {
        // updateMains may have landed host-side before throwing (a lost-response
        // duplicate POST surfacing as a conflict or transport error). Do NOT
        // delete: leave the write-ahead intent parked so healPublishDrift
        // completes it with full provenance if the CAS landed, or discards it
        // against the ref log if it never did. Import is idempotent (re-scan +
        // re-publish), so no in-place retry loop is needed.
        throw error;
      }

      // Success: record provenance with full fidelity, then complete the intent.
      // A crash between the CAS and here is healed on next start / push.
      this.completePublishIntent(intent);
      await this.mirrorStateToContentStore(store, files, candidateState);
      return { status: "published", repoPath, stateHash: candidateState };
    } finally {
      this.inFlightPublishIntents.delete(intent.intentId);
    }
  }

  /** After a CAS conflict exhausted retries: reclassify each advancing repo
   *  against the now-current main (already-applied vs freshly diverged). */
  private async pushRaceResult(
    advancing: Array<{ repoPath: string; logId: string; candidateState: string }>,
    reports: unknown[]
  ): Promise<VcsPushResultDo | null> {
    const divergences: Extract<VcsPushResultDo, { status: "diverged" }>["divergences"] = [];
    let allApplied = true;
    for (const c of advancing) {
      const current = (await this.refsStore().readMain(c.repoPath))?.stateHash ?? EMPTY_STATE_HASH;
      if (current === c.candidateState) continue;
      allApplied = false;
      const base =
        this.getMergeBase({ leftStateHash: current, rightStateHash: c.candidateState })
          .baseStateHash ?? EMPTY_STATE_HASH;
      if (base === current) continue;
      const dry = await this.computeMerge({
        oursStateHash: current,
        theirsStateHash: c.candidateState,
        labels: { ours: `${c.repoPath}:main`, theirs: `${c.repoPath}:candidate` },
      });
      const currentEventId = this.commitEventIdOf(
        this.resolveWorktreeHeadInternal(c.logId, "main"),
        `${c.repoPath}:main`
      );
      divergences.push({
        repoPath: c.repoPath,
        base,
        mainTip: current,
        upstreamCommits: this.upstreamCommitsBetween(base, current, currentEventId),
        mergeable: dry.status === "conflicted" ? "conflict" : "clean",
        ...(dry.status === "conflicted" ? { conflictPaths: dry.conflicts.map((x) => x.path) } : {}),
      });
    }
    if (divergences.length > 0) return { status: "diverged", divergences };
    if (allApplied)
      return { status: "up-to-date", repoPaths: advancing.map((c) => c.repoPath), reports };
    return null;
  }

  private isRefConflictError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /compare-and-swap conflict/i.test(message) || /REF_CONFLICT/.test(message);
  }

  // ── Write-ahead publish intents (crash self-heal, §6) ──────────────────────

  private recordPublishIntent(intent: PublishIntent): void {
    this.sql.exec(
      `INSERT INTO gad_publish_intents
         (intent_id, operation, entries_json, message, actor_json, source_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      intent.intentId,
      intent.operation,
      JSON.stringify(intent.entries),
      intent.message ?? null,
      intent.actor ? JSON.stringify(intent.actor) : null,
      intent.sourceHead ?? null,
      nowIso()
    );
  }

  private deletePublishIntent(intentId: string): void {
    this.sql.exec(`DELETE FROM gad_publish_intents WHERE intent_id = ?`, intentId);
  }

  private listPublishIntents(): PublishIntent[] {
    return (
      this.sql
        .exec(`SELECT * FROM gad_publish_intents ORDER BY created_at`)
        .toArray() as JsonRecord[]
    ).map((row) => ({
      intentId: String(row["intent_id"]),
      operation: String(row["operation"]) as "push" | "import",
      entries: JSON.parse(String(row["entries_json"])) as PublishIntentEntry[],
      message: row["message"] ? String(row["message"]) : null,
      actor: row["actor_json"] ? (JSON.parse(String(row["actor_json"])) as ParticipantRef) : null,
      sourceHead: row["source_head"] ? String(row["source_head"]) : null,
    }));
  }

  /** Record the provenance commits for an intent whose ref CAS landed, then
   *  delete the intent — the completion half of the write-ahead protocol. Idempotent-safe:
   *  ingest CAS treats the main predecessor as a claimed lineage anchor. */
  private completePublishIntent(intent: PublishIntent): void {
    this.transaction(() => {
      for (const e of intent.entries) {
        // Already recorded? (heal after a partial completion) — skip if the DO's
        // recorded main head is already at the candidate.
        const recorded = this.resolveWorktreeHeadInternal(e.logId, "main")?.stateHash ?? null;
        if (recorded === e.next) continue;
        this.ingestWorktreeStateInTxn({
          logId: e.logId,
          head: "main",
          logKind: "vcs",
          actor: intent.actor ?? SYSTEM_PARTICIPANT,
          files: e.files,
          baseStateHash: e.expectedOld ?? EMPTY_STATE_HASH,
          expectedRefStateHash: e.expectedOld ?? EMPTY_STATE_HASH,
          parentStateHashes: [e.parentStateHash ?? e.next],
          ...(e.parentEventId ? { parentEventIds: [e.parentEventId] } : {}),
          eventKind: "state.merge_applied",
          summary:
            intent.message ??
            `${intent.operation} ${e.repoPath}${intent.sourceHead ? ` from ${intent.sourceHead}` : ""}`,
          ...(e.editOps.length > 0
            ? { editOps: e.editOps, validateFirstParentChain: !e.synthetic }
            : {}),
        });
      }
      this.deletePublishIntent(intent.intentId);
    });
  }

  /**
   * Crash self-heal (§6). Refs are the authority; the DO is a follower of its
   * OWN successful writes. Reconcile pending intents and lineage against the
   * host mains:
   *  - a main matching a pending intent's `next` → complete that intent's
   *    provenance with full fidelity (its recorded editOps/parents);
   *  - a pending intent whose CAS never landed (ref no longer at `expectedOld`,
   *    and no ref-log transition to `next`) → discard it;
   *  - a main the DO's recorded lineage lags with NO covering intent → fail
   *    loudly. Refs alone cannot reconstruct the authored transition, so degraded
   *    synthetic provenance is not allowed.
   */
  private async healPublishDrift(): Promise<void> {
    const intents = this.listPublishIntents();
    const coveredMains = new Set<string>();
    for (const intent of intents) {
      let allLanded = true;
      let anyLanded = false;
      for (const e of intent.entries) {
        const current = (await this.refsStore().readMain(e.repoPath))?.stateHash ?? null;
        coveredMains.add(normalizeRepoPathArg(e.repoPath));
        if (current === e.next) anyLanded = true;
        else allLanded = false;
      }
      if (allLanded) {
        this.completePublishIntent(intent);
        continue;
      }
      if (!anyLanded && (await this.intentIsStale(intent))) {
        // Never stale-reap an intent a live op is actively driving: it is parked
        // across its (possibly human-gated) `refs.updateMains` window and its CAS
        // may still land — the appearance of staleness is exactly that window,
        // not a genuine orphan. Its repoPaths are already in `coveredMains`
        // (added above for every entry), so no-intent drift checks below do not
        // fire over it. A genuinely orphaned intent
        // (owner crashed/evicted) is absent from the set on the fresh instance's
        // startup heal and is reaped there, completing recovery (§6).
        if (!this.inFlightPublishIntents.has(intent.intentId)) {
          this.transaction(() => this.deletePublishIntent(intent.intentId));
        }
        continue;
      }
      // Mixed / indeterminate: complete the landed entries, keep the rest for a
      // later pass (ref layer is all-or-none, so this is defensive only).
      if (anyLanded) this.completePublishIntent(intent);
    }

    // Mains whose recorded lineage lags with NO covering intent cannot be healed
    // without inventing provenance. Fail closed and leave refs/DO disagreement
    // visible to the operator.
    for (const ref of await this.refsStore().listMains()) {
      const repoPath = normalizeRepoPathArg(ref.repoPath);
      if (coveredMains.has(repoPath)) continue;
      if (ref.stateHash === EMPTY_STATE_HASH) continue;
      const logId = logIdForRepoPath(repoPath);
      const recorded = this.resolveWorktreeHeadInternal(logId, "main")?.stateHash ?? null;
      if (recorded === ref.stateHash) continue;
      throw new Error(
        `vcsHealPublishDrift: protected ref for ${repoPath} is ${ref.stateHash}, ` +
          `but the DO recorded main is ${recorded ?? "<absent>"} and no publish intent covers it`
      );
    }
  }

  /** An intent's CAS never landed iff no entry is currently at `next` AND the
   *  ref log records no transition INTO `next` (consult the log, not just the
   *  current value — a later push may have moved past it). */
  private async intentIsStale(intent: PublishIntent): Promise<boolean> {
    const readLog = this.refsStore().listMainRefLog?.bind(this.refsStore());
    for (const e of intent.entries) {
      const current = (await this.refsStore().readMain(e.repoPath))?.stateHash ?? null;
      if (current === e.next) return false;
      if (readLog) {
        const log = await readLog(e.repoPath);
        if (log.some((entry) => entry.new === e.next)) return false;
      }
    }
    return true;
  }

  /** Host-triggerable startup self-heal (§6) — the same reconcile the push path
   *  runs on demand, exposed so the host can drive it at DO attach. */
  @rpc({ callers: ["do", "server"] })
  async vcsHealPublishDrift(): Promise<{ pendingIntents: number }> {
    this.ensureReady();
    await this.healPublishDrift();
    return {
      pendingIntents: (
        this.sql.exec(`SELECT COUNT(*) AS c FROM gad_publish_intents`).one() as JsonRecord
      )["c"] as number,
    };
  }

  /**
   * Explicit reconcile: merge `sourceHead` (typically `main`) into a `ctx:*`
   * `targetHead`, producing a MERGE COMMIT — never auto-done by push. Rejects
   * on uncommitted edits (a clean working state is required) and on a
   * reconcile already in progress.
   *
   *  - **clean / fast-forward**: commit the 3-way result on the ctx head
   *    (`baseStateHash: ours` + `parentStateHashes: [theirs]`) and mirror it —
   *    the host projects and emits.
   *  - **conflicted**: stage + mirror the conflict-marked provisional tree and
   *    park a pending merge (`materialized: false`); the host projects the
   *    markers, acknowledges via {@link markPendingMergeMaterialized}, and the
   *    resolution lands through vcs.edit → vcs.commit (which consumes the
   *    pending and records the merge parents).
   *
   * A `main` SOURCE resolves through the protected ref (refs bridge) and
   * requires this store's recorded main to be in lockstep — the host drains
   * the provenance follower before dispatching, so drift here is real.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsMerge(input: {
    logId: string;
    targetHead: string;
    sourceHead: string;
    actor: ParticipantRef;
  }): Promise<
    | {
        status: "up-to-date";
        stateHash: string;
        conflicts: [];
        mergeable: "clean";
        upstreamCommits: Array<{
          eventId: string;
          message: string;
          stateHash: string;
          createdAt: string | null;
        }>;
      }
    | {
        status: "merged";
        stateHash: string;
        eventId: string;
        headHash: string;
        previousStateHash: string;
        conflicts: [];
        mergeable: "clean";
        upstreamCommits: Array<{
          eventId: string;
          message: string;
          stateHash: string;
          createdAt: string | null;
        }>;
      }
    | {
        status: "conflicted";
        stateHash: string;
        conflicts: Array<{ path: string; kind: string }>;
        mergeable: "conflict";
        conflictPaths: string[];
        theirsHead: string;
        upstreamCommits: Array<{
          eventId: string;
          message: string;
          stateHash: string;
          createdAt: string | null;
        }>;
      }
  > {
    // READ-AT-ENTRY (invocation-token contract): capture the on-behalf-of token
    // synchronously before any await — the main-advancing tail presents it to
    // `refs.updateMains` for the gate's attribution.
    this.ensureReady();
    const { logId, targetHead, sourceHead } = input;
    // `main` is NOT a mergeable target: main advances only through the gated
    // fast-forward push path (`refs.updateMains`), never by merging a head into
    // it. Only `ctx:*` heads carry checkouts and accept a merge.
    if (!targetHead.startsWith("ctx:")) {
      throw new Error(
        `vcsMerge: '${targetHead}' — merge targets a ctx:* head; main advances via push, not merge`
      );
    }
    const existingPending = this.getPendingMerge({ logId, head: targetHead }).info;
    if (existingPending) {
      throw new Error(
        `merge in progress on ${targetHead}: resolve + vcs.commit, or vcs.discardEdits`
      );
    }
    // Clean working state required — a merge over uncommitted edits would fold
    // unrelated changes into the merge commit.
    if (this.workingEditRows(logId, targetHead).length > 0) {
      throw new Error(
        `uncommitted edits on ${targetHead} — vcs.commit or vcs.discardEdits before merge`
      );
    }
    // Commit-gated on the SOURCE side too: a ctx source with uncommitted edits
    // has content that is NOT part of any commit, so merging it would either
    // silently drop those edits (only committed state moves) or fold half-done
    // work into the target. `main` sources carry no working rows. Names the
    // source side + repo (the target gate above names the target side).
    if (sourceHead.startsWith("ctx:") && this.workingEditRows(logId, sourceHead).length > 0) {
      throw new Error(
        `uncommitted edits on merge source ${sourceHead} (${this.repoPathOfLog(logId) ?? logId}) — ` +
          `commit or discard them before merge`
      );
    }
    const store = this.contentStore();
    const repoPath = this.repoPathOfLog(logId);

    const oursHeadRef = this.resolveWorktreeHeadInternal(logId, targetHead);
    const oursState =
      oursHeadRef?.stateHash ?? (await this.resolveCommittedBaseState(store, logId, targetHead));

    let theirsHeadRef: { stateHash: string; commitEventId: string | null } | null;
    if (sourceHead === "main" && repoPath) {
      const refValue = (await this.refsStore().readMain(repoPath))?.stateHash ?? null;
      if (!refValue) throw new Error(`merge source head has no state: ${sourceHead}`);
      const doHead = this.resolveWorktreeHeadInternal(logId, "main");
      if (!doHead || doHead.stateHash !== refValue) {
        throw new Error(
          `main lineage for ${repoPath} is behind the protected ref: this store records ` +
            `${doHead?.stateHash ?? "<absent>"} but the ref is ${refValue} — drain/reconcile ` +
            `provenance before merging`
        );
      }
      theirsHeadRef = doHead;
    } else {
      theirsHeadRef = this.resolveWorktreeHeadInternal(logId, sourceHead);
    }
    const theirsState = theirsHeadRef?.stateHash;
    if (!theirsState) throw new Error(`merge source head has no state: ${sourceHead}`);
    const theirsEventId = this.commitEventIdOf(theirsHeadRef, `merge source head ${sourceHead}`);
    const upstreamCommits = this.upstreamCommitsBetween(oursState, theirsState, theirsEventId);

    const result = await this.computeMerge({
      oursStateHash: oursState,
      theirsStateHash: theirsState,
      labels: { ours: targetHead, theirs: sourceHead },
    });

    if (result.status === "up-to-date") {
      return {
        status: "up-to-date",
        stateHash: oursState,
        conflicts: [],
        mergeable: "clean",
        upstreamCommits,
      };
    }

    if (result.status === "clean" || result.status === "fast-forward") {
      // Clean merge → a merge COMMIT on the target head (no file resolution).
      // ours is the implicit first parent (the head advance); theirs the added
      // one. Mirrored so the handed-out state resolves in the content store.
      // A3/U3: record per-file ops (origin-annotated hunks vs OURS from the
      // 3-way alignment) so a clean merge is NOT an op-less commit — blame
      // attributes the incoming lines to the merge.
      const oursFiles = await this.stateFilesFor(store, oursState);
      const editOps = this.mergeEditOps(oursFiles, result.files);
      const ingest = this.transaction(() =>
        this.ingestWorktreeStateInTxn({
          logId,
          head: targetHead,
          logKind: "vcs",
          actor: input.actor,
          files: result.files,
          baseStateHash: oursState,
          expectedRefStateHash: oursState,
          parentStateHashes: [theirsState],
          ...(theirsEventId ? { parentEventIds: [theirsEventId] } : {}),
          eventKind: "state.merge_applied",
          summary: `Merge ${sourceHead} into ${targetHead}`,
          ...(editOps.length > 0 ? { editOps, validateFirstParentChain: true } : {}),
        })
      );
      await this.mirrorStateToContentStore(
        store,
        result.files.map((file) => ({
          path: file.path,
          contentHash: file.contentHash,
          mode: file.mode,
        })),
        ingest.stateHash
      );
      return {
        status: "merged",
        stateHash: ingest.stateHash,
        eventId: ingest.eventId,
        headHash: ingest.headHash,
        previousStateHash: oursState,
        conflicts: [],
        mergeable: "clean",
        upstreamCommits,
      };
    }

    // Conflicted: stage + mirror the provisional (conflict-marked) tree and
    // park the pending merge. The host projects the markers into the context
    // FS and acknowledges with markPendingMergeMaterialized; the agent
    // resolves via vcs.edit (working ops over the provisional) and seals it
    // with vcs.commit, which consumes the pending and records the parents.
    const provisionalStateHash = await this.stageAndMirror(
      store,
      result.files,
      `Provisional merge of ${sourceHead} into ${targetHead}`
    );
    this.setPendingMerge({
      logId,
      head: targetHead,
      info: {
        oursStateHash: oursState,
        theirsStateHash: theirsState,
        theirsEventId,
        baseStateHash: result.baseStateHash,
        theirsHead: sourceHead,
        conflicts: result.conflicts,
        provisionalStateHash,
        materialized: false,
      },
    });
    return {
      status: "conflicted",
      stateHash: provisionalStateHash,
      conflicts: result.conflicts,
      mergeable: "conflict",
      conflictPaths: result.conflicts.map((c) => c.path),
      theirsHead: sourceHead,
      upstreamCommits,
    };
  }

  /**
   * Abort a pending (conflicted) merge: clear the parked pending and hand the
   * host the pre-merge state to restore on disk. NOT a head advance — a
   * pending merge never moved the head (the provisional tree is a disk-only
   * projection).
   */
  @rpc({ callers: ["do", "server"] })
  vcsAbortMerge(input: { logId: string; head: string }): {
    aborted: boolean;
    restoreStateHash: string | null;
  } {
    this.ensureReady();
    const pending = this.getPendingMerge(input).info;
    if (!pending) return { aborted: false, restoreStateHash: null };
    // Abort atomically: drop any uncommitted resolution edits made during
    // conflict resolution AND clear the parked pending in one txn. Otherwise
    // leftover working rows replay over the committed base after the pending is
    // gone, resurrecting the abandoned half-resolution (diverging from the
    // restoreStateHash the host just projected). Mirrors discardWorkingEdits.
    this.transaction(() => {
      this.deleteUncommittedWorkingEdits(input.logId, input.head);
      this.deleteStateValue(`merge:${input.logId}:${input.head}`);
    });
    return { aborted: true, restoreStateHash: pending.oursStateHash };
  }

  // -------------------------------------------------------------------------
  // Context semantics (P5d) — a CONTEXT's VCS state lives HERE: the durable
  // pinned base view (vcs_context_bases), the composed working view (edited
  // repos at their working content, the rest at the pinned base), per-repo
  // status, rebase, and teardown. The host keeps only the DISK side: sparse
  // materialization tracking and the projector that writes context folders.
  // -------------------------------------------------------------------------

  /** Composed-view cache — SELF-INVALIDATING: keyed by a signature of the
   *  inputs that determine the view (pinned base + each touched repo's
   *  committed ctx-head state + its uncommitted-edit fingerprint), so a stale
   *  entry can never be returned. */
  private readonly contextComposedViewCache = new Map<string, { key: string; view: string }>();
  /** Content-addressed composition cache ((repoPath=state)* → view). */
  private readonly composedRepoStatesCache = new Map<string, string>();
  /** Decomposed pinned-view cache (a base view is immutable). */
  private readonly pinnedViewDecomposeCache = new Map<
    string,
    Array<{ repoPath: string; stateHash: string }>
  >();

  /** Every repo's protected `main`, via the refs bridge — the authority. */
  private async collectRepoMainStatesFromRefs(): Promise<
    Array<{ repoPath: string; stateHash: string }>
  > {
    const refs = await this.refsStore().listMains();
    return refs
      .filter((record) => record.stateHash !== EMPTY_STATE_HASH)
      .map((record) => ({ repoPath: record.repoPath, stateHash: record.stateHash }))
      .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /** Every repo log carrying `head`, as `{ repoPath, stateHash }`. */
  private collectRepoCtxHeadStates(head: string): Array<{ repoPath: string; stateHash: string }> {
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const row of this.listWorktreeHeads({ logIdPrefix: "vcs:repo:", head })) {
      const repoPath = this.repoPathOfLog(row.logId);
      if (!repoPath) continue;
      out.push({ repoPath, stateHash: row.stateHash });
    }
    return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /**
   * Compose repo subtree states into one workspace-rooted view, staged
   * locally AND mirrored into the content store (the mirroring invariant for
   * views composed here). Listings resolve content-store-first, so fresh ref
   * mains the provenance follower has not recorded yet compose correctly.
   * Cached by the content-addressed composition key (never stale).
   */
  private async composeRepoStatesMirrored(
    store: HostContentStore,
    repos: Array<{ repoPath: string; stateHash: string }>
  ): Promise<string> {
    if (repos.length === 0) {
      await this.mirrorStateToContentStore(store, [], EMPTY_STATE_HASH);
      return EMPTY_STATE_HASH;
    }
    const key = repos
      .map((repo) => `${normalizeRepoPathArg(repo.repoPath)}=${repo.stateHash}`)
      .sort()
      .join("\n");
    const cached = this.composedRepoStatesCache.get(key);
    if (cached) return cached;
    const files: Array<{ path: string; contentHash: string; mode: number }> = [];
    for (const repo of repos) {
      const prefix = normalizeRepoPathArg(repo.repoPath);
      for (const file of await this.stateFilesFor(store, repo.stateHash)) {
        files.push({
          path: `${prefix}/${file.path}`,
          contentHash: file.contentHash,
          mode: file.mode,
        });
      }
    }
    const stateHash = await this.stageAndMirror(store, files, "composed workspace view");
    if (this.composedRepoStatesCache.size >= 128) {
      const oldest = this.composedRepoStatesCache.keys().next().value;
      if (oldest !== undefined) this.composedRepoStatesCache.delete(oldest);
    }
    this.composedRepoStatesCache.set(key, stateHash);
    return stateHash;
  }

  /** The live workspace view: the composed union of every repo's protected
   *  `main` (via the refs bridge). */
  private async workspaceViewFromRefs(store: HostContentStore): Promise<string> {
    return this.composeRepoStatesMirrored(store, await this.collectRepoMainStatesFromRefs());
  }

  /**
   * Decompose a pinned composed workspace view into its per-repo subtree
   * states (repo membership from the view's own file paths — the userland
   * repo taxonomy), cached by view hash (a base view is immutable).
   */
  private async decomposePinnedViewLocal(
    store: HostContentStore,
    baseView: string
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    const cached = this.pinnedViewDecomposeCache.get(baseView);
    if (cached) return cached;
    const files = await this.stateFilesFor(store, baseView);
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const repoPath of discoverRepoPaths(files.map((file) => file.path))) {
      const slice = await this.pinnedSliceState(store, baseView, repoPath);
      if (slice) out.push({ repoPath, stateHash: slice });
    }
    if (this.pinnedViewDecomposeCache.size >= 64) {
      const oldest = this.pinnedViewDecomposeCache.keys().next().value;
      if (oldest !== undefined) this.pinnedViewDecomposeCache.delete(oldest);
    }
    this.pinnedViewDecomposeCache.set(baseView, out);
    return out;
  }

  /**
   * Cheap per-repo fingerprint of a context's working content — the inputs
   * the composed view depends on: each touched repo's committed ctx-head
   * state (null if none) and its highest uncommitted `edit_seq`. Covers repos
   * with a ctx head AND repos with uncommitted-only edits (no ctx head yet).
   */
  private contextWorkingFingerprint(
    contextId: string
  ): Array<{ repoPath: string; committedState: string | null; editSeq: number }> {
    const head = `ctx:${contextId}`;
    const repoPaths = new Set<string>();
    for (const c of this.collectRepoCtxHeadStates(head)) {
      repoPaths.add(normalizeRepoPathArg(c.repoPath));
    }
    for (const row of this.listContextWorkingRepos({ head })) {
      const repoPath = this.repoPathOfLog(row.logId);
      if (repoPath) repoPaths.add(normalizeRepoPathArg(repoPath));
    }
    const out: Array<{ repoPath: string; committedState: string | null; editSeq: number }> = [];
    for (const repoPath of repoPaths) {
      const logId = logIdForRepoPath(repoPath);
      const committedState = this.resolveCommittedHeadState(logId, head);
      const editSeq = this.workingEditRows(logId, head).reduce(
        (max, row) => Math.max(max, Number(row["edit_seq"] ?? 0)),
        0
      );
      out.push({ repoPath, committedState, editSeq });
    }
    return out;
  }

  /** Stable signature of the inputs that determine a context's composed view. */
  private contextViewSignature(
    baseView: string | null,
    fingerprint: Array<{ repoPath: string; committedState: string | null; editSeq: number }>
  ): string {
    const fp = fingerprint
      .map((f) => `${normalizeRepoPathArg(f.repoPath)}=${f.committedState ?? "-"}@${f.editSeq}`)
      .sort()
      .join(",");
    return `${baseView ?? "-"}|${fp}`;
  }

  /** Compose a context view: overlaid repos at their given states, every
   *  other repo at its slice of the pinned base (live mains when unpinned). */
  private async computeContextView(
    store: HostContentStore,
    baseView: string | null,
    overlay: Map<string, string>
  ): Promise<string> {
    const baseRepos = baseView
      ? await this.decomposePinnedViewLocal(store, baseView)
      : await this.collectRepoMainStatesFromRefs();

    if (overlay.size === 0) {
      return (
        baseView ??
        (baseRepos.length === 0
          ? EMPTY_STATE_HASH
          : await this.composeRepoStatesMirrored(store, baseRepos))
      );
    }

    const composedRepos = baseRepos.map(({ repoPath, stateHash }) => ({
      repoPath,
      stateHash: overlay.get(normalizeRepoPathArg(repoPath)) ?? stateHash,
    }));
    // Brand-new repos created in this context (overlaid, absent from the base).
    const baseSet = new Set(baseRepos.map((r) => normalizeRepoPathArg(r.repoPath)));
    for (const [repoPath, stateHash] of overlay) {
      if (!baseSet.has(repoPath)) composedRepos.push({ repoPath, stateHash });
    }
    return composedRepos.length === 0
      ? EMPTY_STATE_HASH
      : await this.composeRepoStatesMirrored(store, composedRepos);
  }

  /**
   * Pin (or re-pin) a context's base view. With `baseView` omitted this is an
   * idempotent CREATE — pins the current workspace view (composed union of
   * protected repo mains) only if not already pinned. With `baseView` given
   * it FORCE-moves the pin (rebase / post-push re-pin).
   */
  @rpc({ callers: ["do", "server"] })
  async vcsPinContext(input: { contextId: string; baseView?: string | null }): Promise<{
    baseView: string;
  }> {
    this.ensureReady();
    let baseView = input.baseView ?? null;
    if (!baseView) {
      const existing = this.getContextBase({ contextId: input.contextId })?.stateHash ?? null;
      if (existing) return { baseView: existing };
      baseView = await this.workspaceViewFromRefs(this.contentStore());
    }
    this.setContextBase({ contextId: input.contextId, stateHash: baseView });
    this.contextComposedViewCache.delete(input.contextId);
    return { baseView };
  }

  /** Record (or refresh) a child context's fork breadcrumb — UX lineage only,
   *  never consulted by merge. Idempotent upsert on `context_id`. */
  private recordContextForkProvenance(
    contextId: string,
    parentContextId: string,
    forkPoint: string
  ): void {
    this.sql.exec(
      `INSERT INTO vcs_context_provenance (context_id, parent_context_id, fork_point_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(context_id) DO UPDATE SET
         parent_context_id = excluded.parent_context_id,
         fork_point_json = excluded.fork_point_json,
         created_at = excluded.created_at`,
      contextId,
      parentContextId,
      JSON.stringify({ baseStateHash: forkPoint }),
      nowIso()
    );
  }

  private contextForkDescendsFrom(contextId: string, ancestorContextId: string): boolean {
    const seen = new Set<string>();
    let cursor = contextId;
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const row = this.sql
        .exec(
          `SELECT parent_context_id AS parent FROM vcs_context_provenance WHERE context_id = ?`,
          cursor
        )
        .toArray()[0] as JsonRecord | undefined;
      const parent = asString(row?.["parent"]);
      if (!parent) return false;
      if (parent === ancestorContextId) return true;
      cursor = parent;
    }
    return false;
  }

  private assertContextReadAllowed(method: string, targetContextId: string): void {
    const callerKind = this.caller?.callerKind ?? null;
    if (callerKind === null || callerKind === "server" || callerKind === "shell") return;
    const ownContextId = this.callerContextId ?? null;
    if (!ownContextId) {
      throw new Error(
        `${method}: caller ${callerKind} has no context registration; ` +
          `inspection of ${targetContextId} is denied`
      );
    }
    if (ownContextId === targetContextId) return;
    if (this.contextForkDescendsFrom(targetContextId, ownContextId)) return;
    throw new Error(
      `${method}: context ${targetContextId} is not the caller's context or fork descendant ` +
        `of ${ownContextId}; inspection denied`
    );
  }

  /**
   * LINEAGE-TRUE context fork — the real locus of fork (host `forkContext` is a
   * thin wrapper). For every repo the source context touches:
   *  1. Inherit the source's PINNED base view (or, if the source is unpinned,
   *     pin the current workspace view — mirrors {@link vcsPinContext} create).
   *     Unedited repos resolve against the same base.
   *  2. SHARE the parent's committed state node — the child `ctx:<target>` head
   *     is set to the SAME committed state hash + SAME commit event id as the
   *     parent's committed ctx head. Because states are content-addressed and
   *     that node already lives in `gad_state_transitions`, parent and child
   *     literally share the ancestor, so {@link getMergeBase} connects for free
   *     when either side later commits (its transition's first parent is the
   *     shared state). A source ctx head with only working edits (null commit
   *     event id) has no committed state to share → the child gets the base pin
   *     + copied working rows for that repo, no ctx-head row.
   *  3. COPY the source's uncommitted WORKING edit rows to the child head, so
   *     the child's uncommitted stays uncommitted (contrast: the old snapshot
   *     pin baked them into the child's clean base).
   *  4. Record the fork breadcrumb.
   * Idempotent (crash-retry / cloneContext targetKey re-run): every write is an
   * upsert and the working-row copy delete-then-inserts, so a re-run converges.
   * NB: this does NOT call forkLog on a ctx head — those `log_heads` fork
   * columns are not read by getMergeBase; the state-DAG share above is the link.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsForkContext(input: { sourceContextId: string; targetContextId: string }): Promise<void> {
    this.ensureReady();
    const { sourceContextId, targetContextId } = input;
    const sourceHead = `ctx:${sourceContextId}`;
    const targetHead = `ctx:${targetContextId}`;
    const store = this.contentStore();
    // Resolve the base to inherit BEFORE the sync txn (workspaceViewFromRefs is
    // async + mirrors). Inherit the source pin, else pin the live workspace view.
    const baseStateHash =
      this.getContextBase({ contextId: sourceContextId })?.stateHash ??
      (await this.workspaceViewFromRefs(store));
    // The union of repos the source touches (committed ctx heads ∪ working-only).
    const repoPaths = this.contextWorkingFingerprint(sourceContextId).map((f) => f.repoPath);
    this.transaction(() => {
      this.setContextBase({ contextId: targetContextId, stateHash: baseStateHash });
      for (const repoPath of repoPaths) {
        const logId = logIdForRepoPath(repoPath);
        // 2. Share the parent's committed state node (only when it has a commit
        //    event identity — an un-committed working-only repo has no node).
        const srcHeadRef = this.resolveWorktreeHeadInternal(logId, sourceHead);
        if (srcHeadRef && srcHeadRef.commitEventId) {
          this.setWorktreeHead(logId, targetHead, srcHeadRef.stateHash, srcHeadRef.commitEventId);
        }
        // 3. Copy the WORKING (uncommitted) edit rows — idempotent via
        //    delete-then-insert so a retried fork never duplicates rows.
        this.deleteUncommittedWorkingEdits(logId, targetHead);
        this.sql.exec(
          `INSERT INTO gad_worktree_edit_ops (
             event_id, log_id, head, committed_event_id, committed_seq,
             edit_seq, output_state_hash, ordinal, kind, path,
             old_content_hash, new_content_hash, hunks_json, mode,
             actor_id, actor_json, invocation_id, turn_id, created_at, synthetic,
             binary, picked_from_json
           )
           SELECT event_id, log_id, ?, NULL, NULL,
             edit_seq, NULL, ordinal, kind, path,
             old_content_hash, new_content_hash, hunks_json, mode,
             actor_id, actor_json, invocation_id, turn_id, created_at, synthetic,
             binary, picked_from_json
           FROM gad_worktree_edit_ops
           WHERE log_id = ? AND head = ? AND committed_event_id IS NULL`,
          targetHead,
          logId,
          sourceHead
        );
      }
      // 4. Fork breadcrumb (UX lineage only).
      this.recordContextForkProvenance(targetContextId, sourceContextId, baseStateHash);
    });
    this.contextComposedViewCache.delete(targetContextId);
  }

  /**
   * The context's composed view: each touched repo at its WORKING content
   * (committed ctx head + uncommitted edits; a pending merge's provisional
   * while reconciling), every other repo at its slice of the pinned base.
   * Self-invalidating cache (see {@link contextViewSignature}).
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async vcsResolveContextView(input: { contextId: string }): Promise<{ stateHash: string }> {
    this.ensureReady();
    this.assertContextReadAllowed("vcsResolveContextView", input.contextId);
    const store = this.contentStore();
    const baseView = this.getContextBase({ contextId: input.contextId })?.stateHash ?? null;
    const fingerprint = this.contextWorkingFingerprint(input.contextId);
    const key = this.contextViewSignature(baseView, fingerprint);
    const cached = this.contextComposedViewCache.get(input.contextId);
    if (cached && cached.key === key) return { stateHash: cached.view };
    // Fast path: a pure-read context (nothing touched) IS its pinned base.
    if (baseView && fingerprint.length === 0) {
      this.contextComposedViewCache.set(input.contextId, { key, view: baseView });
      return { stateHash: baseView };
    }
    const head = `ctx:${input.contextId}`;
    const overlay = new Map<string, string>();
    for (const fp of fingerprint) {
      const working = (
        await this.resolveWorkingState({ logId: logIdForRepoPath(fp.repoPath), head })
      ).stateHash;
      if (working) overlay.set(normalizeRepoPathArg(fp.repoPath), working);
    }
    const view = await this.computeContextView(store, baseView, overlay);
    this.contextComposedViewCache.set(input.contextId, { key, view });
    return { stateHash: view };
  }

  /**
   * The composed context view with ONE repo forced to a specific COMMITTED
   * state (or dropped back to its base slice when null), every other edited
   * repo at its committed ctx head. Computes the workspace-rooted
   * "before"/"after" of a per-repo COMMIT so the build trigger can EV-diff a
   * context commit against a real composed workspace state.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsComposedViewWithRepoAt(input: {
    contextId: string;
    repoPath: string;
    repoStateHash: string | null;
  }): Promise<{ stateHash: string }> {
    this.ensureReady();
    const store = this.contentStore();
    const baseView = this.getContextBase({ contextId: input.contextId })?.stateHash ?? null;
    const norm = normalizeRepoPathArg(input.repoPath);
    const overlay = new Map<string, string>();
    for (const c of this.collectRepoCtxHeadStates(`ctx:${input.contextId}`)) {
      if (normalizeRepoPathArg(c.repoPath) !== norm) {
        overlay.set(normalizeRepoPathArg(c.repoPath), c.stateHash);
      }
    }
    if (input.repoStateHash) overlay.set(norm, input.repoStateHash);
    return { stateHash: await this.computeContextView(store, baseView, overlay) };
  }

  /** Every repo visible in a context's view (pinned-base repos ∪ ctx-head
   *  repos ∪ working-only repos), base order first. */
  private async contextRepoList(store: HostContentStore, contextId: string): Promise<string[]> {
    const baseView = this.getContextBase({ contextId })?.stateHash ?? null;
    const base = baseView
      ? await this.decomposePinnedViewLocal(store, baseView)
      : await this.collectRepoMainStatesFromRefs();
    const ctx = this.collectRepoCtxHeadStates(`ctx:${contextId}`);
    const working = this.listContextWorkingRepos({ head: `ctx:${contextId}` })
      .map((row) => this.repoPathOfLog(row.logId))
      .filter((repoPath): repoPath is string => repoPath !== null);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...base, ...ctx]) {
      const n = normalizeRepoPathArg(r.repoPath);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(r.repoPath);
      }
    }
    for (const repoPath of working) {
      const n = normalizeRepoPathArg(repoPath);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(repoPath);
      }
    }
    return out;
  }

  /**
   * The states a context's repos should be on disk at — the host
   * materializer's demand feed. `repos` is a list of repo paths or SECTION
   * prefixes (each expands to every context repo under it); `"all"` is the
   * whole view. Repos that do not exist in the context are omitted.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsContextRepoStates(input: {
    contextId: string;
    repos: string[] | "all";
  }): Promise<Array<{ repoPath: string; stateHash: string }>> {
    this.ensureReady();
    const store = this.contentStore();
    const all = await this.contextRepoList(store, input.contextId);
    let list: string[];
    if (input.repos === "all") {
      list = all;
    } else {
      const set = new Set<string>();
      for (const req of input.repos) {
        const reqNorm = normalizeRepoPathArg(req).replace(/\/+$/u, "");
        for (const repoPath of all) {
          const rn = normalizeRepoPathArg(repoPath);
          if (rn === reqNorm || rn.startsWith(`${reqNorm}/`)) set.add(repoPath);
        }
      }
      list = [...set];
    }
    const head = `ctx:${input.contextId}`;
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const repoPath of list) {
      const state = (await this.resolveWorkingState({ logId: logIdForRepoPath(repoPath), head }))
        .stateHash;
      if (state) out.push({ repoPath, stateHash: state });
    }
    return out;
  }

  /**
   * Per-repo summary of where a context differs from main or needs attention:
   * `forked` (committed ctx head), `uncommitted` (working edits), `ahead`
   * (ctx commits not contained in main), `behind` (main advanced past the
   * pinned base), `deleted` (repo retired via deleteRepo). Only interesting
   * repos are returned.
   */
  @rpc({ callers: ["panel", "shell", "do", "worker", "server"] })
  async vcsContextStatus(input: { contextId: string }): Promise<
    Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
    }>
  > {
    this.ensureReady();
    this.assertContextReadAllowed("vcsContextStatus", input.contextId);
    const store = this.contentStore();
    const baseView = this.getContextBase({ contextId: input.contextId })?.stateHash ?? null;
    const baseRepos = baseView
      ? await this.decomposePinnedViewLocal(store, baseView)
      : await this.collectRepoMainStatesFromRefs();
    const baseByRepo = new Map(
      baseRepos.map((r) => [normalizeRepoPathArg(r.repoPath), r.stateHash])
    );
    const ctxByRepo = new Map(
      this.collectRepoCtxHeadStates(`ctx:${input.contextId}`).map((c) => [
        normalizeRepoPathArg(c.repoPath),
        { repoPath: c.repoPath, stateHash: c.stateHash },
      ])
    );
    const editSeqByRepo = new Map(
      this.contextWorkingFingerprint(input.contextId).map((f) => [
        normalizeRepoPathArg(f.repoPath),
        f.editSeq,
      ])
    );
    const repoKeys = new Set([...baseByRepo.keys(), ...ctxByRepo.keys(), ...editSeqByRepo.keys()]);
    const out: Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
    }> = [];
    for (const key of repoKeys) {
      const ctx = ctxByRepo.get(key) ?? null;
      const baseState = baseByRepo.get(key) ?? null;
      const repoPath = ctx?.repoPath ?? key;
      const mainState =
        (await this.refsStore().readMain(normalizeRepoPathArg(repoPath)))?.stateHash ?? null;
      const forked = ctx !== null;
      const uncommitted = (editSeqByRepo.get(key) ?? 0) > 0;
      const behind = baseState !== null && mainState !== null && mainState !== baseState;
      // The context still references this repo, but its `main` is gone AND it
      // was archived — retired via deleteRepo (not a brand-new unpushed repo,
      // which also lacks a main but has no archive head).
      const deleted = mainState === null && this.repoLogWasArchived(logIdForRepoPath(repoPath));
      let ahead = false;
      if (forked) {
        if (mainState === null) {
          ahead = !deleted && ctx!.stateHash !== EMPTY_STATE_HASH;
        } else if (ctx!.stateHash !== mainState) {
          const mergeBase =
            this.getMergeBase({ leftStateHash: mainState, rightStateHash: ctx!.stateHash })
              .baseStateHash ?? EMPTY_STATE_HASH;
          // `ahead` means the context has commits not contained in main. When
          // the ctx head is an ancestor of main, it is only behind.
          ahead = mergeBase !== ctx!.stateHash;
        }
      }
      if (forked || uncommitted || behind || deleted) {
        out.push({ repoPath, forked, uncommitted, ahead, behind, deleted });
      }
    }
    return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /**
   * Rebase: pull the latest protected `main` into each of the context's
   * edited repos (a {@link vcsMerge} onto the ctx head), then RE-PIN the base
   * to the current workspace view so unedited repos also advance. Rejects on
   * uncommitted edits. If any repo conflicted, the pin stays where it was
   * (the context keeps reporting `behind` until the conflicts resolve). The
   * per-repo merge outcomes are returned so the HOST can project each repo's
   * new state to disk and emit events — the follower half.
   */
  @rpc({ callers: ["do", "server"] })
  async vcsRebaseContext(input: { contextId: string; actor: ParticipantRef }): Promise<{
    repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
    baseView: string;
    outcomes: Array<
      { repoPath: string } & (
        | { status: "up-to-date"; stateHash: string }
        | {
            status: "merged";
            stateHash: string;
            eventId: string;
            headHash: string;
            previousStateHash: string;
          }
        | {
            status: "conflicted";
            stateHash: string;
            conflicts: Array<{ path: string; kind: string }>;
            conflictPaths: string[];
            theirsHead: string;
          }
      )
    >;
  }> {
    this.ensureReady();
    const store = this.contentStore();
    const head = `ctx:${input.contextId}`;
    // Reject up-front on uncommitted edits — a rebase merges over committed
    // states only (each per-repo merge would reject anyway; fail clearly first).
    const dirty = this.contextWorkingFingerprint(input.contextId).filter((f) => f.editSeq > 0);
    if (dirty.length > 0) {
      throw new Error(
        `rebaseContext: uncommitted edits in ${dirty
          .map((f) => f.repoPath)
          .join(", ")} — vcs.commit or vcs.discardEdits first`
      );
    }
    const repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }> = [];
    const outcomes: Array<{ repoPath: string } & Record<string, unknown>> = [];
    for (const { repoPath } of this.collectRepoCtxHeadStates(head)) {
      const norm = normalizeRepoPathArg(repoPath);
      const main = (await this.refsStore().readMain(norm))?.stateHash ?? null;
      if (!main) {
        repos.push({ repoPath, status: "up-to-date" });
        continue;
      }
      const outcome = await this.vcsMerge({
        logId: logIdForRepoPath(norm),
        targetHead: head,
        sourceHead: "main",
        actor: input.actor,
      });
      repos.push({ repoPath, status: outcome.status });
      outcomes.push({ repoPath, ...outcome });
    }
    // Only re-pin the base when EVERY edited repo merged cleanly — re-pinning
    // over unresolved conflicts would falsely mark the context caught-up.
    const conflicted = repos.some((r) => r.status === "conflicted");
    const baseView = conflicted
      ? (this.getContextBase({ contextId: input.contextId })?.stateHash ??
        (await this.workspaceViewFromRefs(store)))
      : (
          await this.vcsPinContext({
            contextId: input.contextId,
            baseView: await this.workspaceViewFromRefs(store),
          })
        ).baseView;
    return {
      repos,
      baseView,
      outcomes: outcomes as never,
    };
  }

  /**
   * Teardown — the ONE place a context's durable VCS state dies. Per repo in
   * (committed ctx heads ∪ uncommitted-edit repos): drop its uncommitted
   * edits + pending merge AND fully retire its `ctx:{contextId}` head; then
   * drop the pin row and the composed-view cache. Returns the touched repo
   * paths so the host can clear its disk-side tracking. Idempotent.
   */
  @rpc({ callers: ["do", "server"] })
  vcsDropContext(input: { contextId: string }): { repoPaths: string[] } {
    this.ensureReady();
    const head = `ctx:${input.contextId}`;
    const repoPaths = new Set<string>();
    for (const { repoPath } of this.collectRepoCtxHeadStates(head)) repoPaths.add(repoPath);
    for (const row of this.listContextWorkingRepos({ head })) {
      const repoPath = this.repoPathOfLog(row.logId);
      if (repoPath) repoPaths.add(repoPath);
    }
    for (const repoPath of repoPaths) {
      const logId = logIdForRepoPath(repoPath);
      try {
        this.discardWorkingEdits({ logId, head }); // uncommitted edits + pending
      } catch {
        // best-effort per repo — teardown must not wedge on one bad log
      }
      try {
        this.deleteLogHead({ logId, head }); // ctx ref + log head + own events
      } catch {
        // best-effort per repo
      }
    }
    try {
      this.deleteContextBase({ contextId: input.contextId });
    } catch {
      // pin row may not exist
    }
    this.contextComposedViewCache.delete(input.contextId);
    return { repoPaths: [...repoPaths] };
  }

  /**
   * Content-store access for the merge/edit engines — the host `blobstore.*`
   * RPC. Protected SEAM: host-side unit tests run this DO in-process with no
   * gateway and override it with a local blob store; production always goes
   * through the RPC bridge (`do` callers are policy-admitted on blobstore).
   */
  protected contentStore(): HostContentStore {
    return {
      listTree: (ref, opts) =>
        this.rpc.call("main", "blobstore.listTree", [
          ref,
          { limit: MERGE_LIST_TREE_LIMIT, ...(opts?.prefix ? { prefix: opts.prefix } : {}) },
        ]),
      getTree: (ref) => this.rpc.call("main", "blobstore.getTree", [ref]),
      getBase64: (digest) => this.rpc.call("main", "blobstore.getBase64", [digest]),
      putBase64: (bytesBase64) => this.rpc.call("main", "blobstore.putBase64", [bytesBase64]),
      putTree: (entries, opts) => this.rpc.call("main", "blobstore.putTree", [entries, opts]),
    };
  }

  /**
   * Protected-ref access for edit/commit composition — the host `refs.*` RPC
   * (the single `main`-head authority). Protected SEAM like
   * {@link contentStore}: host unit tests override it with the test's
   * RefService.
   */
  protected refsStore(): HostRefsStore {
    return {
      readMain: (repoPath) => this.rpc.call("main", "refs.readMain", [repoPath]),
      listMains: () => this.rpc.call("main", "refs.listMains", []),
      updateMains: (input) => this.rpc.call("main", "refs.updateMains", [input]),
      listMainRefLog: (repoPath, sinceId) =>
        this.rpc.call("main", "refs.listMainRefLog", [
          { repoPath, ...(sinceId !== undefined ? { sinceId } : {}) },
        ]),
    };
  }

  /**
   * Build-service access for the push gate — the host `build.validate` RPC
   * (pure, cached over a candidate view hash; §2.2). Protected SEAM like
   * {@link contentStore}: host unit tests override it with a stub validator.
   */
  protected buildStore(): HostBuildStore {
    return {
      validate: (input) => this.rpc.call("main", "build.validate", [input]),
    };
  }

  /**
   * Disk-scan primitive access — the host `worktree.scan` RPC (narrow-host
   * boundary refactor P1). Reads a (repoPath, head) working tree into the CAS
   * and returns its content-addressed `{ stateHash, files }`, DO-free and
   * semantics-free. Protected SEAM like {@link contentStore}: host unit tests
   * override it with a local scanner. No consumer yet — the scan-adopt path
   * that drives it lands in a later phase.
   */
  protected worktreeStore(): HostWorktreeStore {
    return {
      scan: (repoPath, head) => this.rpc.call("main", "worktree.scan", [repoPath, head]),
      project: (repoPath, head, stateHash) =>
        this.rpc.call("main", "worktree.project", [repoPath, head, stateHash]),
      dependentRepos: (repoPath) => this.rpc.call("main", "worktree.dependentRepos", [repoPath]),
    };
  }

  /**
   * State file listing for the merge/edit engines: the local manifest index
   * when this store recorded the state, else the content store's mirrored
   * tree — inputs can be server-minted states (pinned-base slices, fresh ref
   * mains the async provenance follower has not recorded yet), which by the
   * mirroring invariant always resolve in the content store.
   */
  private async stateFilesFor(
    store: HostContentStore,
    stateHash: string
  ): Promise<StateFileEntry[]> {
    if (stateHash === EMPTY_STATE_HASH) return [];
    if (this.hasWorktreeState(stateHash)) {
      return this.filesForState(stateHash).map((file) => ({
        path: String(file["path"]),
        contentHash: String(file["content_hash"]),
        mode: asNumber(file["mode"]),
      }));
    }
    const entries = await store.listTree(stateHash);
    if (entries === null) {
      throw new Error(
        `unknown worktree state ${stateHash} (not recorded here, not mirrored in the content store)`
      );
    }
    if (entries.length >= MERGE_LIST_TREE_LIMIT) {
      throw new Error(`tree listing overflow for ${stateHash}`);
    }
    return entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({
        path: entry.path,
        contentHash: String(entry.contentHash),
        mode: entry.mode ?? 33188,
      }));
  }

  /**
   * Three-way merge of `theirs` into `ours` — the userland VCS merge
   * semantics (@workspace/vcs-engine), computed HERE so the host never owns
   * what a merge IS. Pure over store values: discovers the base from this
   * store's transition DAG, reads/writes blob bytes through the content
   * store, and returns the merged (or conflict-marked provisional) file set —
   * no refs move and nothing is appended; callers commit the result.
   */
  /** The 3-way merge engine over this store's transition DAG + the content
   *  store's blob bytes — shared by {@link computeMerge} (base auto-discovered)
   *  and {@link vcsPick} (cherry-pick against an explicit base via compute3). */
  private mergeEngineFor(store: HostContentStore): MergeEngine {
    return new MergeEngine({
      listStateFiles: (stateHash) => this.stateFilesFor(store, stateHash),
      getMergeBase: async (leftStateHash, rightStateHash) =>
        this.getMergeBase({ leftStateHash, rightStateHash }).baseStateHash,
      readBlob: async (digest) => {
        const bytesBase64 = await store.getBase64(digest);
        return bytesBase64 === null ? null : base64ToBytes(bytesBase64);
      },
      writeBlob: async (bytes) => {
        const result = await store.putBase64(bytesToBase64(bytes));
        return { digest: result.digest, size: result.size };
      },
    });
  }

  @rpc({ callers: ["do", "server"] })
  async computeMerge(input: {
    oursStateHash: string;
    theirsStateHash: string;
    labels: { ours: string; theirs: string };
  }): Promise<MergeComputation> {
    this.ensureReady();
    const engine = this.mergeEngineFor(this.contentStore());
    return engine.compute(input.oursStateHash, input.theirsStateHash, input.labels);
  }

  // -------------------------------------------------------------------------
  // Memory (WS4) — FTS index over messages/claims/files + provenance recall
  // -------------------------------------------------------------------------

  /** "fts" under workerd SQLite; "plain" (LIKE search) where FTS5 is absent
   *  (the sql.js test harness). Same write/read logic either way. */
  private memoryIndexMode: "fts" | "plain" | null = null;

  private ensureMemoryIndex(): "fts" | "plain" {
    if (this.memoryIndexMode) return this.memoryIndexMode;
    try {
      this.sql.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS gad_memory_fts USING fts5(
           text, kind UNINDEXED, log_id UNINDEXED, head UNINDEXED,
           event_id UNINDEXED, path UNINDEXED, content_hash UNINDEXED,
           anchor_json UNINDEXED
         )`
      );
      this.memoryIndexMode = "fts";
    } catch {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS gad_memory_fts (
           text TEXT NOT NULL, kind TEXT NOT NULL, log_id TEXT, head TEXT,
           event_id TEXT, path TEXT, content_hash TEXT, anchor_json TEXT
         )`
      );
      this.memoryIndexMode = "plain";
    }
    return this.memoryIndexMode;
  }

  private indexMemoryRow(row: {
    text: string;
    kind: "message" | "claim" | "file" | "commit";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void {
    this.ensureMemoryIndex();
    const text = row.text.slice(0, 64_000);
    if (!text.trim()) return;
    // One row per identity: claims collapse to a single row per claim (revisions
    // replace, keyed by claimId, so a re-record/revise never leaves stale text);
    // other event rows index once per (event, log, head) — idempotent replay;
    // files keep only their latest content.
    const claimId =
      row.kind === "claim" && row.anchor && typeof row.anchor["claimId"] === "string"
        ? (row.anchor["claimId"] as string)
        : null;
    if (claimId) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts WHERE kind = 'claim' AND anchor_json = ?`,
        JSON.stringify({ claimId })
      );
    } else if (row.eventId) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts
          WHERE event_id = ?
            AND COALESCE(log_id, '') = COALESCE(?, '')
            AND COALESCE(head, '') = COALESCE(?, '')`,
        row.eventId,
        row.logId ?? null,
        row.head ?? null
      );
    } else if (row.path) {
      this.sql.exec(`DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`, row.path);
    }
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      text,
      row.kind,
      row.logId ?? null,
      row.head ?? null,
      row.eventId ?? null,
      row.path ?? null,
      row.contentHash ?? null,
      row.anchor ? JSON.stringify(row.anchor) : null
    );
  }

  /** Batch file-text indexing (the server pushes changed file text — bytes
   *  live in the filesystem CAS, not in this DO). */
  @rpc({ callers: ["do", "server"] })
  indexMemoryFiles(input: {
    files: Array<{ path: string; contentHash: string; text: string }>;
    removedPaths?: string[] | null;
  }): { indexed: number } {
    this.ensureReady();
    this.ensureMemoryIndex();
    for (const removed of input.removedPaths ?? []) {
      this.sql.exec(`DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`, removed);
    }
    for (const file of input.files) {
      this.indexMemoryRow({
        text: file.text,
        kind: "file",
        path: file.path,
        contentHash: file.contentHash,
      });
    }
    return { indexed: input.files.length };
  }

  /** Index marker (P1 cache pointer): which state the file index reflects. */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getMemoryIndexMarker(input: { key: string }): { value: string | null } {
    this.ensureReady();
    return { value: this.getStateValue(`memidx:${input.key}`) };
  }

  @rpc({ callers: ["do", "server"] })
  setMemoryIndexMarker(input: { key: string; value: string }): void {
    this.ensureReady();
    this.setStateValue(`memidx:${input.key}`, input.value);
  }

  /**
   * Search the memory index. Results carry provenance: the matching row's
   * anchor plus (for event-anchored rows) the event's actor and timestamp,
   * and (for file rows) the current content hash.
   */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  recallMemory(input: {
    query: string;
    kinds?: string[] | null;
    limit?: number | null;
    /** Workspace-relative repo path prefixes to scope file results to. A row is
     *  kept when its `path` is null (non-file entries: messages/claims/commits)
     *  or falls under one of these prefixes. Applied IN the query so `limit`
     *  bounds the scoped result set, not an unfiltered page scoping then
     *  decimates. */
    pathPrefixes?: string[] | null;
    /** Steering keywords OR-appended to the query's FTS match to widen recall
     *  (§7.1/§6, C6). A bonus signal, never load-bearing: they broaden what
     *  matches, never filter it out, and never outrank the base query. */
    recallKeywords?: string[] | null;
  }): {
    results: Array<{
      kind: string;
      snippet: string;
      score: number | null;
      logId: string | null;
      head: string | null;
      eventId: string | null;
      path: string | null;
      contentHash: string | null;
      anchor: Record<string, unknown> | null;
      actor: unknown;
      appendedAt: string | null;
    }>;
  } {
    this.ensureReady();
    const mode = this.ensureMemoryIndex();
    const limit = Math.min(input.limit ?? 10, 50);
    // Over-fetch so published/fork copies (the same logical item indexed under
    // several (log,head) pairs) can be collapsed BEFORE the page is sliced —
    // otherwise duplicates eat slots and the caller's page under-fills (§8.1/C6).
    const fetchLimit = Math.min(limit * 3, 150);
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    const pathPrefixes =
      input.pathPrefixes && input.pathPrefixes.length > 0 ? input.pathPrefixes : null;
    // (path IS NULL OR path = pre OR path LIKE 'pre/%') for each prefix, OR-ed.
    const pathFilter = pathPrefixes
      ? ` AND (path IS NULL OR ${pathPrefixes
          .map(() => `(path = ? OR path LIKE ? ESCAPE '\\')`)
          .join(" OR ")})`
      : "";
    const pathBindings = pathPrefixes
      ? pathPrefixes.flatMap((pre) => [pre, `${pre.replace(/[%_\\]/gu, "\\$&")}/%`])
      : [];
    let rows: JsonRecord[];
    if (mode === "fts") {
      const baseMatch = sanitizeFtsQuery(input.query);
      // Keyword steering only WIDENS: OR the base query with the keyword terms so
      // recall matches either — never AND-ed (would narrow), never load-bearing.
      const keywordMatch = recallTokens(input.recallKeywords)
        .map((term) => `"${term}"`)
        .join(" OR ");
      const match = keywordMatch
        ? baseMatch
          ? `(${baseMatch}) OR ${keywordMatch}`
          : keywordMatch
        : baseMatch;
      if (!match) return { results: [] };
      const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      rows = this.sql
        .exec(
          `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  bm25(gad_memory_fts) AS score
             FROM gad_memory_fts
            WHERE gad_memory_fts MATCH ?${kindFilter}${pathFilter}
            ORDER BY score LIMIT ?`,
          match,
          ...(kinds ?? []),
          ...pathBindings,
          fetchLimit
        )
        .toArray() as JsonRecord[];
    } else {
      const queryTerms = recallTokens([input.query]);
      const keywordTerms = recallTokens(input.recallKeywords);
      if (queryTerms.length === 0 && keywordTerms.length === 0) return { results: [] };
      const likeBindings: string[] = [];
      const likeOf = (term: string): string => {
        likeBindings.push(`%${term.replace(/[%_\\]/gu, "\\$&")}%`);
        return `text LIKE ? ESCAPE '\\'`;
      };
      // Base query terms AND together; steering keywords OR onto the whole base
      // (widen, never narrow) — mirrors the fts branch's `(base) OR keywords`.
      const baseClause = queryTerms.length ? `(${queryTerms.map(likeOf).join(" AND ")})` : "";
      const keywordClause = keywordTerms.length ? keywordTerms.map(likeOf).join(" OR ") : "";
      const matchClause =
        baseClause && keywordClause
          ? `(${baseClause} OR ${keywordClause})`
          : baseClause || keywordClause;
      const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      rows = this.sql
        .exec(
          `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  NULL AS score
             FROM gad_memory_fts
            WHERE ${matchClause}${kindFilter}${pathFilter}
            LIMIT ?`,
          ...likeBindings,
          ...(kinds ?? []),
          ...pathBindings,
          fetchLimit
        )
        .toArray() as JsonRecord[];
    }

    // §8.1: recall must not surface a retracted claim. Its FTS row is dropped on
    // retract, but guard the query leg too (a stale row can't leak a dead claim).
    const claimRowIds = rows
      .filter((row) => String(row["kind"]) === "claim")
      .map((row) => asString(parseRecord(asString(row["anchor_json"]))["claimId"]));
    const retractedClaims = this.retractedClaimIds(claimRowIds);
    if (retractedClaims.size > 0) {
      rows = rows.filter((row) => {
        if (String(row["kind"]) !== "claim") return true;
        const cid = asString(parseRecord(asString(row["anchor_json"]))["claimId"]);
        return !cid || !retractedClaims.has(cid);
      });
    }

    const pageRows = this.dedupRecallRows(rows, limit);
    const results = pageRows.map((row) => {
      const eventId = asString(row["event_id"]);
      const logId = asString(row["log_id"]);
      const head = asString(row["head"]);
      let actor: unknown = null;
      let appendedAt: string | null = null;
      if (eventId && logId && head) {
        const event = this.getLogEvent({ logId, head, envelopeId: eventId });
        if (event) {
          actor = event.actor;
          appendedAt = event.appendedAt;
        }
      }
      const text = String(row["text"]);
      return {
        kind: String(row["kind"]),
        snippet: snippetAround(text, input.query),
        score: row["score"] == null ? null : asNumber(row["score"]),
        logId,
        head,
        eventId,
        path: asString(row["path"]),
        contentHash: asString(row["content_hash"]),
        anchor: parseJson(asString(row["anchor_json"])) as Record<string, unknown> | null,
        actor,
        appendedAt,
      };
    });
    return { results };
  }

  /**
   * Collapse published/fork copies of the same logical memory item before the
   * page is sliced (§8.1/C6). A `message.completed` published to a channel, and
   * every projection copied into a fork head by `copyProjectionKey`, produce
   * distinct FTS rows that share (kind, event_id) but differ in (log_id, head).
   * Dedup by (kind, event_id) — or (kind, text) for entries with no event id
   * (files) — keeping the trajectory-log copy over a channel republish, then
   * slice to the caller's limit. Rows arrive best-first (fts bm25 order), so the
   * first occurrence holds the ranking slot; a later trajectory copy only swaps
   * its metadata in.
   */
  private dedupRecallRows(rows: JsonRecord[], limit: number): JsonRecord[] {
    const trajectoryLogs = this.trajectoryLogIds(rows);
    const isTrajectory = (row: JsonRecord): boolean => {
      const logId = asString(row["log_id"]);
      return logId != null && trajectoryLogs.has(logId);
    };
    const slotByKey = new Map<string, number>();
    const kept: JsonRecord[] = [];
    for (const row of rows) {
      const kind = String(row["kind"]);
      const eventId = asString(row["event_id"]);
      const key = `${kind}\u0001${eventId ?? `t:${String(row["text"])}`}`;
      const slot = slotByKey.get(key);
      if (slot === undefined) {
        slotByKey.set(key, kept.length);
        kept.push(row);
      } else if (!isTrajectory(kept[slot]!) && isTrajectory(row)) {
        kept[slot] = row;
      }
    }
    return kept.slice(0, limit);
  }

  /** The subset of the rows' `log_id`s that belong to trajectory logs — used to
   *  prefer a trajectory copy over a channel republish during recall dedup. One
   *  batched lookup over `log_heads`; a `log_id`'s kind is stable across heads. */
  private trajectoryLogIds(rows: JsonRecord[]): Set<string> {
    const logIds = [
      ...new Set(rows.map((row) => asString(row["log_id"])).filter((v): v is string => v != null)),
    ];
    if (logIds.length === 0) return new Set();
    const placeholders = logIds.map(() => "?").join(",");
    const found = this.sql
      .exec(
        `SELECT DISTINCT log_id FROM log_heads WHERE log_kind = 'trajectory' AND log_id IN (${placeholders})`,
        ...logIds
      )
      .toArray() as JsonRecord[];
    return new Set(found.map((row) => String(row["log_id"])));
  }

  // -------------------------------------------------------------------------
  // GC (WS3.P5) — mark-and-sweep over values; two-phase blob deletion
  // -------------------------------------------------------------------------

  /**
   * Mark phase: compute the live value set (ancestor closure of every
   * ref/pending-merge root over the transition DAG, those states' manifest
   * trees, the file versions kept manifests or blame rows reference) and:
   *  - delete orphaned worktree states / manifest nodes / file versions
   *    (DO-local rows, transactional — safe immediately),
   *  - record unreferenced blob digests as sweep candidates.
   * The log itself is never collected (it IS the authority).
   */
  @rpc({ callers: ["server"] })
  runGadGcMark(input: GadGcRootsInput = {}): {
    keptStates: number;
    sweptStates: number;
    sweptManifests: number;
    sweptFileVersions: number;
    blobCandidates: number;
    liveBlobDigests: string[];
  } {
    this.ensureReady();
    return this.transaction(() => {
      // 1. Root states: every structured worktree head, host-provided
      // protected refs, every generic ref target with a stateHash, and pending
      // merges.
      const roots = new Set<string>([EMPTY_STATE_HASH]);
      for (const stateHash of input.rootStateHashes ?? []) {
        if (typeof stateHash === "string" && stateHash.length > 0) roots.add(stateHash);
      }
      const protectedDigests = new Set<string>();
      for (const digest of input.protectedBlobDigests ?? []) {
        if (typeof digest === "string" && digest.length > 0) protectedDigests.add(digest);
      }
      for (const digest of input.protectedTreeDigests ?? []) {
        if (typeof digest === "string" && digest.length > 0) protectedDigests.add(digest);
      }
      for (const head of this.listWorktreeHeads({})) {
        roots.add(head.stateHash);
      }
      for (const ref of this.listRefs({})) {
        const stateHash = asString((ref.target as Record<string, unknown>)["stateHash"]);
        if (stateHash) roots.add(stateHash);
      }
      const mergeRows = this.sql
        .exec(`SELECT value FROM state WHERE key LIKE 'merge:%'`)
        .toArray() as JsonRecord[];
      for (const row of mergeRows) {
        try {
          const info = JSON.parse(String(row["value"])) as Record<string, unknown>;
          for (const key of [
            "oursStateHash",
            "theirsStateHash",
            "baseStateHash",
            "provisionalStateHash",
          ]) {
            const value = asString(info[key]);
            if (value) roots.add(value);
          }
        } catch {
          // unparseable pending merge — ignore
        }
      }
      // P3 (§6): pending publish intents reference candidate `next` states not
      // yet reachable from mains (the CAS may not have landed / provenance not
      // yet recorded). Root them so a crash between intent and heal cannot have
      // its candidate swept.
      const intentRows = this.sql
        .exec(`SELECT entries_json FROM gad_publish_intents`)
        .toArray() as JsonRecord[];
      for (const row of intentRows) {
        try {
          const parsed = JSON.parse(String(row["entries_json"])) as Array<{
            next?: string;
            parentStateHash?: string | null;
          }>;
          for (const entry of parsed) {
            if (entry.next) roots.add(entry.next);
            if (entry.parentStateHash) roots.add(entry.parentStateHash);
          }
        } catch {
          // unparseable intent — ignore
        }
      }
      // Freshly created worktree states are temporary roots so a GC run cannot
      // race a multi-step flow that has created a state but not yet referenced
      // it. Once the grace window expires, unreferenced staged states are
      // garbage; pending merges root their provisional states explicitly.
      const graceCutoff = new Date(Date.now() - GC_CREATION_GRACE_MS).toISOString();
      const protectedRows = this.sql
        .exec(
          `SELECT state_hash, created_at FROM gad_worktree_states
            WHERE created_at > ?`,
          graceCutoff
        )
        .toArray() as JsonRecord[];
      for (const row of protectedRows) {
        roots.add(String(row["state_hash"]));
      }

      // 2. Ancestor closure over the transition DAG (history retention).
      const keptStates = new Set<string>(roots);
      const queue = [...roots];
      while (queue.length > 0) {
        const current = queue.pop()!;
        const parents = this.sql
          .exec(
            `SELECT t.input_state_hash AS parent FROM gad_state_transitions t
              WHERE t.output_state_hash = ?
             UNION
             SELECT p.parent_state_hash AS parent FROM gad_transition_parents p
              JOIN gad_state_transitions t2 ON t2.event_id = p.event_id
              WHERE t2.output_state_hash = ?`,
            current,
            current
          )
          .toArray() as JsonRecord[];
        for (const row of parents) {
          const parent = asString(row["parent"]);
          if (parent && !keptStates.has(parent)) {
            keptStates.add(parent);
            queue.push(parent);
          }
        }
      }

      // 3. Manifest closure of kept states.
      const keptManifests = new Set<string>();
      const walkManifest = (manifestHash: string): void => {
        if (keptManifests.has(manifestHash)) return;
        keptManifests.add(manifestHash);
        for (const entry of this.manifestEntries(manifestHash)) {
          if (entry["entry_kind"] === "dir") {
            const child = asString(entry["child_manifest_hash"]);
            if (child) walkManifest(child);
          }
        }
      };
      for (const stateHash of keptStates) {
        const row = this.sql
          .exec(
            `SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`,
            stateHash
          )
          .toArray()[0] as JsonRecord | undefined;
        const rootHash = asString(row?.["manifest_root_hash"]);
        if (rootHash) walkManifest(rootHash);
      }

      // 4. Kept file versions: referenced by kept manifests.
      const keptFileVersions = new Set<number>();
      for (const manifestHash of keptManifests) {
        for (const entry of this.manifestEntries(manifestHash)) {
          const id = entry["file_version_id"];
          if (typeof id === "number") keptFileVersions.add(id);
        }
      }

      // 5. Sweep orphaned rows.
      let sweptStates = 0;
      for (const row of this.sql
        .exec(`SELECT state_hash FROM gad_worktree_states`)
        .toArray() as JsonRecord[]) {
        const stateHash = String(row["state_hash"]);
        if (keptStates.has(stateHash)) continue;
        this.sql.exec(`DELETE FROM gad_worktree_states WHERE state_hash = ?`, stateHash);
        sweptStates += 1;
      }
      let sweptManifests = 0;
      for (const row of this.sql
        .exec(`SELECT manifest_hash FROM gad_manifest_nodes`)
        .toArray() as JsonRecord[]) {
        const manifestHash = String(row["manifest_hash"]);
        if (keptManifests.has(manifestHash)) continue;
        this.sql.exec(`DELETE FROM gad_manifest_entries WHERE manifest_hash = ?`, manifestHash);
        this.sql.exec(`DELETE FROM gad_manifest_nodes WHERE manifest_hash = ?`, manifestHash);
        sweptManifests += 1;
      }
      let sweptFileVersions = 0;
      for (const row of this.sql
        .exec(`SELECT id FROM gad_file_versions`)
        .toArray() as JsonRecord[]) {
        const id = asNumber(row["id"]);
        if (keptFileVersions.has(id)) continue;
        this.sql.exec(`DELETE FROM gad_file_versions WHERE id = ?`, id);
        sweptFileVersions += 1;
      }

      // 6. Blob candidates: not referenced by surviving file versions, log
      // payload spills, nor uncommitted working-edit ops (the same blob
      // reachability collectGarbageBlobRefs uses); drop candidates that
      // regained a reference.
      //
      // Uncommitted working-edit ops (committed_event_id IS NULL) reference
      // content that has already reached the host CAS via the content bridge
      // but has no gad_file_versions row until commit. Both new_content_hash
      // (the edit's result) and old_content_hash (needed by revert/
      // inverse-patch paths) must be treated as live, or an uncommitted edit
      // older than the sweep min-age is swept and the eventual commit dangles.
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_gc_candidates (digest, marked_at)
         SELECT b.hash, ? FROM gad_blobs b
          WHERE NOT EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = b.hash)
            AND NOT EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = b.hash)
            AND NOT EXISTS (
              SELECT 1 FROM gad_worktree_edit_ops eo
               WHERE eo.committed_event_id IS NULL
                 AND (eo.new_content_hash = b.hash OR eo.old_content_hash = b.hash))`,
        nowIso()
      );
      this.sql.exec(
        `DELETE FROM gad_gc_candidates
          WHERE EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = gad_gc_candidates.digest)
             OR EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = gad_gc_candidates.digest)
             OR EXISTS (
               SELECT 1 FROM gad_worktree_edit_ops eo
                WHERE eo.committed_event_id IS NULL
                  AND (eo.new_content_hash = gad_gc_candidates.digest
                    OR eo.old_content_hash = gad_gc_candidates.digest))`
      );
      for (const digest of protectedDigests) {
        this.sql.exec(`DELETE FROM gad_gc_candidates WHERE digest = ?`, digest);
      }
      const liveBlobDigests = new Set<string>(protectedDigests);
      for (const row of this.sql
        .exec(
          `SELECT content_hash AS digest FROM gad_file_versions
           UNION
           SELECT digest AS digest FROM log_blob_refs
           UNION
           SELECT new_content_hash AS digest FROM gad_worktree_edit_ops
            WHERE committed_event_id IS NULL AND new_content_hash IS NOT NULL
           UNION
           SELECT old_content_hash AS digest FROM gad_worktree_edit_ops
            WHERE committed_event_id IS NULL AND old_content_hash IS NOT NULL`
        )
        .toArray() as JsonRecord[]) {
        const digest = asString(row["digest"]);
        if (digest) liveBlobDigests.add(digest);
      }
      const candidates = asNumber(
        (this.sql.exec(`SELECT COUNT(*) AS c FROM gad_gc_candidates`).one() as JsonRecord)["c"]
      );
      return {
        keptStates: keptStates.size,
        sweptStates,
        sweptManifests,
        sweptFileVersions,
        blobCandidates: candidates,
        liveBlobDigests: [...liveBlobDigests].sort(),
      };
    });
  }

  /**
   * Sweep phase: candidates older than `minAgeMs` that are STILL
   * unreferenced lose their metadata row; the returned digests are for the
   * caller to delete from the filesystem CAS (second phase of the two-phase
   * deletion).
   */
  @rpc({ callers: ["server"] })
  runGadGcSweep(input: { minAgeMs?: number | null } & GadGcRootsInput = {}): {
    digests: string[];
  } {
    this.ensureReady();
    const minAge = input.minAgeMs ?? 60_000;
    const cutoff = new Date(Date.now() - minAge).toISOString();
    // Creation-time grace: a blob created within the grace window may belong
    // to an in-flight multi-step flow that has not referenced it yet.
    const graceCutoff = new Date(Date.now() - GC_CREATION_GRACE_MS).toISOString();
    const protectedDigests = new Set<string>();
    for (const digest of input.protectedBlobDigests ?? []) {
      if (typeof digest === "string" && digest.length > 0) protectedDigests.add(digest);
    }
    for (const digest of input.protectedTreeDigests ?? []) {
      if (typeof digest === "string" && digest.length > 0) protectedDigests.add(digest);
    }
    return this.transaction(() => {
      const rows = this.sql
        .exec(
          `SELECT digest FROM gad_gc_candidates
            WHERE marked_at <= ?
              AND NOT EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = gad_gc_candidates.digest)
              AND NOT EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = gad_gc_candidates.digest)
              AND NOT EXISTS (
                SELECT 1 FROM gad_worktree_edit_ops eo
                 WHERE eo.committed_event_id IS NULL
                   AND (eo.new_content_hash = gad_gc_candidates.digest
                     OR eo.old_content_hash = gad_gc_candidates.digest))
              AND NOT EXISTS (
                SELECT 1 FROM gad_blobs b
                 WHERE b.hash = gad_gc_candidates.digest AND b.created_at > ?)`,
          cutoff,
          graceCutoff
        )
        .toArray() as JsonRecord[];
      const digests = rows
        .map((row) => String(row["digest"]))
        .filter((digest) => !protectedDigests.has(digest));
      for (const digest of digests) {
        this.sql.exec(`DELETE FROM gad_blobs WHERE hash = ?`, digest);
        this.sql.exec(`DELETE FROM gad_gc_candidates WHERE digest = ?`, digest);
      }
      return { digests };
    });
  }

  /**
   * §4.2/C6 soft-state prune: the hourly server-driven pass (wired next to GC by
   * the host scheduler) ages out behavioral touches and disposable render
   * artifacts so the soft layer stays a bounded relevance signal rather than an
   * unbounded log. Everything pruned here is re-derivable (a pruned touch is
   * background hum; the cache re-computes on a miss; the render log is
   * instrumentation), so the floors are generous. Accepts an empty object — the
   * host calls `gad().call('pruneProvenanceSoftState', {})`. Returns per-category
   * delete counts.
   */
  @rpc({ callers: ["do", "server"] })
  pruneProvenanceSoftState(_input: Record<string, unknown> = {}): {
    touches: number;
    cache: number;
    renderLog: number;
  } {
    this.ensureReady();
    const now = Date.now();
    const touchFloor = new Date(now - TOUCH_PRUNE_AGE_MS).toISOString();
    const cacheFloor = new Date(now - PROV_CACHE_PRUNE_AGE_MS).toISOString();
    const renderFloor = new Date(now - PROV_RENDER_LOG_PRUNE_AGE_MS).toISOString();
    return this.transaction(() => {
      // Single-hit touches past the floor never accumulated repeat signal.
      const touches = asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS n FROM gad_touches WHERE hits = 1 AND updated_at < ?`,
            touchFloor
          )
          .one()["n"]
      );
      this.sql.exec(`DELETE FROM gad_touches WHERE hits = 1 AND updated_at < ?`, touchFloor);

      const cache = asNumber(
        this.sql
          .exec(`SELECT COUNT(*) AS n FROM gad_provenance_cache WHERE created_at < ?`, cacheFloor)
          .one()["n"]
      );
      this.sql.exec(`DELETE FROM gad_provenance_cache WHERE created_at < ?`, cacheFloor);

      const renderLog = asNumber(
        this.sql
          .exec(`SELECT COUNT(*) AS n FROM gad_prov_render_log WHERE created_at < ?`, renderFloor)
          .one()["n"]
      );
      this.sql.exec(`DELETE FROM gad_prov_render_log WHERE created_at < ?`, renderFloor);

      return { touches, cache, renderLog };
    });
  }

  // -------------------------------------------------------------------------
  // Projection replay (cache amnesia recovery — P3)
  // -------------------------------------------------------------------------

  async replayTrajectoryProjections(): Promise<{ replayed: number }> {
    this.ensureReady();
    return this.transaction(() => {
      this.clearProjections();
      // §8.1: claims are re-seeded from the durable ledger, not just from the
      // trajectory events. Within an era the trajectory replay below re-applies
      // the same rows idempotently (aligned identities); across a schema era —
      // when the trajectory events no longer exist — this is the ONLY source
      // that restores the ledger-only claims + relations + FTS.
      this.rebuildClaimsFromLedger();
      let replayed = 0;
      const prefixCache = new Map<string, ProjectionKey | null>();
      const temporaryKeys: ProjectionKey[] = [];
      const heads = this.sql
        .exec(`SELECT * FROM log_heads ORDER BY created_at ASC, log_id ASC, head ASC`)
        .toArray() as JsonRecord[];

      const materializePrefix = (
        logId: string,
        head: string,
        throughSeq: number
      ): ProjectionKey | null => {
        if (throughSeq <= 0) return null;
        const cacheKey = `${logId}\u0000${head}\u0000${throughSeq}`;
        if (prefixCache.has(cacheKey)) return prefixCache.get(cacheKey) ?? null;
        const headRow = this.logHeadRow(logId, head);
        if (!headRow) throw new Error(`projection replay source missing: ${logId}:${head}`);
        const logKind = String(headRow["log_kind"]);
        const key: ProjectionKey = {
          logId,
          head: `__projection_prefix:${sha256HexSyncText(cacheKey).slice(0, 32)}`,
        };
        temporaryKeys.push(key);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          // Cap the parent at min(forkSeq, throughSeq): when the requested
          // prefix ends BELOW this node's own fork point (a descendant forked
          // inside the inherited region), seeding the full parent-through-fork
          // prefix would over-project the parent events in (throughSeq, forkSeq].
          const parentPrefix = materializePrefix(
            parentLogId,
            parentHead,
            Math.min(forkSeq, throughSeq)
          );
          if (parentPrefix) this.copyProjectionKey(parentPrefix, key);
        }
        // Own events live above forkSeq; when throughSeq < forkSeq this range
        // is empty (the requested prefix is entirely within the inherited part).
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({ logId, head, afterSeq, throughSeq })) {
          this.applyProjections(logKind, { ...envelope, logId: key.logId, head: key.head });
          replayed += 1;
        }
        prefixCache.set(cacheKey, key);
        return key;
      };

      for (const headRow of heads) {
        const logId = String(headRow["log_id"]);
        const head = String(headRow["head"]);
        const logKind = String(headRow["log_kind"]);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          const parentPrefix = materializePrefix(parentLogId, parentHead, forkSeq);
          if (parentPrefix) this.copyProjectionKey(parentPrefix, { logId, head });
        }
        const pointer = this.headPointer(logId, head, headRow);
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({
          logId,
          head,
          afterSeq,
          throughSeq: pointer.seq,
        })) {
          this.applyProjections(logKind, envelope);
          replayed += 1;
        }
      }
      for (const key of temporaryKeys) this.deleteProjectionKey(key);
      return { replayed };
    });
  }

  private readOwnLogRange(input: {
    logId: string;
    head: string;
    afterSeq: number;
    throughSeq: number;
  }): LogEnvelope[] {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [input.logId, input.head, input.afterSeq];
    if (Number.isFinite(input.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(input.throughSeq);
    }
    const rows = this.sql
      .exec(`SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC`, ...bindings)
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapLogEnvelope(row));
  }

  private copyProjectionKey(from: ProjectionKey, to: ProjectionKey): void {
    this.copyProjectionRows(
      "trajectory_turns",
      "turn_id, opened_at, closed_at, summary, ordinal",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_messages",
      "message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_message_blocks",
      "block_id, message_id, block_index, block_type, invocation_id",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_invocations",
      "invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome, terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_invocation_outputs",
      "invocation_id, seq, chunk_ref_json, created_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_approvals",
      "approval_id, invocation_id, status, requested_by_json, resolved_by_json, requested_event_id, resolved_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_usage_rollups",
      "turn_id, input_tokens, output_tokens, total_tokens, cost_usd",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_checkpoints",
      "anchor_event_hash, materialized_blob_json, materializer_version, created_at",
      from,
      to
    );
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       SELECT text, kind, ?, ?, event_id, path, content_hash, anchor_json
         FROM gad_memory_fts
        WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head
    );
    const worktreeHead = this.resolveWorktreeHeadInternal(from.logId, from.head);
    if (worktreeHead) {
      this.setWorktreeHead(to.logId, to.head, worktreeHead.stateHash, worktreeHead.commitEventId);
    }
  }

  private copyProjectionRows(
    table: string,
    columns: string,
    from: ProjectionKey,
    to: ProjectionKey
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ${table} (log_id, head, ${columns})
       SELECT ?, ?, ${columns} FROM ${table} WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head
    );
  }

  private deleteProjectionKey(key: ProjectionKey): void {
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "trajectory_checkpoints",
    ]) {
      this.sql.exec(`DELETE FROM ${table} WHERE log_id = ? AND head = ?`, key.logId, key.head);
    }
    this.sql.exec(`DELETE FROM gad_memory_fts WHERE log_id = ? AND head = ?`, key.logId, key.head);
    this.deleteWorktreeHeadInternal(key.logId, key.head);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  rebuildTrajectoryProjections(): Promise<{ replayed: number }> {
    return this.replayTrajectoryProjections();
  }

  private clearProjections(): void {
    // Memory rows are projections too (P3): event/claim rows refold from the
    // log; file rows re-index from the worktree on the next state advance.
    this.ensureMemoryIndex();
    this.sql.exec(`DELETE FROM gad_memory_fts`);
    this.sql.exec(`DELETE FROM state WHERE key LIKE 'memidx:%'`);
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "channel_roster",
      "gad_state_transitions",
      "gad_transition_parents",
      "gad_claims",
      // Rebuilt from the durable ledger during replay (via projectKnowledge,
      // which resolves content through the surviving gad_knowledge_ledger).
      "gad_claim_relations",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    // Worktree heads are derived by the state projector: reset them so
    // replay re-derives each head's chain from the empty state. Values
    // (worktree states / manifests / file versions / blobs) are content-
    // addressed and never cleared.
    this.sql.exec(`DELETE FROM gad_worktree_heads`);
    this.ensureEmptyState();
  }

  // -------------------------------------------------------------------------
  // Legacy adapter surface — thin over the unified core (deleted in Stage B)
  // -------------------------------------------------------------------------

  private trajectoryEventView(
    envelope: LogEnvelope,
    override?: { trajectoryId: string; branchId: string }
  ): TrajectoryEvent {
    const causality = agenticCausality(envelope.causality);
    const turnId = envelope.causality?.turnId;
    return {
      eventId: String(envelope.envelopeId),
      trajectoryId: override?.trajectoryId ?? envelope.logId,
      branchId: override?.branchId ?? envelope.head,
      seq: envelope.seq,
      prevEventHash: envelope.prevHash,
      eventHash: envelope.hash,
      kind: envelope.payloadKind,
      actor: envelope.actor,
      ...(turnId ? { turnId } : {}),
      ...(causality ? { causality } : {}),
      payload: envelope.payload,
      createdAt: envelope.appendedAt,
    } as unknown as TrajectoryEvent;
  }

  private channelEnvelopeView(envelope: LogEnvelope, channelId?: string): ChannelEnvelope {
    const annotations = envelope.annotations ?? {};
    const {
      metadata: _viewMetadata,
      attachments: _viewAttachments,
      ...policyAnnotations
    } = annotations;
    return {
      envelopeId: envelope.envelopeId,
      channelId: brandId<ChannelId>(channelId ?? envelope.logId),
      seq: envelope.seq,
      from: envelope.actor,
      ...(envelope.to !== undefined ? { to: envelope.to } : {}),
      payload: envelope.payload,
      ...(envelope.payloadKind !== "opaque" ? { payloadKind: envelope.payloadKind } : {}),
      ...(annotations["metadata"] !== undefined
        ? { metadata: annotations["metadata"] as Record<string, unknown> }
        : {}),
      ...(annotations["attachments"] !== undefined
        ? { attachments: annotations["attachments"] as unknown[] }
        : {}),
      ...(Object.keys(policyAnnotations).length > 0 ? { annotations: policyAnnotations } : {}),
      publishedAt: envelope.appendedAt,
    };
  }

  @rpc({ callers: ["do", "server"] })
  async appendTrajectoryBatch(
    input: AppendTrajectoryBatchInput
  ): Promise<AppendTrajectoryBatchResult> {
    this.ensureReady();
    if (!input.trajectoryId) throw new Error("appendTrajectoryBatch requires trajectoryId");
    if (!input.branchId) throw new Error("appendTrajectoryBatch requires branchId");
    if (input.events.length === 0)
      throw new Error("appendTrajectoryBatch requires at least one event");

    const events: LogAppendEventInput[] = input.events.map((item) => {
      const event = item.event as AgenticEvent & {
        turnId?: string;
        causality?: Record<string, unknown>;
      };
      const causality: Record<string, unknown> = {
        ...(event.causality ?? {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
      return {
        envelopeId: item.eventId ?? null,
        actor: event.actor as ParticipantRef,
        payloadKind: event.kind,
        payload: event.payload,
        ...(Object.keys(causality).length > 0 ? { causality: causality as LogEventCausality } : {}),
        appendedAt: event.createdAt,
        ...(item.publish
          ? {
              publish: {
                channels: item.publish.channelIds.map((channelId) => ({
                  channelId,
                  audience: item.publish?.audience,
                })),
              },
            }
          : {}),
      };
    });

    const result = await this.appendLogEvent({
      logId: input.trajectoryId,
      head: input.branchId,
      logKind: "trajectory",
      owner: input.owner,
      ...("expectedHeadEventHash" in input
        ? { expectedHeadHash: input.expectedHeadEventHash ?? null }
        : {}),
      events,
    });

    return {
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
      headEventId: this.headPointer(input.trajectoryId, input.branchId).envelopeId ?? null,
      headEventHash: result.headHash,
      headStateHash: this.latestStateHash(input.trajectoryId, input.branchId),
      events: result.envelopes.map((envelope) =>
        this.trajectoryEventView(envelope, {
          trajectoryId: input.trajectoryId,
          branchId: input.branchId,
        })
      ),
      published: result.published.map((publication) => ({
        eventId: publication.originEnvelopeId,
        channelId: publication.channelId,
        envelopeId: publication.envelopeId,
      })),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listTrajectoryEvents(input: {
    trajectoryId?: string | null;
    branchId: string;
    cursor?: number | null;
    limit?: number | null;
  }): TrajectoryEvent[] {
    this.ensureReady();
    const logId = input.trajectoryId ?? this.findLogIdForHead(input.branchId);
    if (!logId) return [];
    const limit = input.limit ?? 500;
    const envelopes = this.readLog({
      logId,
      head: input.branchId,
      afterSeq: input.cursor ?? 0,
      limit: limit <= 0 ? 0 : limit,
    });
    return envelopes.map((envelope) =>
      this.trajectoryEventView(envelope, {
        trajectoryId: logId,
        branchId: input.branchId,
      })
    );
  }

  private findLogIdForHead(head: string): string | null {
    const row = this.sql
      .exec(`SELECT log_id FROM log_heads WHERE head = ? LIMIT 1`, head)
      .toArray()[0] as JsonRecord | undefined;
    return row ? String(row["log_id"]) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getTrajectoryEvent(input: { eventId: string }): TrajectoryEvent | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`, input.eventId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.trajectoryEventView(this.mapLogEnvelope(row)) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getTrajectoryBranchHead(input: { trajectoryId: string; branchId: string }): JsonRecord | null {
    this.ensureReady();
    const row = this.logHeadRow(input.trajectoryId, input.branchId);
    if (!row) return null;
    const pointer = this.headPointer(input.trajectoryId, input.branchId, row);
    return {
      trajectory_id: input.trajectoryId,
      branch_id: input.branchId,
      owner_json: (row["owner_json"] ?? null) as JsonValue,
      head_event_id: pointer.envelopeId,
      head_event_hash: pointer.seq > 0 ? pointer.hash : null,
      head_state_hash: this.latestStateHash(input.trajectoryId, input.branchId),
      parent_branch_id: (row["parent_head"] ?? null) as JsonValue,
      fork_event_id: null,
      created_at: row["created_at"] as JsonValue,
      updated_at: row["created_at"] as JsonValue,
    };
  }

  @rpc({ callers: ["do", "server"] })
  async forkTrajectoryBranch(
    input: ForkTrajectoryBranchInput
  ): Promise<ForkTrajectoryBranchResult> {
    this.ensureReady();
    let atSeq: number | null = input.throughSeq ?? null;
    if (input.throughEventHash) {
      const row = this.sql
        .exec(`SELECT seq FROM log_events WHERE hash = ? LIMIT 1`, input.throughEventHash)
        .toArray()[0] as JsonRecord | undefined;
      if (!row) throw new Error("forkTrajectoryBranch throughEventHash not found");
      atSeq = asNumber(row["seq"]);
    }
    if (input.throughPublishedChannelId && input.throughPublishedChannelSeq != null) {
      const row = this.sql
        .exec(
          `SELECT MAX(o.seq) AS seq
           FROM log_events ch
           JOIN log_events o
             ON o.log_id = ch.origin_log_id
            AND o.head = ch.origin_head
            AND o.envelope_id = ch.origin_envelope_id
           WHERE ch.log_id = ?
             AND ch.seq <= ?
             AND ch.origin_log_id = ?
             AND ch.origin_head = ?`,
          input.throughPublishedChannelId,
          input.throughPublishedChannelSeq,
          input.fromTrajectoryId,
          input.fromBranchId
        )
        .toArray()[0] as JsonRecord | undefined;
      atSeq = row?.["seq"] == null ? 0 : asNumber(row["seq"]);
    }

    const fork = this.forkLog({
      fromLogId: input.fromTrajectoryId,
      fromHead: input.fromBranchId,
      toLogId: input.toTrajectoryId,
      toHead: input.toBranchId,
      atSeq,
      owner: input.owner ?? null,
    });
    const pointer = this.headPointer(input.toTrajectoryId, input.toBranchId);
    return {
      fromTrajectoryId: input.fromTrajectoryId,
      fromBranchId: input.fromBranchId,
      toTrajectoryId: input.toTrajectoryId,
      toBranchId: input.toBranchId,
      copied: fork.inherited,
      headEventId: pointer.envelopeId,
      headEventHash: pointer.seq > 0 ? pointer.hash : null,
      headStateHash: this.latestStateHash(input.toTrajectoryId, input.toBranchId),
      lineage: [],
    };
  }

  @rpc({ callers: ["do", "server"] })
  forkChannelLog(input: ForkChannelLogInput): ForkChannelLogResult {
    this.ensureReady();
    if (!input.fromChannelId) throw new Error("forkChannelLog requires fromChannelId");
    if (!input.toChannelId) throw new Error("forkChannelLog requires toChannelId");
    if (input.fromChannelId === input.toChannelId)
      throw new Error("forkChannelLog requires distinct channels");
    const fork = this.forkLog({
      fromLogId: input.fromChannelId,
      fromHead: CHANNEL_LOG_HEAD,
      toLogId: input.toChannelId,
      toHead: CHANNEL_LOG_HEAD,
      atSeq: input.throughSeq ?? null,
    });
    return {
      fromChannelId: input.fromChannelId,
      toChannelId: input.toChannelId,
      throughSeq: input.throughSeq ?? null,
      copied: fork.inherited,
      lineage: [],
    };
  }

  // --- Channel adapters ------------------------------------------------------

  @rpc({ callers: ["do", "server"] })
  async appendChannelEnvelope(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): Promise<ChannelEnvelope> {
    this.ensureReady();
    const result = await this.appendLogEvent({
      logId: String(input.channelId),
      head: CHANNEL_LOG_HEAD,
      logKind: "channel",
      events: [this.channelEnvelopeEventInput(input)],
    });
    const envelope = result.envelopes[result.envelopes.length - 1]!;
    return this.channelEnvelopeView(envelope, String(input.channelId));
  }

  private channelEnvelopeEventInput(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): LogAppendEventInput {
    const annotations: Record<string, unknown> = {};
    if (input.metadata !== undefined) annotations["metadata"] = input.metadata;
    if (input.attachments !== undefined) annotations["attachments"] = input.attachments;
    return {
      envelopeId: input.envelopeId ?? null,
      actor: input.from,
      ...(input.to !== undefined ? { to: input.to } : {}),
      payloadKind: input.payloadKind ?? "opaque",
      payload: input.payload,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(input.publishedAt ? { appendedAt: input.publishedAt } : {}),
    };
  }

  @rpc({ callers: ["do", "server"] })
  async appendChannelEnvelopeWithRegistryMutation(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
      registryMutation: RegistryMutationInput;
    }
  ): Promise<ChannelEnvelope> {
    this.ensureReady();
    const { registryMutation, ...envelopeInput } = input;
    return this.transaction(() => {
      const channelId = String(envelopeInput.channelId);
      const before = this.headPointer(channelId, CHANNEL_LOG_HEAD);
      const result = this.appendLogEventInTxn({
        logId: channelId,
        head: CHANNEL_LOG_HEAD,
        logKind: "channel",
        events: [this.channelEnvelopeEventInput(envelopeInput)],
      });
      const envelope = result.envelopes[result.envelopes.length - 1]!;
      // Registry mutations ride only fresh appends: a replayed envelope already
      // carried its mutation the first time.
      if (result.headSeq > before.seq) {
        this.applyRegistryMutation(
          channelId,
          envelope.seq,
          sanitizeRegistryMutation(registryMutation)
        );
      }
      return this.channelEnvelopeView(envelope, channelId);
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getChannelEnvelope(input: {
    envelopeId: string;
    channelId?: string | null;
  }): ChannelEnvelope | null {
    this.ensureReady();
    if (input.channelId) {
      const envelope = this.getLogEvent({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        envelopeId: input.envelopeId,
      });
      return envelope ? this.channelEnvelopeView(envelope, input.channelId) : null;
    }
    const row = this.sql
      .exec(`SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`, input.envelopeId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.channelEnvelopeView(this.mapLogEnvelope(row)) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getChannelReplayWindow(input: {
    channelId: string;
    mode: "initial" | "after" | "before";
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    limit?: number | null;
  }): ChannelReplayWindow {
    this.ensureReady();
    const rawLimit = input.limit ?? 50;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 0), 500) : 50;
    const stats = this.lineageEventStats({ logId: input.channelId, head: CHANNEL_LOG_HEAD });
    let rows: LogEnvelope[];
    if (input.mode === "after") {
      const sinceSeq = input.sinceSeq ?? 0;
      rows = this.readLog({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        afterSeq: sinceSeq,
        limit,
      });
    } else if (input.mode === "before") {
      if (input.beforeSeq == null) throw new Error("beforeSeq required for before replay");
      rows = this.readLogTail({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        beforeSeq: input.beforeSeq,
        limit,
      });
    } else {
      rows = this.readLogTail({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        limit,
      });
    }
    const replayFromId = rows.length > 0 ? rows[0]!.seq : undefined;
    const replayToId = rows.length > 0 ? rows[rows.length - 1]!.seq : undefined;
    let hasMoreBefore: boolean | undefined;
    if (input.mode === "initial") {
      hasMoreBefore =
        replayFromId !== undefined && stats.firstSeq !== undefined && stats.firstSeq < replayFromId;
    } else if (input.mode === "before") {
      const anchor = replayFromId ?? input.beforeSeq ?? 0;
      hasMoreBefore = anchor > 0 && stats.firstSeq !== undefined && stats.firstSeq < anchor;
    }
    return {
      envelopes: rows.map((envelope) => this.channelEnvelopeView(envelope, input.channelId)),
      totalCount: stats.count,
      firstEnvelopeSeq: stats.firstSeq,
      replayFromId,
      replayToId,
      ...(hasMoreBefore !== undefined ? { hasMoreBefore } : {}),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listChannelEnvelopesAfter(input: {
    channelId: string;
    seq?: number | null;
    limit?: number | null;
  }): ChannelEnvelope[] {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "after",
      sinceSeq: input.seq ?? 0,
      limit: input.limit,
    }).envelopes;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listChannelEnvelopesBefore(input: {
    channelId: string;
    seq: number;
    limit?: number | null;
  }): ChannelEnvelope[] {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "before",
      beforeSeq: input.seq,
      limit: input.limit,
    }).envelopes;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getInitialChannelWindow(input: {
    channelId: string;
    limit?: number | null;
  }): ChannelReplayWindow {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "initial",
      limit: input.limit,
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listChannelEnvelopes(input: {
    channelId: string;
    cursor?: number | null;
    limit?: number | null;
    payloadKind?: string | null;
  }): ChannelEnvelope[] {
    this.ensureReady();
    const limit = input.limit ?? 500;
    if (limit <= 0) return [];
    return this.readLog({
      logId: input.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: input.cursor ?? 0,
      payloadKind: input.payloadKind ?? null,
      limit,
    }).map((envelope) => this.channelEnvelopeView(envelope, input.channelId));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectChannelEnvelopes(input: {
    channelId: string;
    cursor?: number | null;
    limit?: number | null;
    payloadKind?: string | null;
  }): { rows: ChannelEnvelopeInspection[] } {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const envelopes = this.readLog({
      logId: input.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: input.cursor ?? 0,
      payloadKind: input.payloadKind ?? null,
      limit,
    });
    return {
      rows: envelopes.map((envelope) => {
        const annotations = envelope.annotations ?? {};
        const refs = this.sql
          .exec(
            `SELECT field_path, digest, purpose, size, created_at
             FROM log_blob_refs WHERE envelope_id = ?
             ORDER BY field_path ASC`,
            String(envelope.envelopeId)
          )
          .toArray() as JsonRecord[];
        const payloadText = JSON.stringify(envelope.payload ?? null);
        return {
          envelopeId: String(envelope.envelopeId),
          channelId: input.channelId,
          seq: envelope.seq,
          payloadKind: envelope.payloadKind,
          from: summarizeJsonForInspection(envelope.actor) as JsonRecord,
          ...(annotations["metadata"] !== undefined
            ? { metadata: summarizeJsonForInspection(annotations["metadata"]) as JsonRecord }
            : {}),
          bytes: {
            from: utf8Bytes(JSON.stringify(envelope.actor)),
            to: utf8Bytes(envelope.to !== undefined ? JSON.stringify(envelope.to) : ""),
            payload: utf8Bytes(payloadText),
            metadata: utf8Bytes(
              annotations["metadata"] !== undefined ? JSON.stringify(annotations["metadata"]) : ""
            ),
            attachments: utf8Bytes(
              annotations["attachments"] !== undefined
                ? JSON.stringify(annotations["attachments"])
                : ""
            ),
          },
          payloadSummary: summarizeJsonForInspection(envelope.payload),
          storedRefs: refs,
          publishedAt: envelope.appendedAt,
        };
      }),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listMessageTypes(input: { channelId: string }): ChannelMessageTypeDefinition[] {
    this.ensureReady();
    const rows = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         ORDER BY type_id ASC`,
        input.channelId
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapMessageType(row));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getMessageType(input: {
    channelId: string;
    typeId: string;
  }): ChannelMessageTypeDefinition | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND type_id = ?
           AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         LIMIT 1`,
        input.channelId,
        input.typeId
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapMessageType(row) : null;
  }

  /** WS2: registry mutations are a projection of published `messageType.*`
   *  events — validated and applied inside the same append txn. Malformed
   *  registrations REJECT the append (replacing the channel-side
   *  `Invalid registry payload` throw). Idempotent under fork-seed/replay via
   *  the monotone seq guards in applyRegistryMutation. */
  private projectMessageTypeEvent(envelope: LogEnvelope): void {
    const event = envelope.payload as Record<string, unknown> | null;
    if (!event || typeof event !== "object") return;
    const kind = asString(event["kind"]);
    if (kind !== "messageType.registered" && kind !== "messageType.cleared") return;
    const payload =
      event["payload"] && typeof event["payload"] === "object" && !Array.isArray(event["payload"])
        ? (event["payload"] as Record<string, unknown>)
        : {};
    const typeId = asString(payload["typeId"]);
    if (!typeId) {
      throw new Error(`${kind} payload invalid: typeId must be a non-empty string`);
    }
    if (kind === "messageType.cleared") {
      this.applyRegistryMutation(envelope.logId, envelope.seq, {
        kind: "clearMessageType",
        typeId,
      });
      return;
    }
    const displayMode = payload["displayMode"];
    if (displayMode !== "inline" && displayMode !== "row") {
      throw new Error(
        `messageType.registered payload invalid: displayMode must be "inline" or "row"`
      );
    }
    const source = payload["source"];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`messageType.registered payload invalid: source is required`);
    }
    for (const field of ["imports", "stateSchema", "updateSchema"] as const) {
      const value = payload[field];
      if (value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`messageType.registered payload invalid: ${field} must be an object`);
      }
    }
    const registeredBy = payload["registeredBy"] ?? event["actor"];
    this.applyRegistryMutation(
      envelope.logId,
      envelope.seq,
      sanitizeRegistryMutation({
        kind: "upsertMessageType",
        typeId,
        row: {
          displayMode: displayMode as "inline" | "row",
          source: source as ChannelMessageTypeDefinition["source"],
          ...(payload["imports"] ? { imports: payload["imports"] as Record<string, string> } : {}),
          ...(payload["stateSchema"]
            ? { stateSchema: payload["stateSchema"] as Record<string, unknown> }
            : {}),
          ...(payload["updateSchema"]
            ? { updateSchema: payload["updateSchema"] as Record<string, unknown> }
            : {}),
          ...(registeredBy ? { registeredBy: registeredBy as Record<string, unknown> } : {}),
        },
      })
    );
  }

  private applyRegistryMutation(
    channelId: string,
    seq: number,
    mutation: RegistryMutationInput
  ): void {
    if (mutation.kind === "upsertMessageType") {
      this.sql.exec(
        `INSERT INTO channel_message_types (
           channel_id, type_id, display_mode, source_json, imports_json, schema_json,
           registered_by_json, updated_at_seq, cleared_at_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(channel_id, type_id) DO UPDATE SET
           display_mode = excluded.display_mode,
           source_json = excluded.source_json,
           imports_json = excluded.imports_json,
           schema_json = excluded.schema_json,
           registered_by_json = excluded.registered_by_json,
           updated_at_seq = excluded.updated_at_seq,
           cleared_at_seq = CASE
             WHEN channel_message_types.cleared_at_seq IS NOT NULL
              AND channel_message_types.cleared_at_seq > excluded.updated_at_seq
             THEN channel_message_types.cleared_at_seq
             ELSE NULL
           END
         WHERE excluded.updated_at_seq > channel_message_types.updated_at_seq
           AND excluded.updated_at_seq > COALESCE(channel_message_types.cleared_at_seq, -1)`,
        channelId,
        mutation.typeId,
        mutation.row.displayMode,
        JSON.stringify(mutation.row.source),
        mutation.row.imports ? JSON.stringify(mutation.row.imports) : null,
        // schema_json holds both JSON Schema documents for the type.
        mutation.row.stateSchema !== undefined || mutation.row.updateSchema !== undefined
          ? JSON.stringify({
              stateSchema: mutation.row.stateSchema,
              updateSchema: mutation.row.updateSchema,
            })
          : null,
        mutation.row.registeredBy ? JSON.stringify(mutation.row.registeredBy) : null,
        seq
      );
      return;
    }

    this.sql.exec(
      `INSERT INTO channel_message_types (
         channel_id, type_id, updated_at_seq, cleared_at_seq
       ) VALUES (?, ?, -1, ?)
       ON CONFLICT(channel_id, type_id) DO UPDATE SET
         cleared_at_seq = MAX(COALESCE(channel_message_types.cleared_at_seq, -1), excluded.cleared_at_seq)`,
      channelId,
      mutation.typeId,
      seq
    );
  }

  private mapMessageType(row: JsonRecord): ChannelMessageTypeDefinition {
    const result: ChannelMessageTypeDefinition = {
      typeId: String(row["type_id"]),
      displayMode: String(row["display_mode"]) === "inline" ? "inline" : "row",
      source: parseRecord(asString(row["source_json"])) as ChannelMessageTypeDefinition["source"],
      updatedAtSeq: asNumber(row["updated_at_seq"]),
    };
    if (row["imports_json"])
      result.imports = parseRecord(asString(row["imports_json"])) as Record<string, string>;
    if (row["schema_json"]) {
      const schemas = parseJson(asString(row["schema_json"])) as {
        stateSchema?: Record<string, unknown>;
        updateSchema?: Record<string, unknown>;
      } | null;
      if (schemas && typeof schemas === "object") {
        if (schemas.stateSchema) result.stateSchema = schemas.stateSchema;
        if (schemas.updateSchema) result.updateSchema = schemas.updateSchema;
      }
    }
    if (row["registered_by_json"])
      result.registeredBy = parseRecord(asString(row["registered_by_json"]));
    if (row["cleared_at_seq"] !== null && row["cleared_at_seq"] !== undefined) {
      result.clearedAtSeq = asNumber(row["cleared_at_seq"]);
    }
    return result;
  }

  // --- Lineage queries over causality edges ----------------------------------

  private originRowForChannelRow(channelRow: JsonRecord): JsonRecord | null {
    const originLogId = asString(channelRow["origin_log_id"]);
    const originHead = asString(channelRow["origin_head"]);
    const originEnvelopeId = asString(channelRow["origin_envelope_id"]);
    if (!originLogId || !originHead || !originEnvelopeId) return null;
    return this.lineageEventRow(originLogId, originHead, originEnvelopeId);
  }

  private lineageForChannelRow(channelRow: JsonRecord): EnvelopeLineage | null {
    const originRow = this.originRowForChannelRow(channelRow);
    if (!originRow) return null;
    const channelEnvelope = this.mapLogEnvelope(channelRow);
    const originEnvelope = this.mapLogEnvelope(originRow);
    return {
      publication: {
        eventId: String(originEnvelope.envelopeId),
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
        channelId: channelEnvelope.logId,
        channelSeq: channelEnvelope.seq,
        envelopeId: String(channelEnvelope.envelopeId),
        publishedAt: channelEnvelope.appendedAt,
      },
      envelope: this.channelEnvelopeView(channelEnvelope),
      trajectoryEvent: this.trajectoryEventView(originEnvelope, {
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
      }),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getTrajectoryForEnvelope(input: { envelopeId: string }): EnvelopeLineage | null {
    this.ensureReady();
    const channelRow = this.sql
      .exec(
        `SELECT * FROM log_events WHERE envelope_id = ? AND origin_envelope_id IS NOT NULL LIMIT 1`,
        input.envelopeId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!channelRow) return null;
    return this.lineageForChannelRow(channelRow);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listPublishedEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    this.ensureReady();
    const clauses: string[] = ["ch.origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("ch.origin_log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("ch.origin_head = ?");
      bindings.push(input.branchId);
    }
    if (input.eventId) {
      clauses.push("ch.origin_envelope_id = ?");
      bindings.push(input.eventId);
    }
    if (input.channelId) {
      clauses.push("ch.log_id = ?");
      bindings.push(input.channelId);
    }
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT ch.* FROM log_events ch
         WHERE ${clauses.join(" AND ")}
         ORDER BY ch.log_id ASC, ch.seq ASC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    const lineages: EnvelopeLineage[] = [];
    for (const row of rows) {
      const lineage = this.lineageForChannelRow(row);
      if (!lineage) continue;
      if (input.turnId && lineage.trajectoryEvent.turnId !== input.turnId) continue;
      lineages.push(lineage);
    }
    return lineages;
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    return this.listPublishedEnvelopesForTrajectory(input);
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getPublishedArtifactsForTurn(input: {
    branchId?: string | null;
    turnId: string;
    channelId?: string | null;
    limit?: number | null;
  }): PublishedArtifact[] {
    return this.listPublishedEnvelopesForTrajectory({
      branchId: input.branchId,
      turnId: input.turnId,
      channelId: input.channelId,
      limit: input.limit,
    }).map((lineage) => ({ lineage }));
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getPrivateLineageForPublishedEnvelope(input: {
    envelopeId: string;
  }): PrivateLineageForPublishedEnvelope | null {
    this.ensureReady();
    const lineage = this.getTrajectoryForEnvelope(input);
    if (!lineage) return null;
    const trajectoryId = lineage.publication.trajectoryId;
    const branchId = lineage.publication.branchId;
    const events = this.readLog({ logId: trajectoryId, head: branchId, limit: 0 }).filter(
      (envelope) => envelope.seq <= lineage.trajectoryEvent.seq
    );
    return {
      lineage,
      branchEvents: events.map((envelope) =>
        this.trajectoryEventView(envelope, { trajectoryId, branchId })
      ),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getDownstreamConsumers(input: { envelopeId: string; limit?: number | null }): TrajectoryEvent[] {
    this.ensureReady();
    const needle = input.envelopeId;
    const rows = this.sql
      .exec(
        `SELECT * FROM log_events
         WHERE (causality_json LIKE ? OR payload_ref_json LIKE ?)
           AND envelope_id != ?
           AND origin_envelope_id IS NULL
         ORDER BY appended_at ASC, log_id ASC, head ASC, seq ASC
         LIMIT ?`,
        `%${needle}%`,
        `%${needle}%`,
        needle,
        Math.min(Math.max(input.limit ?? 500, 1), 1000)
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.trajectoryEventView(this.mapLogEnvelope(row)));
  }

  // --- Inspection / maintenance ----------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectPublicationIntegrity(
    input: { channelId?: string | null; branchId?: string | null; limit?: number | null } = {}
  ): PublicationIntegrityInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = ["origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.channelId) {
      clauses.push("log_id = ?");
      bindings.push(input.channelId);
    }
    if (input.branchId) {
      clauses.push("origin_head = ?");
      bindings.push(input.branchId);
    }
    const publicationRows = this.sql
      .exec(
        `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY log_id, seq`,
        ...bindings
      )
      .toArray() as JsonRecord[];
    const rows: JsonRecord[] = [];
    let orphanMappings = 0;
    for (const row of publicationRows) {
      const origin = this.originRowForChannelRow(row);
      if (!origin) {
        orphanMappings += 1;
        if (rows.length < limit) {
          rows.push({
            type: "orphan-mapping",
            envelopeId: row["envelope_id"] as JsonValue,
            channelId: row["log_id"] as JsonValue,
            originLogId: row["origin_log_id"] as JsonValue,
            originEnvelopeId: row["origin_envelope_id"] as JsonValue,
          });
        }
      }
    }
    const channelOriginAgenticEnvelopes = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count FROM log_events
           WHERE payload_kind = ? AND origin_envelope_id IS NULL
           ${input.channelId ? "AND log_id = ?" : ""}`,
          ...(input.channelId
            ? [AGENTIC_EVENT_PAYLOAD_KIND, input.channelId]
            : [AGENTIC_EVENT_PAYLOAD_KIND])
        )
        .one()["count"]
    );
    return {
      summary: {
        expectedMappings: publicationRows.length,
        missingMappings: 0,
        orphanMappings,
        missingPublicationEvents: orphanMappings,
        missingPublicationEnvelopes: 0,
        sequenceMismatches: 0,
        channelOriginAgenticEnvelopes,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectTurnState(
    input: {
      trajectoryId?: string | null;
      branchId?: string | null;
      channelId?: string | null;
      limit?: number | null;
    } = {}
  ): TurnStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("t.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("t.head = ?");
      bindings.push(input.branchId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT t.log_id AS log_id,
                t.head AS head,
                t.turn_id AS turn_id,
                t.opened_at AS opened_at,
                t.closed_at AS closed_at,
                COUNT(DISTINCT CASE WHEN m.status != 'completed' THEN m.message_id END) AS streaming_messages,
                COUNT(DISTINCT CASE WHEN i.status NOT IN ('completed', 'failed', 'cancelled', 'abandoned') THEN i.invocation_id END) AS nonterminal_invocations,
                COUNT(DISTINCT e.envelope_id) AS duplicate_open_events
         FROM trajectory_turns t
         LEFT JOIN trajectory_messages m
           ON m.log_id = t.log_id AND m.head = t.head AND m.turn_id = t.turn_id
         LEFT JOIN trajectory_invocations i
           ON i.log_id = t.log_id AND i.head = t.head AND i.turn_id = t.turn_id
         LEFT JOIN log_events e
           ON e.log_id = t.log_id AND e.head = t.head AND e.turn_id = t.turn_id
          AND e.payload_kind = 'turn.opened'
         ${where}
         GROUP BY t.log_id, t.head, t.turn_id, t.opened_at, t.closed_at
         ORDER BY t.opened_at DESC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    const scopedRows = input.channelId
      ? rows.filter((row) => String(row["head"]).includes(input.channelId!))
      : rows;
    return {
      summary: {
        branches: new Set(
          scopedRows.map((row) => `${String(row["log_id"])} ${String(row["head"])}`)
        ).size,
        openTurns: scopedRows.filter((row) => row["closed_at"] == null).length,
        streamingMessages: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["streaming_messages"]),
          0
        ),
        nonterminalInvocations: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["nonterminal_invocations"]),
          0
        ),
        duplicateOpenedTurns: scopedRows.filter((row) => asNumber(row["duplicate_open_events"]) > 1)
          .length,
      },
      rows: scopedRows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectInvocationState(
    input: {
      trajectoryId?: string | null;
      branchId?: string | null;
      invocationId?: string | null;
      transportCallId?: string | null;
      limit?: number | null;
    } = {}
  ): InvocationStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("i.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("i.head = ?");
      bindings.push(input.branchId);
    }
    if (input.invocationId) {
      clauses.push("i.invocation_id = ?");
      bindings.push(input.invocationId);
    }
    if (input.transportCallId) {
      clauses.push("i.transport_call_id = ?");
      bindings.push(input.transportCallId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT i.log_id,
                i.head,
                i.invocation_id,
                i.transport_call_id,
                i.kind,
                i.status,
                i.terminal_outcome,
                i.terminal_reason_code,
                i.started_event_id,
                i.completed_event_id,
                i.updated_at,
                COUNT(CASE WHEN e.payload_kind = 'invocation.started' THEN 1 END) AS started_events,
                COUNT(CASE WHEN e.payload_kind IN ('invocation.completed', 'invocation.failed', 'invocation.cancelled', 'invocation.abandoned') THEN 1 END) AS terminal_events
         FROM trajectory_invocations i
         LEFT JOIN log_events e
           ON e.log_id = i.log_id
          AND e.head = i.head
          AND json_extract(e.causality_json, '$.invocationId') = i.invocation_id
         ${where}
         GROUP BY i.log_id, i.head, i.invocation_id, i.transport_call_id, i.kind, i.status,
                  i.terminal_outcome, i.terminal_reason_code, i.started_event_id,
                  i.completed_event_id, i.updated_at
         ORDER BY i.updated_at DESC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    return {
      summary: {
        projected: rows.length,
        startedEvents: rows.reduce((sum, row) => sum + asNumber(row["started_events"]), 0),
        terminalEvents: rows.reduce((sum, row) => sum + asNumber(row["terminal_events"]), 0),
        openProjectedInvocations: rows.filter(
          (row) =>
            !["completed", "failed", "cancelled", "abandoned"].includes(String(row["status"]))
        ).length,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectChannelRoster(input: {
    channelId: string;
    limit?: number | null;
  }): ChannelRosterInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT channel_id,
                participant_id,
                joined_at,
                left_at,
                roles_json
           FROM channel_roster
          WHERE channel_id = ?
          ORDER BY joined_at DESC
          LIMIT ?`,
        input.channelId,
        limit
      )
      .toArray()
      .map((row) => ({
        channel_id: row["channel_id"] as JsonValue,
        participant_id: row["participant_id"] as JsonValue,
        joined_at: row["joined_at"] as JsonValue,
        left_at: row["left_at"] as JsonValue,
        roles: parseJson(row["roles_json"] as string | null | undefined) as JsonValue,
      })) as JsonRecord[];
    return {
      summary: {
        rows: rows.length,
        activeParticipants: rows.filter((row) => row["left_at"] == null).length,
        inactiveParticipants: rows.filter((row) => row["left_at"] != null).length,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async inspectAgentHealth(input: {
    channelId: string;
    branchId?: string | null;
    limit?: number | null;
    envelopeLimit?: number | null;
    storageLimit?: number | null;
    rowByteLimit?: number | null;
  }): Promise<AgentHealthInspection> {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const branchId = input.branchId ?? `branch:channel:${input.channelId}`;
    const publicationIntegrity = this.inspectPublicationIntegrity({
      channelId: input.channelId,
      branchId,
      limit,
    });
    const turnState = this.inspectTurnState({ channelId: input.channelId, branchId, limit });
    const invocationState = this.inspectInvocationState({ branchId, limit });
    const roster = this.inspectChannelRoster({ channelId: input.channelId, limit });
    const envelopes = this.inspectChannelEnvelopes({
      channelId: input.channelId,
      limit: input.envelopeLimit ?? Math.min(limit, 25),
    });
    const storage = this.inspectStorageDiagnostics({
      branchId,
      channelId: input.channelId,
      rowByteLimit: input.rowByteLimit,
      limit: input.storageLimit ?? Math.min(limit, 25),
    });
    const publicationIssues =
      asNumber(publicationIntegrity.summary.missingMappings) +
      asNumber(publicationIntegrity.summary.orphanMappings) +
      asNumber(publicationIntegrity.summary.sequenceMismatches);
    const openTurns = asNumber(turnState.summary.openTurns);
    const streamingMessages = asNumber(turnState.summary.streamingMessages);
    const nonterminalInvocations = asNumber(turnState.summary.nonterminalInvocations);
    const storageIssues = storage.rows.length;
    return {
      channelId: input.channelId,
      branchId,
      generatedAt: nowIso(),
      summary: {
        ok:
          publicationIssues === 0 &&
          openTurns === 0 &&
          streamingMessages === 0 &&
          nonterminalInvocations === 0 &&
          storageIssues === 0,
        publicationIssues,
        openTurns,
        streamingMessages,
        nonterminalInvocations,
        activeParticipants: roster.summary.activeParticipants,
        storageIssues,
      },
      publicationIntegrity,
      turnState,
      invocationState,
      roster,
      envelopes,
      storage,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  inspectStorageDiagnostics(
    input: {
      rowByteLimit?: number | null;
      limit?: number | null;
      branchId?: string | null;
      channelId?: string | null;
    } = {}
  ): { rows: JsonRecord[] } {
    this.ensureReady();
    const rowByteLimit = input.rowByteLimit ?? 512 * 1024;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows: JsonRecord[] = [];

    const eventClauses = ["length(payload_ref_json) > ?"];
    const eventBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      eventClauses.unshift("(head = ? OR log_id = ?)");
      eventBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      eventClauses.unshift("head = ?");
      eventBindings.push(input.branchId);
    } else if (input.channelId) {
      eventClauses.unshift("log_id = ?");
      eventBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'log_events' AS scope, envelope_id AS id, length(payload_ref_json) AS bytes
           FROM log_events
           WHERE ${eventClauses.join(" AND ")}
           ORDER BY bytes DESC LIMIT ?`,
          ...eventBindings,
          rowByteLimit,
          limit
        )
        .toArray() as JsonRecord[])
    );

    const invocationBindings: SqlBinding[] = [];
    const invocationWhere = input.branchId ? "AND head = ?" : "";
    if (input.branchId) invocationBindings.push(input.branchId);
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'trajectory_invocations' AS scope, invocation_id AS id,
                  MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) AS bytes
           FROM trajectory_invocations
           WHERE MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) > ?
           ${invocationWhere}
           ORDER BY bytes DESC LIMIT ?`,
          rowByteLimit,
          ...invocationBindings,
          limit
        )
        .toArray() as JsonRecord[])
    );

    const refClauses: string[] = [];
    const refBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      refClauses.push("(r.head = ? OR r.log_id = ?)");
      refBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      refClauses.push("r.head = ?");
      refBindings.push(input.branchId);
    } else if (input.channelId) {
      refClauses.push("r.log_id = ?");
      refBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'missing_gad_blob_index' AS scope, r.digest AS id, r.size AS bytes
           FROM log_blob_refs r
           LEFT JOIN gad_blobs b ON b.hash = r.digest
           WHERE b.hash IS NULL
           ${refClauses.length ? `AND ${refClauses.join(" AND ")}` : ""}
           LIMIT ?`,
          ...refBindings,
          limit
        )
        .toArray() as JsonRecord[])
    );

    return { rows: rows.slice(0, limit) };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  listStoredValueRefs(
    input: {
      eventId?: string | null;
      envelopeId?: string | null;
      digest?: string | null;
      limit?: number | null;
    } = {}
  ): { rows: JsonRecord[] } {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    const ownerId = input.eventId ?? input.envelopeId;
    if (ownerId) {
      clauses.push("r.envelope_id = ?");
      bindings.push(ownerId);
    }
    if (input.digest) {
      clauses.push("r.digest = ?");
      bindings.push(input.digest);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT CASE WHEN lh.log_kind = 'channel' THEN 'channel' ELSE 'trajectory' END AS ref_scope,
                r.envelope_id AS owner_id,
                r.field_path, r.digest, r.purpose, r.size, r.created_at
         FROM log_blob_refs r
         LEFT JOIN log_heads lh ON lh.log_id = r.log_id AND lh.head = r.head
         ${where}
         ORDER BY r.created_at ASC LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    return { rows };
  }

  @rpc({ callers: ["server"] })
  collectGarbageBlobRefs(input: { dryRun?: boolean | null; limit?: number | null } = {}): {
    deleted: string[];
    kept: number;
    dryRun: boolean;
  } {
    this.ensureReady();
    const dryRun = input.dryRun !== false;
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const rows = this.sql
      .exec(
        `SELECT b.hash
       FROM gad_blobs b
       LEFT JOIN (
         SELECT digest FROM log_blob_refs
         UNION
         SELECT content_hash AS digest FROM gad_file_versions WHERE content_hash IS NOT NULL
       ) refs ON refs.digest = b.hash
       WHERE refs.digest IS NULL
       LIMIT ?`,
        limit
      )
      .toArray() as Array<{ hash: string }>;
    const deleted = rows.map((row) => String(row.hash));
    if (!dryRun) {
      for (const hash of deleted) this.sql.exec(`DELETE FROM gad_blobs WHERE hash = ?`, hash);
    }
    const kept =
      asNumber(this.sql.exec(`SELECT COUNT(*) AS cnt FROM gad_blobs`).one()["cnt"]) -
      (dryRun ? 0 : deleted.length);
    return { deleted, kept, dryRun };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  getStatus(): { metric: string; value: number }[] {
    const count = (sql: string, ...bindings: SqlBinding[]) =>
      asNumber(this.sql.exec(sql, ...bindings).one()["value"]);
    return [
      { metric: "Log events", value: count(`SELECT COUNT(*) AS value FROM log_events`) },
      { metric: "Log heads", value: count(`SELECT COUNT(*) AS value FROM log_heads`) },
      {
        metric: "Channel envelopes",
        value: count(
          `SELECT COUNT(*) AS value FROM log_events e
           JOIN log_heads h ON h.log_id = e.log_id AND h.head = e.head
           WHERE h.log_kind = 'channel'`
        ),
      },
      {
        metric: "Worktree states",
        value: count(`SELECT COUNT(*) AS value FROM gad_worktree_states`),
      },
      { metric: "Claims", value: count(`SELECT COUNT(*) AS value FROM gad_claims`) },
    ];
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async validateGadHashes(): Promise<{ ok: boolean; errors: string[] }> {
    const integrity = await this.checkGadIntegrity();
    return {
      ok: integrity.ok,
      errors: integrity.errors.map(
        (error) => `${String(error["type"])}: ${String(error["message"])}`
      ),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  clearDirtyAfterValidation(): Promise<{ ok: boolean; errors: string[] }> {
    return this.validateGadHashes();
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async checkGadIntegrity(): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    this.ensureReady();
    const errors: JsonRecord[] = [];
    const addError = (type: string, message: string, details: JsonRecord = {}) =>
      errors.push({ type, message, ...details });

    const logIntegrity = await this.checkLogIntegrity({});
    errors.push(...logIntegrity.errors);

    const manifestSeen = new Map<string, string | null>();
    for (const state of this.sql
      .exec(`SELECT state_hash, manifest_root_hash FROM gad_worktree_states`)
      .toArray() as JsonRecord[]) {
      const rootHash = asString(state["manifest_root_hash"]) ?? "";
      const recomputedRoot = this.recomputeManifestHashDeep(rootHash, errors, manifestSeen);
      if (recomputedRoot !== null && this.stateHashForRoot(rootHash) !== state["state_hash"]) {
        addError("worktree-state", "worktree state hash mismatch", {
          stateHash: state["state_hash"] as JsonValue,
          expectedStateHash: this.stateHashForRoot(rootHash),
        });
      }
    }

    for (const transition of this.sql
      .exec(`SELECT * FROM gad_state_transitions`)
      .toArray() as JsonRecord[]) {
      const eventId = String(transition["event_id"]);
      if (!this.stateExists(String(transition["input_state_hash"]))) {
        addError("state-transition", "transition input state is missing", { eventId });
      }
      if (!this.stateExists(String(transition["output_state_hash"]))) {
        addError("state-transition", "transition output state is missing", { eventId });
      }
      const eventExists =
        this.sql
          .exec(`SELECT 1 AS ok FROM log_events WHERE envelope_id = ? LIMIT 1`, eventId)
          .toArray().length > 0;
      if (!eventExists) {
        addError("state-transition", "transition event is missing", { eventId });
      }
    }

    for (const orphan of this.inspectPublicationIntegrity({}).rows) {
      addError("publication", "publication origin is missing", orphan);
    }

    for (const event of this.sql.exec(`SELECT * FROM log_events`).toArray() as JsonRecord[]) {
      for (const field of [
        "actor_json",
        "to_json",
        "payload_ref_json",
        "annotations_json",
      ] as const) {
        const path = findPrivateParticipantMetadataPath(parseJson(asString(event[field])));
        if (path) {
          addError("log-event-shape", "log event contains private participant metadata", {
            envelopeId: event["envelope_id"] as JsonValue,
            field,
            path,
          });
        }
      }
    }

    for (const row of this.inspectStorageDiagnostics({}).rows) {
      addError("storage-diagnostic", "oversized or missing indexed storage artifact", row);
    }

    this.checkEditOpChainContinuity(addError);

    return { ok: errors.length === 0, errors };
  }

  /**
   * U2 standing invariant (design §5.1): the per-path first-parent edit-op chain
   * is total — `op[k+1].old_content_hash == op[k].new_content_hash`. Walks each
   * repo head's first-parent commit lineage, groups the path's committed ops in
   * lineage order, and asserts continuity: `synthetic` + `create` RESTART the
   * chain, `delete` ENDS it, `chmod` passes content through, binary rows
   * participate by hash only. A break is a loud integrity failure (never a silent
   * mis-blame). Bounded to {@link CHAIN_CHECK_CAP} committed ops per repo.
   */
  private checkEditOpChainContinuity(
    addError: (type: string, message: string, details?: JsonRecord) => void
  ): void {
    const logRows = this.sql
      .exec(`SELECT DISTINCT log_id FROM gad_worktree_edit_ops WHERE log_id IS NOT NULL`)
      .toArray() as Array<{ log_id?: string | null }>;
    for (const logRow of logRows) {
      const logId = asString(logRow.log_id);
      if (!logId) continue;
      let examined = 0;
      const heads = this.sql
        .exec(
          `SELECT head, commit_event_id FROM gad_worktree_heads
           WHERE log_id = ? AND commit_event_id IS NOT NULL`,
          logId
        )
        .toArray() as Array<{ head?: string; commit_event_id?: string | null }>;
      for (const h of heads) {
        if (examined >= CHAIN_CHECK_CAP) break;
        const tip = asString(h.commit_event_id);
        if (!tip) continue;
        // First-parent commit lineage (newest→oldest), then an oldest→newest map.
        const lineage: string[] = [];
        const seen = new Set<string>();
        let cur: string | null = tip;
        while (cur && !seen.has(cur) && lineage.length < BLAME_MAX_COMMITS) {
          seen.add(cur);
          lineage.push(cur);
          cur = this.parentEventIdAt(cur, 0);
        }
        if (lineage.length === 0) continue;
        const order = new Map(
          lineage
            .slice()
            .reverse()
            .map((eventId, index) => [eventId, index] as const)
        );
        const rows = this.sql
          .exec(
            `SELECT id, path, kind, old_content_hash, new_content_hash, synthetic,
                    edit_seq, ordinal, committed_event_id
             FROM gad_worktree_edit_ops
             WHERE log_id = ? AND committed_event_id IN (${lineage.map(() => "?").join(", ")})`,
            logId,
            ...lineage
          )
          .toArray() as JsonRecord[];
        examined += rows.length;
        const byPath = new Map<string, JsonRecord[]>();
        for (const row of rows) {
          const p = String(row["path"]);
          let arr = byPath.get(p);
          if (!arr) {
            arr = [];
            byPath.set(p, arr);
          }
          arr.push(row);
        }
        for (const [p, pathRows] of byPath) {
          pathRows.sort((a, b) => {
            const byCommit =
              (order.get(String(a["committed_event_id"])) ?? 0) -
              (order.get(String(b["committed_event_id"])) ?? 0);
            if (byCommit !== 0) return byCommit;
            const bySeq = Number(a["edit_seq"] ?? 0) - Number(b["edit_seq"] ?? 0);
            if (bySeq !== 0) return bySeq;
            return Number(a["ordinal"] ?? 0) - Number(b["ordinal"] ?? 0);
          });
          let prevNew: string | null = null;
          let started = false;
          for (const row of pathRows) {
            const kind = String(row["kind"]);
            const oldHash = asString(row["old_content_hash"]);
            const newHash = asString(row["new_content_hash"]);
            const synthetic = Number(row["synthetic"]) === 1;
            if (synthetic || kind === "create") {
              prevNew = newHash;
              started = true;
              continue;
            }
            if (started && prevNew !== null && oldHash !== prevNew) {
              addError("edit-op-chain", "committed edit-op chain is broken", {
                logId,
                head: h.head ?? null,
                path: p,
                opId: Number(row["id"]),
                kind,
                commitEventId: asString(row["committed_event_id"]),
                expectedOldContentHash: prevNew,
                actualOldContentHash: oldHash,
              });
            }
            if (kind === "delete") {
              prevNew = null; // the file is gone; a later create restarts.
            } else if (kind === "chmod") {
              prevNew = newHash ?? oldHash ?? prevNew;
              started = true;
            } else {
              prevNew = newHash;
              started = true;
            }
          }
        }
      }
    }
  }

  private stateExists(stateHash: string): boolean {
    return !!this.sql
      .exec(`SELECT 1 AS ok FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0];
  }

  private ensureEmptyState(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (manifest_hash, kind, created_at) VALUES (?, 'dir', ?)`,
      EMPTY_MANIFEST_HASH,
      nowIso()
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?)`,
      EMPTY_STATE_HASH,
      EMPTY_MANIFEST_HASH,
      JSON.stringify({ empty: true }),
      nowIso()
    );
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}

/** Whether a payload kind is a member of the agentic EventKind vocabulary. */
function isStoredEventKind(payloadKind: string): boolean {
  return STORED_EVENT_KINDS.has(payloadKind);
}

const STORED_EVENT_KINDS = new Set<string>([
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "ui.inline_rendered",
  "ui.action_bar.updated",
  "ui.feedback",
  "messageType.registered",
  "messageType.cleared",
  "custom.started",
  "custom.updated",
  "state.transition_recorded",
  "state.snapshot_ingested",
  "state.merge_applied",
  "memory.recalled",
  "external.envelope_published",
  "external.envelope_observed",
  "external.participant_observed",
  "branch.created",
  "branch.forked",
  "branch.head_changed",
  "channel.forked",
  "channel.fork_renamed",
  "channel.fork_archived",
  "turn.opened",
  "turn.waiting",
  "turn.closed",
  "system.event",
  "system.compaction_recorded",
  "build.completed",
  "knowledge.claim_recorded",
  "knowledge.claim_updated",
  "knowledge.claim_retracted",
  "knowledge.claims_related",
]);
