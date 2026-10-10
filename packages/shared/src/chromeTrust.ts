/** Manifest-owned grants used explicitly by the workspace that admitted the app. */
export interface WorkspaceAppTrustGrants {
  /** Canonical `apps/<name>` repo paths allowed to render host chrome. */
  chromeApps: readonly string[];
}

export function normalizeAppSourcePath(source: string): string {
  return source
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\/+$/, "");
}

export function isAuthorizedChromeAppSource(
  source: string | null | undefined,
  grants: WorkspaceAppTrustGrants
): boolean {
  if (!source) return false;
  const normalized = normalizeAppSourcePath(source);
  return grants.chromeApps.some((app) => normalizeAppSourcePath(app) === normalized);
}
