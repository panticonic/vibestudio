import type {
  BrowserImportDataType,
  ImportCategoryBreakdown,
} from "@vibestudio/browser-data";

/** Buckets listed individually in a preview breakdown; the rest is summarized. */
export const BREAKDOWN_GROUP_LIMIT = 12;

/**
 * Bucket a category's readable items so the migration UI can show what an import
 * actually contains before writing anything. Buckets are counts over keys the
 * user can already see in their own browser UI (site hosts, autofill field
 * names, search-engine names) — never values, usernames, or secrets.
 */
export function computeCategoryBreakdown(
  dataType: BrowserImportDataType,
  items: readonly unknown[],
  limit = BREAKDOWN_GROUP_LIMIT
): ImportCategoryBreakdown {
  const groupedBy = dataType === "formFill" || dataType === "searchEngines" ? "kind" : "site";
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = breakdownLabel(dataType, item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ordered = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const tail = ordered.slice(limit);
  return {
    dataType,
    groupedBy,
    total: items.length,
    groups: ordered.slice(0, limit),
    otherGroups: tail.length,
    otherItems: tail.reduce((sum, group) => sum + group.count, 0),
  };
}

function breakdownLabel(dataType: BrowserImportDataType, item: unknown): string {
  const record = (item ?? {}) as Record<string, unknown>;
  switch (dataType) {
    case "cookies":
      return hostLabel(typeof record["domain"] === "string" ? record["domain"] : "");
    case "formFill":
      if (typeof record["type"] === "string" && record["type"]) return record["type"];
      if (typeof record["fieldName"] === "string" && record["fieldName"]) {
        return record["fieldName"];
      }
      return "other";
    case "searchEngines":
      return typeof record["name"] === "string" && record["name"] ? record["name"] : "unnamed";
    case "favicons":
      return hostFromUrl(
        typeof record["pageUrl"] === "string"
          ? record["pageUrl"]
          : typeof record["url"] === "string"
            ? record["url"]
            : ""
      );
    default:
      return hostFromUrl(typeof record["url"] === "string" ? record["url"] : "");
  }
}

function hostFromUrl(url: string): string {
  if (!url) return "unknown";
  try {
    return hostLabel(new URL(url).hostname) || url;
  } catch {
    return hostLabel(url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "");
  }
}

/** Normalize a cookie domain or hostname to a displayable site label. */
function hostLabel(host: string): string {
  const trimmed = host.trim().replace(/^\./, "").replace(/^www\./, "").toLowerCase();
  return trimmed || "unknown";
}
