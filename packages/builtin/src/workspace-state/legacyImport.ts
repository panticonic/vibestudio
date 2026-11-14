/**
 * The move of a workspace's state from `WorkspaceDO` (a SQLite cell: the engine
 * of a cell is fixed when it is created) into `WorkspaceStateDO` (a Dolt cell).
 * docs/dolt-redesign.md §9.2, P3.
 *
 * Design:
 * - The legacy class stays deployed for one release and only reads
 *   (`legacyManifest`, `legacyReadRows`). Nothing is deleted from it.
 * - The host pages the legacy rows into a local staging table of the Dolt cell
 *   (`local_legacy_rows`), which no commit, fork or reset carries.
 * - The Dolt class replays what has a history into commits (`planReplay`), each
 *   with its original time, and copies what is operational state (alarms,
 *   leases, outbox) straight into its local tables.
 * - It then proves the move: every legacy table's row digest equals the digest
 *   of the rows the Dolt cell holds. Only then is the import `verified`.
 *
 * This file is shared by both classes: the table list, the digest, and the pure
 * replay planner, which unit tests exercise without a cell.
 */
import { canonicalJson } from "@vibestudio/shared/canonicalJson";

/** A row as `{ column: value }`; columns are the legacy schema's, all TEXT or INTEGER. */
export type LegacyRow = Record<string, string | number | null>;

/** Every table of the legacy store that holds data, in the order they are staged. */
export const LEGACY_IMPORT_TABLES = [
  "entities",
  "runtime_resource_bindings",
  "slots",
  "slot_history",
  "context_edges",
  "workspace_meta",
  "panel_close_cleanup",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "do_alarm_test_policies",
  "durable_work_owners",
  "state",
] as const;
export type LegacyImportTable = (typeof LEGACY_IMPORT_TABLES)[number];

/** Tables whose rows are history and knowledge: replayed as commits. */
export const REPLAYED_TABLES: readonly LegacyImportTable[] = [
  "entities",
  "runtime_resource_bindings",
  "slots",
  "slot_history",
  "context_edges",
  "workspace_meta",
];

/** The legacy columns of every table, which is also the column whitelist of the importer. */
export const LEGACY_COLUMNS: Readonly<Record<LegacyImportTable, readonly string[]>> = {
  entities: [
    "id",
    "kind",
    "source_repo_path",
    "source_effective_version",
    "active_build_key",
    "active_execution_digest",
    "active_authority",
    "execution_authority",
    "context_id",
    "class_name",
    "key",
    "state_args",
    "native_owner",
    "agent_entity_id",
    "agent_channel_id",
    "parent_id",
    "owner_user_id",
    "authority_session_id",
    "clone_provenance",
    "created_at",
    "status",
    "retired_at",
    "cleanup_complete",
    "error",
  ],
  runtime_resource_bindings: [
    "entity_id",
    "resource_kind",
    "resource_id",
    "capabilities",
    "scope_kind",
    "scope_channel_id",
    "created_at",
  ],
  slots: [
    "slot_id",
    "parent_slot_id",
    "current_entity_id",
    "current_entry_key",
    "sort_key",
    "owner_user_id",
    "created_at",
    "closed_at",
  ],
  slot_history: [
    "slot_id",
    "cursor",
    "entry_key",
    "entity_id",
    "source",
    "context_id",
    "state_args",
    "options",
    "recorded_at",
  ],
  context_edges: [
    "context_id",
    "owner_context_id",
    "kind",
    "owner_entity_id",
    "clone_definition",
    "clone_completion",
    "created_at",
  ],
  workspace_meta: ["key", "value"],
  panel_close_cleanup: ["slot_id", "close_id", "owner_user_id", "entity_id", "queued_at"],
  lifecycle_epochs: ["epoch_id", "kind", "reason", "created_at", "generation", "status"],
  lifecycle_leases: ["source", "class_name", "object_key", "detail", "created_at", "refreshed_at"],
  lifecycle_ops: [
    "epoch_id",
    "source",
    "class_name",
    "object_key",
    "op_kind",
    "status",
    "detail",
    "updated_at",
  ],
  do_alarms: [
    "source",
    "class_name",
    "object_key",
    "wake_at",
    "dispatch_generation",
    "dispatch_owner",
  ],
  do_alarm_test_policies: ["source", "class_name", "object_key", "test_policy_json"],
  durable_work_owners: ["source", "class_name", "object_key", "queues_json", "registered_at"],
  state: ["key", "value"],
};

