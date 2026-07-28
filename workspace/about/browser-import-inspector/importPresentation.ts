import type { ImportJobSnapshot } from "@vibestudio/browser-data/client";

export type ImportJobPhase = ImportJobSnapshot["phase"];
export type ImportCategoryProgress = ImportJobSnapshot["progress"][number];

const TERMINAL_PHASES = new Set<ImportJobPhase>(["complete", "cancelled", "failed", "partial"]);

export function isTerminalImportPhase(phase: ImportJobPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isSuccessfulImportPhase(phase: ImportJobPhase): boolean {
  return phase === "complete" || phase === "partial";
}

export function shouldShowImportOptions(
  phase: ImportJobPhase | null,
  reimporting: boolean
): boolean {
  if (phase === null || reimporting) return true;
  return isTerminalImportPhase(phase) && !isSuccessfulImportPhase(phase);
}

export function isMigrationStepComplete(
  step: "data" | "tabs",
  dataImportComplete: boolean
): boolean {
  return step === "data" && dataImportComplete;
}

export interface ImportStatusPresentation {
  heading: string;
  badge: string;
  note?: string;
  color: "green" | "red" | "amber" | "blue";
}

export function importStatusPresentation(phase: ImportJobPhase): ImportStatusPresentation {
  switch (phase) {
    case "complete":
      return {
        heading: "Import complete",
        badge: "complete",
        note: "All selected browser data has been processed. Skipped records are part of the outcome, not work left to finish.",
        color: "green",
      };
    case "partial":
      return {
        heading: "Import completed with issues",
        badge: "partial",
        note: "The import has stopped and will not continue in the background. Review the errors and skipped counts below.",
        color: "amber",
      };
    case "failed":
      return {
        heading: "Import failed",
        badge: "failed",
        note: "The import has stopped. Review the error below before trying again.",
        color: "red",
      };
    case "cancelled":
      return {
        heading: "Import cancelled",
        badge: "cancelled",
        note: "The import has stopped. Counts below show what was processed before cancellation.",
        color: "amber",
      };
    default:
      return {
        heading: "Importing browser data",
        badge: phase,
        color: "blue",
      };
  }
}

export interface CategoryProgressPresentation {
  value?: number;
  processed: number;
  total?: number;
  label: string;
}

/**
 * Progress describes work processed, while stored/skipped/errors describe its
 * outcome. Keeping those dimensions separate prevents an intentional skip
 * from looking like unfinished work.
 */
export function categoryProgressPresentation(
  progress: ImportCategoryProgress,
  phase: ImportJobPhase
): CategoryProgressPresentation {
  if (isSuccessfulImportPhase(phase)) {
    // The provider's totalItems is the number of importable records, so it
    // deliberately excludes records rejected during normalization. A terminal
    // outcome must put those skipped/error records back into the considered
    // count instead of claiming (for example) "1086 of 29 processed".
    const processed =
      Math.max(progress.itemsProcessed, progress.stored) + progress.skipped + progress.errors;
    return {
      value: 100,
      processed,
      total: processed,
      label: `${processed} ${processed === 1 ? "record" : "records"} considered`,
    };
  }

  const processed = progress.itemsProcessed;
  const total = progress.totalItems;
  if (total === undefined) {
    return {
      processed,
      label: `${processed} processed`,
    };
  }

  return {
    value: total === 0 ? 100 : Math.min(100, Math.round((processed / total) * 100)),
    processed,
    total,
    label: `${processed} of ${total} processed`,
  };
}
