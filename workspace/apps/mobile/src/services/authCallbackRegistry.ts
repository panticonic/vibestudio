/**
 * Bookkeeping for in-flight client-owned OAuth flows on mobile.
 *
 * The desktop client binds an ephemeral loopback HTTP server per login
 * attempt and parks the awaiting promise on it. Mobile uses the
 * app-identity-bound universal-link / Android App Link callback and routes
 * incoming deep-links by `state`.
 *
 * `oauthHandler.ts` reads from this registry on every incoming
 * callback link; `codexAuthFlow.ts` writes pending entries before opening
 * the browser. Keep the table in module scope so cold-start deep-links
 * (Linking.getInitialURL) can still find their flow after the app re-mounts.
 */

export interface PendingAuthFlow {
  resolve: (params: { code: string; state: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingAuthFlow>();

export function registerPendingFlow(state: string, flow: PendingAuthFlow): void {
  pending.set(state, flow);
}

export function consumePendingFlow(state: string): PendingAuthFlow | undefined {
  const entry = pending.get(state);
  if (entry) pending.delete(state);
  return entry;
}

export function dropPendingFlow(state: string): void {
  pending.delete(state);
}
