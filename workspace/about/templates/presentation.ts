import type { TemplateStatusRow } from "@vibestudio/service-schemas/templates";

export function templateVersion(ref: string): string {
  return ref.split("/").filter(Boolean).at(-1) || ref;
}

/** Inherited templates are visible context, never independently managed roots. */
export function templateRelationshipActions(direct: boolean): {
  check: boolean;
  update: boolean;
  remove: boolean;
  suggest: boolean;
} {
  return { check: direct, update: direct, remove: direct, suggest: direct };
}

export function templateStatePresentation(row: TemplateStatusRow): {
  label: string;
  color: "green" | "blue" | "orange" | "red" | "gray";
} {
  switch (row.state) {
    case "current":
      return { label: "Up to date", color: "green" };
    case "update-available":
      return { label: "Update available", color: "blue" };
    case "reviewing":
      return {
        label: row.pendingReviews
          ? `Reviewing changes — ${row.pendingReviews} to review`
          : "Reviewing changes",
        color: "blue",
      };
    case "local-changes":
      return { label: "Local changes", color: "orange" };
    case "waiting-for-credential":
    case "conflict":
    case "error":
      return { label: "Needs attention", color: "red" };
  }
}
