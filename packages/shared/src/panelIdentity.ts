/** Portable identifiers used by browser panel runtimes. */

/** Generate a contextId from a panelId. */
export function generateContextId(panelId: string): string {
  return `ctx-${panelId
    .replace(/[^a-z0-9]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 59)}`;
}

/** Derive a normalized source path for browser panels from a hostname. */
export function browserSourceFromHostname(hostname: string): string {
  return `browser~${hostname.replace(/[^a-z0-9.-]/gi, "-")}`;
}