/** The panel-tree revision lives in `workspace_meta` in the legacy store and in a local table now. */
export const PANEL_TREE_REVISION_META_KEY = "panel_tree_revision";

export interface LegacyTableManifest {
  readonly name: LegacyImportTable;
  readonly rows: number;
  /** SHA-256 of the table's rows, independent of their order. */
  readonly digest: string;
}

export interface LegacyManifest {
  /** False when the cell holds no workspace state (a fresh workspace). */
  readonly present: boolean;
  readonly schemaVersion: number | null;
  readonly tables: readonly LegacyTableManifest[];
  /** SHA-256 over the table digests. */
  readonly digest: string;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A row in canonical form: its table's columns in order, so key order cannot matter. */
export function canonicalRow(table: LegacyImportTable, row: Record<string, unknown>): string {
  return canonicalJson(LEGACY_COLUMNS[table].map((column) => row[column] ?? null));
}

/** Order-independent digest of a table's rows. */
export async function digestRows(
  table: LegacyImportTable,
  rows: readonly Record<string, unknown>[]
): Promise<string> {
  const canonical = rows.map((row) => canonicalRow(table, row)).sort();
  return sha256Hex(`${table}\n${canonical.join("\n")}`);
}

export async function manifestOf(
  schemaVersion: number | null,
  tables: readonly LegacyTableManifest[]
): Promise<LegacyManifest> {
  const present = tables.some((table) => table.name === "entities");
  return {
    present,
    schemaVersion,
    tables,
    digest: await sha256Hex(
      tables.map((table) => `${table.name}:${table.rows}:${table.digest}`).join("\n")
    ),
  };
}

// ---------------------------------------------------------------------------
// The replay plan
// ---------------------------------------------------------------------------

export type ReplayKind =
  | "meta"
  | "entity"
  | "slot"
  | "history"
  | "binding"
  | "edge"
  | "close"
  | "retire";

/**
 * One commit of the replay. `key` names the staged row (or, for `close`, the
 * close stamp shared by every slot that one close took down). `time` is the
 * original moment the row's own timestamp records, and becomes the commit date.
 */
export interface ReplayEvent {
  readonly kind: ReplayKind;
  readonly time: number;
  readonly key: string;
  /**
   * `slot`: where the slot points when it arrives (its first history entry).
   * `history`: where the slot points once this entry is recorded (the entry
   * itself, and for the last one the slot's final pointer, which a back
   * navigation may have left on an earlier entry). Absent: leave the pointer.
   */
  readonly entityId?: string | null;
  readonly entryKey?: string | null;
}

export interface StagedRows {
  readonly entities: readonly LegacyRow[];
  readonly slots: readonly LegacyRow[];
  readonly slot_history: readonly LegacyRow[];
  readonly runtime_resource_bindings: readonly LegacyRow[];
  readonly context_edges: readonly LegacyRow[];
  readonly workspace_meta: readonly LegacyRow[];
}

/** The key under which the importer addresses a staged row (its primary key). */
export function stagedKey(table: LegacyImportTable, row: Record<string, unknown>): string {
  const part = (column: string): string => String(row[column] ?? "");
  switch (table) {
    case "entities":
      return part("id");
    case "slots":
      return part("slot_id");
    case "slot_history":
      return `${part("slot_id")}\u001f${part("cursor")}`;
    case "runtime_resource_bindings":
      return `${part("entity_id")}\u001f${part("resource_kind")}\u001f${part("resource_id")}`;
    case "context_edges":
      return `${part("context_id")}\u001f${part("owner_context_id")}\u001f${part("kind")}`;
    case "workspace_meta":
    case "state":
      return part("key");
    default:
      return JSON.stringify(LEGACY_COLUMNS[table].map((column) => row[column] ?? null));
  }
}

const RANK: Readonly<Record<ReplayKind, number>> = {
  meta: 0,
  entity: 1,
  slot: 2,
  history: 3,
  binding: 4,
  edge: 5,
  close: 6,
  retire: 7,
};

/**
 * Order the legacy rows into the sequence of mutations that built them, by the
 * timestamps the rows themselves carry:
 * - an entity arrives at `created_at` and, when retired, is retired at `retired_at`;
 * - a slot arrives at `created_at` open, its history entries at `recorded_at`,
 *   and every slot one close took down is closed together at the shared
 *   `closed_at` stamp (the close the live code stamps on all of them);
 * - bindings and context edges arrive at `created_at`.
 * A row never arrives before what it references (an agent entity, a parent
 * slot, the entity a slot or history entry points at): the dependency is pulled
 * forward, so the replay needs no deferred constraint. The order is a pure
 * function of the rows, so a resumed replay continues the same sequence.
 */
export function planReplay(rows: StagedRows): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const times: number[] = [];
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  for (const row of rows.entities) times.push(num(row["created_at"], 0));
  for (const row of rows.slots) times.push(num(row["created_at"], 0));
  const floor = times.length > 0 ? Math.min(...times) : 0;

