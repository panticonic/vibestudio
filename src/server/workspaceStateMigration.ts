/**
 * The one-time move of a workspace's state from the retired SQLite store
 * (`WorkspaceDO`) into the Dolt store that replaced it (`WorkspaceStateDO`).
 * docs/dolt-redesign.md §9.2. The work is `importLegacyWorkspaceState`; this
 * file is the host's part: it makes every call to the new store wait for the
 * move, and wires the two classes to the driver.
 *
 * The first call to the Dolt store starts the move; every concurrent call waits
 * for it. A failure fails those calls (and so the start that needs the store)
 * and is not remembered: the next call resumes where the importer stopped. A
 * workspace the move already settled costs one status call on its first use.
 */
import {
  importLegacyWorkspaceState,
  type LegacyImportOutcome,
  type LegacyStoreImporter,
  type LegacyStoreReader,
} from "@panticonic/builtin/workspace-state";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

export const WORKSPACE_STATE_CLASS = "WorkspaceStateDO";
/** The retired SQLite class, deployed for one release as the import's source. */
export const LEGACY_WORKSPACE_CLASS = "WorkspaceDO";

type Dispatch = (ref: DORef, method: string, ...args: unknown[]) => Promise<unknown>;

export function createWorkspaceStateMigration(deps: {
  workspaceId: string;
  /** Dispatches to an internal object without waiting for this migration. */
  dispatch: Dispatch;
  log?: (message: string) => void;
}) {
  const ref = (className: string): DORef => ({
    source: INTERNAL_DO_SOURCE,
    className,
    objectKey: deps.workspaceId,
  });
  const call =
    (className: string, method: string) =>
    (...args: unknown[]) =>
      deps.dispatch(ref(className), method, ...args);

  const legacy = {
    legacyManifest: call(LEGACY_WORKSPACE_CLASS, "legacyManifest"),
    legacyReadRows: call(LEGACY_WORKSPACE_CLASS, "legacyReadRows"),
  } as unknown as LegacyStoreReader;
  const target = Object.fromEntries(
    [
      "legacyImportStatus",
      "legacyImportSkip",
      "legacyImportBegin",
      "legacyImportStage",
      "legacyImportReplay",
      "legacyImportFinish",
    ].map((method) => [method, call(WORKSPACE_STATE_CLASS, method)])
  ) as unknown as LegacyStoreImporter;

  let running: Promise<LegacyImportOutcome> | null = null;
  let settled = false;

  const run = (): Promise<LegacyImportOutcome> => {
    running ??= importLegacyWorkspaceState({
      legacy,
      target,
      ...(deps.log ? { log: deps.log } : {}),
    })
      .then(({ outcome }) => {
        settled = true;
        return outcome;
      })
      .catch((error: unknown) => {
        running = null;
        throw error;
      });
    return running;
  };

  return {
    run,
    /** What a dispatch to `target` awaits before it goes out; `undefined` when nothing is owed. */
    readyFor(target: DORef): Promise<unknown> | undefined {
      if (settled) return undefined;
      if (target.source !== INTERNAL_DO_SOURCE || target.className !== WORKSPACE_STATE_CLASS) {
        return undefined;
      }
      return run();
    },
  };
}

export type WorkspaceStateMigration = ReturnType<typeof createWorkspaceStateMigration>;
