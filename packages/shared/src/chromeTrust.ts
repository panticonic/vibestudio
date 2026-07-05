import { WORKSPACE_APP_PACKAGE_SCOPE } from "./workspace/types.js";

/**
 * Workspace app trust — which workspace apps may render host chrome
 * (panel-hosting) and which may manage connections (pairing invites).
 *
 * The grants are NOT hardcoded here. They come from the workspace manifest
 * (`workspace/meta/vibestudio.yml` → `trust.chromeApps` /
 * `trust.connectionManagementApps`), which is an approval-gated meta write —
 * so trust changes ride the existing main-advance approval flow.
 *
 * Seeding: `loadWorkspaceConfig` (workspace/loader.ts) seeds this process-wide
 * registry whenever a workspace manifest is loaded from disk, and the server
 * re-seeds explicitly at startup and on every meta-change reload. Any process
 * that owns a workspace manifest therefore enforces the declared lists
 * strictly: an app source not listed is refused, and an absent `trust`
 * section means NO app is authorized (no hardcoded fallback).
 *
 * Deferred mode: a pure client process that never loads a manifest (e.g. an
 * Electron shell attached to a REMOTE server) has no trust root of its own —
 * every capability it sees was already filtered against the manifest by the
 * server (`AppHost.hasAppCapability`). In that state the source check defers
 * to that server-granted capability (returns true) and logs once. All local
 * call sites conjoin this check with a server-granted capability flag, so
 * deferring never widens access beyond what the manifest-enforcing host
 * granted.
 */
export interface WorkspaceAppTrustGrants {
  /** Canonical `apps/<name>` repo paths allowed to render host chrome. */
  chromeApps: readonly string[];
  /** Canonical `apps/<name>` repo paths allowed to manage connections. */
  connectionManagementApps: readonly string[];
}

interface TrustState {
  chrome: Set<string>;
  connectionManagement: Set<string>;
}

let processTrust: TrustState | null = null;
let warnedUnseeded = false;

/**
 * Seed (or replace) this process's workspace app trust grants from the
 * manifest. Pass `null` to clear (test-only). Sources are normalized to the
 * `apps/<name>` repo-path form.
 */
export function setWorkspaceAppTrust(grants: WorkspaceAppTrustGrants | null): void {
  if (grants === null) {
    processTrust = null;
    warnedUnseeded = false;
    return;
  }
  processTrust = {
    chrome: new Set(grants.chromeApps.map(normalizeAppSourcePath)),
    connectionManagement: new Set(
      grants.connectionManagementApps.map(normalizeAppSourcePath)
    ),
  };
}

/** True once a workspace manifest's trust grants have been seeded. */
export function hasWorkspaceAppTrust(): boolean {
  return processTrust !== null;
}

function deferToHostGrant(check: string): boolean {
  if (!warnedUnseeded) {
    warnedUnseeded = true;
    console.warn(
      `[chromeTrust] ${check} checked before any workspace manifest was loaded in this process — ` +
        `deferring to the server-granted capability (the server enforces meta/vibestudio.yml trust.*).`
    );
  }
  return true;
}

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

  if (callerId.startsWith(WORKSPACE_APP_PACKAGE_SCOPE)) {
    return normalizeAppSourcePath(`apps/${callerId.slice(WORKSPACE_APP_PACKAGE_SCOPE.length)}`);
  }

  if (callerId.startsWith("apps/") || callerId.startsWith("workspace/apps/")) {
    return normalizeAppSourcePath(callerId);
  }

  return null;
}

export function isAuthorizedChromeAppSource(source: string | null | undefined): boolean {
  if (!source) return false;
  if (!processTrust) return deferToHostGrant("chrome app trust");
  return processTrust.chrome.has(normalizeAppSourcePath(source));
}

export function isAuthorizedConnectionManagementAppSource(
  source: string | null | undefined
): boolean {
  if (!source) return false;
  if (!processTrust) return deferToHostGrant("connection-management app trust");
  return processTrust.connectionManagement.has(normalizeAppSourcePath(source));
}

export function isAuthorizedChromeAppCaller(callerId: string, source?: string | null): boolean {
  return isAuthorizedChromeAppSource(source ?? appSourceFromCallerId(callerId));
}