  const entryEntity = new Map<string, string>();
  const historyOf = new Map<string, LegacyRow[]>();
  for (const row of rows.slot_history) {
    const slotId = String(row["slot_id"]);
    entryEntity.set(`${slotId}\u001f${String(row["entry_key"])}`, String(row["entity_id"]));
    const list = historyOf.get(slotId) ?? [];
    list.push(row);
    historyOf.set(slotId, list);
  }
  for (const list of historyOf.values()) {
    list.sort((a, b) => num(a["cursor"], 0) - num(b["cursor"], 0));
  }
  /** Where a slot points when its story ends, before any close of it. */
  const finalPointer = (row: LegacyRow): { entityId: string | null; entryKey: string | null } => {
    const key = row["current_entry_key"] as string | null;
    const entityId =
      row["closed_at"] === null
        ? (row["current_entity_id"] as string | null)
        : key === null
          ? null
          : (entryEntity.get(`${String(row["slot_id"])}\u001f${key}`) ?? null);
    return { entityId, entryKey: key };
  };
  const slotById = new Map(rows.slots.map((row) => [String(row["slot_id"]), row]));

  for (const row of rows.workspace_meta) {
    if (row["key"] === PANEL_TREE_REVISION_META_KEY) continue;
    events.push({ kind: "meta", time: floor, key: String(row["key"]) });
  }
  for (const row of rows.entities) {
    const created = num(row["created_at"], 0);
    events.push({ kind: "entity", time: created, key: String(row["id"]) });
    if (row["status"] === "retired") {
      events.push({
        kind: "retire",
        time: Math.max(created, num(row["retired_at"], created)),
        key: String(row["id"]),
      });
    }
  }
  const closeStamps = new Set<number>();
  for (const row of rows.slots) {
    const slotId = String(row["slot_id"]);
    const first = historyOf.get(slotId)?.[0];
    const pointer = first
      ? { entityId: String(first["entity_id"]), entryKey: String(first["entry_key"]) }
      : finalPointer(row);
    events.push({
      kind: "slot",
      time: num(row["created_at"], 0),
      key: slotId,
      entityId: pointer.entityId,
      entryKey: pointer.entryKey,
    });
    if (typeof row["closed_at"] === "number") closeStamps.add(row["closed_at"]);
  }
  for (const row of rows.slot_history) {
    const list = historyOf.get(String(row["slot_id"])) ?? [];
    const isLast = list[list.length - 1] === row;
    const slot = slotById.get(String(row["slot_id"]));
    const pointer =
      isLast && slot
        ? finalPointer(slot)
        : { entityId: String(row["entity_id"]), entryKey: String(row["entry_key"]) };
    events.push({
      kind: "history",
      time: num(row["recorded_at"], 0),
      key: stagedKey("slot_history", row),
      entityId: pointer.entityId,
      entryKey: pointer.entryKey,
    });
  }
  for (const row of rows.runtime_resource_bindings) {
    events.push({
      kind: "binding",
      time: num(row["created_at"], 0),
      key: stagedKey("runtime_resource_bindings", row),
    });
  }
  for (const row of rows.context_edges) {
    events.push({
      kind: "edge",
      time: num(row["created_at"], 0),
      key: stagedKey("context_edges", row),
    });
  }
  for (const stamp of closeStamps) events.push({ kind: "close", time: stamp, key: String(stamp) });

