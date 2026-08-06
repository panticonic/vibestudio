import { useCallback, useMemo, useRef, useState } from "react";
import type { TemplateOperation, TemplateStatusRow } from "@vibestudio/service-schemas/templates";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";
import type { TemplateManagementClient, TemplatePendingOperation } from "./index.js";

export type TemplateLifecycleClient = Pick<
  TemplateManagementClient,
  "status" | "operations" | "catalog" | "check"
>;

export type { TemplatePendingOperation } from "./index.js";

export interface TemplateExecution<T> {
  key: string;
  task: () => Promise<T>;
  success: (result: T) => string;
  failure: (error: unknown) => string;
}

export interface TemplateManagementController {
  rows: TemplateStatusRow[];
  operations: TemplatePendingOperation[];
  catalog: TemplateCatalogSnapshot | null;
  loading: boolean;
  notice: string | null;
  error: string | null;
  anyBusy: boolean;
  isBusy(key: string): boolean;
  setNotice(notice: string | null): void;
  refresh(options?: { refreshCatalog?: boolean; preserveOutcome?: boolean }): Promise<boolean>;
  execute<T>(execution: TemplateExecution<T>): Promise<T | null>;
  complete(operation: TemplateOperation, notice: string): Promise<void>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTemplateManagementController(
  client: TemplateLifecycleClient
): TemplateManagementController {
  const [rows, setRows] = useState<TemplateStatusRow[]>([]);
  const [allOperations, setAllOperations] = useState<TemplatePendingOperation[]>([]);
  const [catalog, setCatalog] = useState<TemplateCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const activeKeys = useRef(new Set<string>());
  const refreshGeneration = useRef(0);

  const refresh = useCallback(
    async (options: { refreshCatalog?: boolean; preserveOutcome?: boolean } = {}) => {
      const generation = ++refreshGeneration.current;
      setLoading(true);
      if (!options.preserveOutcome) {
        setNotice(null);
        setError(null);
      }
      try {
        const [initialRows, nextOperations] = await Promise.all([
          client.status(),
          client.operations(),
        ]);
        let nextCatalog: TemplateCatalogSnapshot | null = null;
        let catalogError: string | null = null;
        try {
          nextCatalog = await client.catalog(
            options.refreshCatalog ? { refresh: true } : undefined
          );
        } catch (failure) {
          catalogError = `The verified template registry is unavailable. ${failureMessage(failure)}`;
        }

        let displayedRows = initialRows;
        let candidates: Array<{ alias: string }> = [];
        try {
          candidates = await client.check();
          // Check may re-anchor copied template pins for this host session.
          // Render the resulting local observation, never the pre-check snapshot.
          displayedRows = await client.status();
        } catch {
          // Remote update discovery is optional. The copied relationships stay
          // usable and retain their truthful deferred-verification state.
        }
        // A newer refresh owns the projection now. Its result is the relevant
        // observation for every concurrently completed mutation, so an older
        // refresh being superseded is not itself a refresh failure.
        if (refreshGeneration.current !== generation) return true;

        const updates = new Set(candidates.map((candidate) => candidate.alias));
        setRows(
          displayedRows.map((row) =>
            updates.has(row.alias) && row.state === "current"
              ? { ...row, state: "update-available" as const }
              : row
          )
        );
        setAllOperations(nextOperations);
        setCatalog(nextCatalog);
        setError(catalogError);
        return true;
      } catch (failure) {
        if (refreshGeneration.current !== generation) return true;
        setError(`Couldn't refresh template status. ${failureMessage(failure)}`);
        return false;
      } finally {
        if (refreshGeneration.current === generation) setLoading(false);
      }
    },
    [client]
  );

  const execute = useCallback(
    async <T>({ key, task, success, failure }: TemplateExecution<T>): Promise<T | null> => {
      if (activeKeys.current.has(key)) return null;
      activeKeys.current.add(key);
      setBusyKeys(new Set(activeKeys.current));
      setError(null);
      try {
        const result = await task();
        const outcome = success(result);
        setNotice(outcome);
        const refreshed = await refresh({ preserveOutcome: true });
        if (!refreshed) {
          setNotice(outcome);
          setError("The operation succeeded, but template status couldn't be refreshed.");
        }
        return result;
      } catch (caught) {
        setError(failure(caught));
        return null;
      } finally {
        activeKeys.current.delete(key);
        setBusyKeys(new Set(activeKeys.current));
      }
    },
    [refresh]
  );

  const complete = useCallback(
    async (_operation: TemplateOperation, outcome: string) => {
      setNotice(outcome);
      const refreshed = await refresh({ preserveOutcome: true });
      if (!refreshed) {
        setNotice(outcome);
        setError("The operation succeeded, but template status couldn't be refreshed.");
      }
    },
    [refresh]
  );

  const attachedOperationIds = useMemo(
    () => new Set(rows.flatMap((row) => (row.review ? [row.review.operationId] : []))),
    [rows]
  );
  const operations = useMemo(
    () => allOperations.filter((operation) => !attachedOperationIds.has(operation.operationId)),
    [allOperations, attachedOperationIds]
  );

  return {
    rows,
    operations,
    catalog,
    loading,
    notice,
    error,
    anyBusy: busyKeys.size > 0,
    isBusy: (key) => busyKeys.has(key),
    setNotice,
    refresh,
    execute,
    complete,
  };
}
