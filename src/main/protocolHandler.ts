import { app } from "electron";
import * as path from "path";
import { type ConnectPairing, parseConnectLink } from "@vibestudio/shared/connect";

/** The WebRTC pairing material carried by a `vibestudio://connect` deep link. */
export type PendingConnectLink = ConnectPairing;

let pending: PendingConnectLink | null = null;
const listeners = new Set<(link: PendingConnectLink) => void>();

/**
 * A deep link that FAILED to parse (e.g. a stale v1 link whose actionable message
 * is "re-pair with a current link"). Previously swallowed silently, so clicking a
 * stale link opened the app and nothing happened. Buffered like `pending` so a
 * launch-time failure survives until a surface exists to show it.
 */
let pendingError: string | null = null;
const errorListeners = new Set<(reason: string) => void>();

export function registerProtocol(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("vibestudio");
    return;
  }
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  app.setAsDefaultProtocolClient("vibestudio", process.execPath, entry ? [entry] : []);
}

export function installEarlyOpenUrlBuffer(): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    enqueueConnectLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    enqueueFirstArgvLink(argv);
  });
}

export function enqueueFirstArgvLink(argv: readonly string[]): void {
  const raw = argv.find((arg) => typeof arg === "string" && arg.startsWith("vibestudio://"));
  if (raw) enqueueConnectLink(raw);
}

export function enqueueConnectLink(raw: string): void {
  const parsed = parseConnectLink(raw);
  if (parsed.kind === "error") {
    // Surface it instead of swallowing: a stale/old-format link carries an
    // actionable message ("re-pair with a current link") the user must see.
    pendingError = parsed.reason;
    for (const listener of errorListeners) listener(parsed.reason);
    return;
  }
  pendingError = null;
  pending = stripKind(parsed);
  for (const listener of listeners) listener(pending);
}

function stripKind(
  parsed: Extract<ReturnType<typeof parseConnectLink>, { kind: "ok" }>
): PendingConnectLink {
  const { kind: _kind, ...rest } = parsed;
  return rest;
}

export function getPendingConnectLinkError(): string | null {
  const error = pendingError;
  pendingError = null;
  return error;
}

export function onConnectLinkError(listener: (reason: string) => void): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

export function getPendingConnectLink(): PendingConnectLink | null {
  const link = pending;
  pending = null;
  return link;
}

export function peekPendingConnectLink(): PendingConnectLink | null {
  return pending;
}

export function onConnectLink(listener: (link: PendingConnectLink) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
