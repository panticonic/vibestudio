import * as fs from "node:fs";
import * as path from "node:path";
import { stateLayout } from "./stateLayout.js";

export const RUNTIME_FOUNDATION_FORMAT_VERSION = 2 as const;

export interface RuntimeFoundationResetCategory {
  id: string;
  description: string;
  paths: string[];
}

interface RuntimeFoundationFormatRecord {
  version: typeof RUNTIME_FOUNDATION_FORMAT_VERSION;
  establishedAt: string;
}

export class IncompatibleRuntimeFoundationStateError extends Error {
  readonly code = "RUNTIME_FOUNDATION_STATE_INCOMPATIBLE";

  constructor(
    readonly statePath: string,
    readonly reason: string,
    readonly categories: RuntimeFoundationResetCategory[]
  ) {
    super(renderRuntimeFoundationDiagnostic(statePath, reason, categories));
    this.name = "IncompatibleRuntimeFoundationStateError";
  }
}

/**
 * The cutover owns only reconstructable runtime products and foundation
 * metadata. Refs, blobs, context work, Git operation journals, credentials,
 * audit logs, browser profiles, and Durable Object databases are deliberately
 * absent: those contain source, content, recovery state, or user data.
 */
export function runtimeFoundationResetCategories(
  statePath: string
): RuntimeFoundationResetCategory[] {
  const layout = stateLayout(path.resolve(statePath));
  return [
    {
      id: "authority",
      description: "saved runtime and unit approvals",
      paths: [
        layout.capabilityGrantsFile,
        layout.userlandApprovalGrantsFile,
        layout.credentialUseGrantsFile,
        layout.units.metaApprovalGrantsFile,
      ],
    },
    {
      id: "runtime-selection",
      description: "runtime incarnations, target selections, and regenerated product seeds",
      paths: [
        layout.runtimeIncarnationsFile,
        layout.hostTargetSelectionsFile,
        layout.ownerPanelSeedsDir,
        layout.productBootManifestFile,
        layout.bootGenerationFile,
      ],
    },
    {
      id: "derived-artifacts",
      description: "build caches and immutable execution materializations",
      paths: [
        layout.buildsDir,
        layout.buildSourcesDir,
        layout.executionArtifactsDir,
        layout.executionSnapshotsDir,
        layout.sourceClosureStateFile,
      ],
    },
    {
      id: "diagnostics",
      description: "rebuildable runtime diagnostics",
      paths: [layout.runtimeDiagnosticsDir],
    },
  ];
}

/**
 * Establish the current format for a clean/current workspace or fail before
 * any service consumes a mixed-format foundation store.
 */
export function ensureRuntimeFoundationStateCompatible(statePath: string): void {
  const resolved = path.resolve(statePath);
  const layout = stateLayout(resolved);
  const categories = runtimeFoundationResetCategories(resolved);
  const marker = readJson(layout.runtimeFoundationFormatFile);

  if (marker !== null) {
    if (!isCurrentFormatRecord(marker)) {
      throw new IncompatibleRuntimeFoundationStateError(
        resolved,
        `expected runtime-foundation format ${RUNTIME_FOUNDATION_FORMAT_VERSION}`,
        categories
      );
    }
    return;
  }

  // The canonical authority grant store is the unambiguous R3 cutover
  // sentinel. Its pre-cutover shape was { grants } and cannot safely be read as
  // compositional AuthorityGrant records.
  const capabilityStore = readJson(layout.capabilityGrantsFile);
  if (
    capabilityStore !== null &&
    (!isRecord(capabilityStore) || capabilityStore["version"] !== RUNTIME_FOUNDATION_FORMAT_VERSION)
  ) {
    throw new IncompatibleRuntimeFoundationStateError(
      resolved,
      "found a pre-R3 capability grant store",
      categories
    );
  }

  writeFormatRecord(layout.runtimeFoundationFormatFile);
}

export interface RuntimeFoundationResetResult {
  statePath: string;
  formatVersion: typeof RUNTIME_FOUNDATION_FORMAT_VERSION;
  reset: Array<{ id: string; description: string; removed: string[] }>;
  preserved: string[];
}

export function resetRuntimeFoundationState(statePath: string): RuntimeFoundationResetResult {
  const resolved = path.resolve(statePath);
  const layout = stateLayout(resolved);
  assertRuntimeOffline(layout.serverReadyFile);
  const categories = runtimeFoundationResetCategories(resolved);
  const reset = categories.map((category) => {
    const removed = category.paths.filter((entry) => fs.existsSync(entry));
    for (const entry of removed) fs.rmSync(entry, { recursive: true, force: true });
    return { id: category.id, description: category.description, removed };
  });
  // A stale ready file contains credentials and must not survive an explicit
  // offline reset. A live owner was rejected above.
  fs.rmSync(layout.serverReadyFile, { force: true });
  writeFormatRecord(layout.runtimeFoundationFormatFile);
  return {
    statePath: resolved,
    formatVersion: RUNTIME_FOUNDATION_FORMAT_VERSION,
    reset,
    preserved: [
      layout.refsDir,
      layout.blobsDir,
      layout.contextsDir,
      layout.databases.root,
      layout.gitImportJournalFile,
      layout.disposableGitRemotesDir,
      layout.credentialsAuditDir,
      layout.webrtc.root,
      layout.logsDir,
    ],
  };
}

function assertRuntimeOffline(readyFile: string): void {
  const ready = readJson(readyFile);
  if (!isRecord(ready) || !Number.isInteger(ready["pid"])) return;
  const pid = Number(ready["pid"]);
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code !== "EPERM") throw error;
  }
  throw new Error(
    `Workspace runtime is still running as PID ${pid}. Stop it before resetting ${path.dirname(
      readyFile
    )}.`
  );
}

function renderRuntimeFoundationDiagnostic(
  statePath: string,
  reason: string,
  categories: RuntimeFoundationResetCategory[]
): string {
  const categoryText = categories
    .map((category) => `  - ${category.id}: ${category.description}`)
    .join("\n");
  return [
    `Runtime foundation state is incompatible (${reason}).`,
    `State directory: ${statePath}`,
    "The scoped reset will recreate:",
    categoryText,
    "Workspace refs, blobs, context work, databases, credentials, Git recovery journals, and logs are preserved.",
    `After stopping this workspace runtime, run: vibestudio runtime-foundations reset --state-path ${JSON.stringify(
      statePath
    )} --confirm`,
  ].join("\n");
}

function writeFormatRecord(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record: RuntimeFoundationFormatRecord = {
    version: RUNTIME_FOUNDATION_FORMAT_VERSION,
    establishedAt: new Date().toISOString(),
  };
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new IncompatibleRuntimeFoundationStateError(
      path.dirname(filePath),
      `could not read ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      runtimeFoundationResetCategories(path.dirname(filePath))
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrentFormatRecord(value: unknown): value is RuntimeFoundationFormatRecord {
  return (
    isRecord(value) &&
    value["version"] === RUNTIME_FOUNDATION_FORMAT_VERSION &&
    typeof value["establishedAt"] === "string"
  );
}
