import { app } from "electron";
import * as path from "path";
import { type ConnectPairing, parseConnectLink } from "@vibestudio/shared/connect";
import { parsePanelLocationLink, type PanelLocation } from "@vibestudio/shared/panelLocation";

/** The WebRTC pairing material carried by a `vibestudio://connect` deep link. */
export type PendingConnectLink = ConnectPairing;

let pending: PendingConnectLink | null = null;
const listeners = new Set<(link: PendingConnectLink) => void>();
let pendingPanel: PanelLocation | null = null;
const panelListeners = new Set<(location: PanelLocation) => void>();

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
    enqueueProtocolLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    enqueueFirstArgvLink(argv);
  });
}

export function enqueueFirstArgvLink(argv: readonly string[]): void {
  const raw = argv.find((arg) => typeof arg === "string" && arg.startsWith("vibestudio://"));
  if (raw) enqueueProtocolLink(raw);
}

export function enqueueProtocolLink(raw: string): void {
  const panel = parsePanelLocationLink(raw);
  if (panel.kind === "ok") {
    pendingPanel = panel.location;
    for (const listener of panelListeners) listener(panel.location);
    return;
  }
  enqueueConnectLink(raw);
}

export function enqueueConnectLink(raw: string): void {
  const parsed = parseConnectLink(raw);
  if (parsed.kind === "error") return;
  const { kind: _kind, ...link } = parsed;
  pending = link;
  for (const listener of listeners) listener(link);
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

export function getPendingPanelLocation(): PanelLocation | null {
  const location = pendingPanel;
  pendingPanel = null;
  return location;
}

export function peekPendingPanelLocation(): PanelLocation | null {
  return pendingPanel;
}

export function onPanelLocation(listener: (location: PanelLocation) => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}
