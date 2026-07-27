/**
 * Pure formatting + error helpers for the Browser Migration & State panel.
 * Kept free of `@workspace/runtime` imports so they are unit-testable in a plain
 * Node/vitest environment (no panel runtime required).
 */

export type AsyncStatus = "idle" | "loading" | "ready" | "denied" | "error";

export interface AsyncState<T> {
  status: AsyncStatus;
  data?: T;
  error?: string;
}

interface ErrnoLike {
  code?: string;
  message?: string;
}

export function classifyError(err: unknown): { status: "denied" | "error"; message: string } {
  const e = err as ErrnoLike;
  const message = e?.message ?? String(err);
  const denied =
    e?.code === "EACCES" || /denied by user/i.test(message) || /\bEACCES\b/.test(message);
  return { status: denied ? "denied" : "error", message };
}

export function relativeTime(ms: number | null | undefined, now: number): string {
  if (!ms) return "never";
  const delta = now - ms;
  if (delta < 0) return "just now";
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function mask(value: string, revealed: boolean): string {
  if (revealed) return value;
  if (!value) return "";
  return "•".repeat(Math.min(12, Math.max(4, value.length)));
}

export const DATA_TYPES: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: "bookmarks", label: "Bookmarks", hint: "Folders and saved links" },
  { key: "history", label: "History", hint: "Visited pages and visit counts" },
  { key: "cookies", label: "Cookies", hint: "Keeps you signed in to sites" },
  { key: "passwords", label: "Passwords", hint: "Saved logins, stored encrypted" },
  { key: "formFill", label: "Form fill", hint: "Addresses and autofill entries" },
  { key: "searchEngines", label: "Search engines", hint: "Keyword shortcuts and defaults" },
  { key: "favicons", label: "Favicons", hint: "Site icons for bookmarks and history" },
];

/**
 * Host without `www.`. Hostless URLs (`about:newtab`, `file:///…`) and
 * unparseable strings fall back to the raw value so the row still reads.
 */
export function prettyHost(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname || url;
  } catch {
    return url.replace(/^[a-z]+:\/\//, "").split("/")[0] || url;
  }
}

/** Path + query of a URL, or "" for a bare origin or a hostless URL. */
export function prettyPath(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return "";
    const rest = `${parsed.pathname}${parsed.search}`;
    return rest === "/" ? "" : rest;
  } catch {
    return "";
  }
}

/**
 * Deterministic hue for a string, so a site keeps the same accent colour every
 * render (and across sessions) without any network fetch for a real favicon.
 */
export function hueFor(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

/** One or two letters to stand in for a site icon. */
export function initialsFor(host: string): string {
  const label = host.split(".")[0] ?? host;
  if (!label) return "?";
  const parts = label.split(/[-_]/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

/** "3 tabs" / "1 tab" — small enough to inline, common enough to share. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
