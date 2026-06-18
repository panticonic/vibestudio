export const AUTHORIZED_CHROME_APP_SOURCES = ["apps/shell", "apps/mobile"] as const;
export const AUTHORIZED_CONNECTION_MANAGEMENT_APP_SOURCES = [
  "apps/shell",
  "apps/remote-cli",
] as const;

const authorizedChromeSourceSet = new Set<string>(AUTHORIZED_CHROME_APP_SOURCES);
const authorizedConnectionManagementSourceSet = new Set<string>(
  AUTHORIZED_CONNECTION_MANAGEMENT_APP_SOURCES
);

export function normalizeAppSourcePath(source: string): string {
  return source
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\/+$/, "");
}

export function appSourceFromCallerId(callerId: string): string | null {
  const deviceScoped = /^app:([^:]+):/.exec(callerId);
  if (deviceScoped?.[1]) return normalizeAppSourcePath(deviceScoped[1]);

  const workspaceApp = /^@workspace-apps\/(.+)$/.exec(callerId);
  if (workspaceApp?.[1]) return normalizeAppSourcePath(`apps/${workspaceApp[1]}`);

  if (callerId.startsWith("apps/") || callerId.startsWith("workspace/apps/")) {
    return normalizeAppSourcePath(callerId);
  }

  return null;
}

export function isAuthorizedChromeAppSource(source: string | null | undefined): boolean {
  return !!source && authorizedChromeSourceSet.has(normalizeAppSourcePath(source));
}

export function isAuthorizedConnectionManagementAppSource(
  source: string | null | undefined
): boolean {
  return !!source && authorizedConnectionManagementSourceSet.has(normalizeAppSourcePath(source));
}

export function isAuthorizedChromeAppCaller(callerId: string, source?: string | null): boolean {
  return isAuthorizedChromeAppSource(source ?? appSourceFromCallerId(callerId));
}
