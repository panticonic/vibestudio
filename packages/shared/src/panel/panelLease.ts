import type { PanelEntityId, PanelSlotId } from "./ids.js";

export type ClientPlatform = "desktop" | "mobile";

export interface ClientSession {
  clientSessionId: string;
  label: string;
  platform: ClientPlatform;
  connectedAt: number;
  lastSeenAt: number;
}

export interface RuntimeLeaseVersion {
  epoch: string;
  counter: number;
}

export interface PanelRuntimeLease {
  slotId: PanelSlotId;
  runtimeEntityId: PanelEntityId;
  clientSessionId: string;
  connectionId: string;
  holderLabel: string;
  platform: ClientPlatform;
  acquiredAt: number;
  expiresAt?: number;
}

export interface RuntimeLeaseSnapshot {
  version: RuntimeLeaseVersion;
  leases: PanelRuntimeLease[];
}

export type PanelRuntimeLeaseChangedReason =
  | "acquired"
  | "released"
  | "revoked"
  | "expired"
  | "retired";

export interface PanelRuntimeLeaseChangedEvent {
  type: "panel:runtimeLeaseChanged";
  version: RuntimeLeaseVersion;
  slotId: PanelSlotId;
  runtimeEntityId: PanelEntityId;
  previous: PanelRuntimeLease | null;
  next: PanelRuntimeLease | null;
  reason: PanelRuntimeLeaseChangedReason;
}

export type PanelRuntimeAcquireResult =
  | { acquired: true; lease: PanelRuntimeLease }
  | { acquired: false; lease: PanelRuntimeLease };
