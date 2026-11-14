/**
 * The orchestration of the legacy import, free of transport: the host wires
 * these two interfaces to dispatches of `WorkspaceDO` (the reader) and
 * `WorkspaceStateDO` (the importer), tests wire them to instances.
 *
 * Every step is idempotent and the importer holds all the progress, so a crash
 * anywhere resumes by running the driver again: staging re-sends pages the
 * importer already holds (its rows are keyed by the legacy rowid), the replay
 * continues at its applied count, and the finish is repeatable until it
 * verifies. Nothing is ever deleted from the retired store.
 */
import {
  type LegacyImportTable,
  type LegacyManifest,
  type LegacyRow,
} from "./legacyImport.js";

export interface LegacyStoreReader {
  legacyManifest(): Promise<LegacyManifest>;
  legacyReadRows(input: { table: LegacyImportTable; afterRowid: number; limit: number }): Promise<{
    rows: Array<{ rowid: number; row: LegacyRow }>;
    done: boolean;
  }>;
}

export interface LegacyImportStatus {
  phase: "none" | "staging" | "replaying" | "verified" | "skipped" | "adopted";
  staged: Record<string, number>;
  applied: number;
  total: number;
  manifestDigest: string | null;
}

export interface LegacyStoreImporter {
  legacyImportStatus(): Promise<LegacyImportStatus>;
  legacyImportSkip(): Promise<LegacyImportStatus>;
  legacyImportBegin(manifest: LegacyManifest): Promise<LegacyImportStatus>;
  legacyImportStage(input: {
    table: LegacyImportTable;
    rows: Array<{ rowid: number; row: LegacyRow }>;
  }): Promise<number>;
  legacyImportReplay(input: {
    budgetMs: number;
    maxEvents?: number;
  }): Promise<{ applied: number; total: number; done: boolean }>;
  legacyImportFinish(manifest: LegacyManifest): Promise<LegacyImportStatus>;
}

export type LegacyImportOutcome = "settled" | "skipped" | "imported";

export async function importLegacyWorkspaceState(deps: {
  legacy: LegacyStoreReader;
  target: LegacyStoreImporter;
  log?: (message: string) => void;
  /** Rows per staging page. */
  pageRows?: number;
  /** Time one replay call may spend before it reports progress. */
  budgetMs?: number;
  /** Events one replay call may apply before it reports progress. */
  maxEvents?: number;
}): Promise<{ outcome: LegacyImportOutcome; status: LegacyImportStatus }> {
  const log = deps.log ?? (() => undefined);
  const pageRows = deps.pageRows ?? 250;
  const budgetMs = deps.budgetMs ?? 10_000;
  const { legacy, target } = deps;

  const settled = (status: LegacyImportStatus) =>
    status.phase === "verified" || status.phase === "skipped" || status.phase === "adopted";
  let status = await target.legacyImportStatus();
  if (settled(status)) return { outcome: "settled", status };

  const manifest = await legacy.legacyManifest();
  if (!manifest.present) {
    status = await target.legacyImportSkip();
    log("Workspace state: no retired SQLite store, nothing to import");
    return { outcome: "skipped", status };
  }

  status = await target.legacyImportBegin(manifest);
  if (settled(status)) return { outcome: "settled", status };
  log(
    `Workspace state: importing the retired SQLite store (${manifest.tables
      .map((table) => `${table.name} ${table.rows}`)
      .join(", ")})`
  );

  if (status.phase === "staging") {
    for (const expected of manifest.tables) {
      if (expected.rows === 0 || (status.staged[expected.name] ?? 0) >= expected.rows) continue;
      let afterRowid = 0;
      for (;;) {
        const page = await legacy.legacyReadRows({
          table: expected.name,
          afterRowid,
          limit: pageRows,
        });
        if (page.rows.length > 0) {
          await target.legacyImportStage({ table: expected.name, rows: page.rows });
          afterRowid = page.rows[page.rows.length - 1]!.rowid;
        }
        if (page.done) break;
      }
    }
  }

  for (;;) {
    const progress = await target.legacyImportReplay({
      budgetMs,
      ...(deps.maxEvents ? { maxEvents: deps.maxEvents } : {}),
    });
    if (progress.done) {
      log(`Workspace state: replayed ${progress.total} events into commits`);
      break;
    }
    log(`Workspace state: replayed ${progress.applied} of ${progress.total} events`);
  }

  // The source must be as it was when staging began; the importer proves its
  // own tables against the manifest it was begun with.
  const again = await legacy.legacyManifest();
  if (again.digest !== manifest.digest) {
    throw new Error(
      "The retired workspace store changed while it was being imported; start the server again to import it afresh"
    );
  }
  status = await target.legacyImportFinish(manifest);
  log("Workspace state: import verified; the retired SQLite store is left in place");
  return { outcome: "imported", status };
}