  events.sort(
    (a, b) =>
      a.time - b.time || RANK[a.kind] - RANK[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );

  // Pull each event's references ahead of it. The first event of each kind that
  // names a row is the one that introduces it.
  const introduces = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === "entity" || event.kind === "slot") {
      introduces.set(`${event.kind}:${event.key}`, index);
    }
  });
  const entityRow = new Map(rows.entities.map((row) => [String(row["id"]), row]));
  const slotRow = new Map(rows.slots.map((row) => [String(row["slot_id"]), row]));
  const historyRow = new Map(rows.slot_history.map((row) => [stagedKey("slot_history", row), row]));
  const closedSlotsOf = new Map<string, string[]>();
  for (const row of rows.slots) {
    if (typeof row["closed_at"] === "number") {
      const list = closedSlotsOf.get(String(row["closed_at"])) ?? [];
      list.push(String(row["slot_id"]));
      closedSlotsOf.set(String(row["closed_at"]), list);
    }
  }
  const dependencies = (event: ReplayEvent): string[] => {
    switch (event.kind) {
      case "entity": {
        const agent = entityRow.get(event.key)?.["agent_entity_id"];
        return typeof agent === "string" ? [`entity:${agent}`] : [];
      }
      case "retire":
        return [`entity:${event.key}`];
      case "slot": {
        const row = slotRow.get(event.key);
        const deps: string[] = [];
        if (typeof row?.["parent_slot_id"] === "string") deps.push(`slot:${row["parent_slot_id"]}`);
        if (typeof event.entityId === "string") deps.push(`entity:${event.entityId}`);
        return deps;
      }
      case "history": {
        const row = historyRow.get(event.key);
        const deps = [`slot:${String(row?.["slot_id"])}`, `entity:${String(row?.["entity_id"])}`];
        if (typeof event.entityId === "string") deps.push(`entity:${event.entityId}`);
        return deps;
      }
      case "binding":
        return [`entity:${event.key.split("\u001f")[0]}`];
      case "close":
        return (closedSlotsOf.get(event.key) ?? []).map((slot) => `slot:${slot}`);
      default:
        return [];
    }
  };

  const ordered: ReplayEvent[] = [];
  const emitted = new Array<boolean>(events.length).fill(false);
  for (let start = 0; start < events.length; start += 1) {
    if (emitted[start]) continue;
    const stack: Array<{ index: number; next: number; deps: string[] }> = [
      { index: start, next: 0, deps: dependencies(events[start]!) },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (emitted[top.index]) {
        stack.pop();
        continue;
      }
      let pushed = false;
      while (top.next < top.deps.length) {
        const dep = introduces.get(top.deps[top.next++]!);
        if (dep !== undefined && !emitted[dep] && !stack.some((frame) => frame.index === dep)) {
          stack.push({ index: dep, next: 0, deps: dependencies(events[dep]!) });
          pushed = true;
          break;
        }
      }
      if (pushed) continue;
      emitted[top.index] = true;
      ordered.push(events[top.index]!);
      stack.pop();
    }
  }
  return ordered;
}
