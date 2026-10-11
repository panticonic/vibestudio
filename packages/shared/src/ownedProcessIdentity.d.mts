export interface OwnedProcessIdentity {
  version: 1;
  platform: "linux" | "darwin";
  pid: number;
  processGroupId: number;
  startCoordinate: string;
}
export type OwnedProcessObservation = "owned" | "absent" | "unknown";
export type OwnedProcessGroupObservation = OwnedProcessObservation | "retained";
export interface OwnedProcessGroupMember {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  state: string;
  command: string;
}
export interface OwnedProcessGroupSnapshot {
  members: OwnedProcessGroupMember[];
  truncated: boolean;
  commandBasenameTruncated: boolean;
}
export interface OwnedProcessGroupObservationReceipt {
  status: OwnedProcessGroupObservation;
  activeMemberCount: number;
  leader: {
    status: "matched" | "exited" | "missing" | "reused" | "unknown";
    current?: {
      pid: number;
      processGroupId: number;
      startCoordinate?: string;
      state: string;
    };
  };
  snapshot: OwnedProcessGroupSnapshot;
}
export function parseOwnedProcessIdentity(value: unknown): OwnedProcessIdentity;
export function captureOwnedProcessIdentity(pid: number): OwnedProcessIdentity;
export function ownedProcessFailure(
  cause: unknown,
  identity: OwnedProcessIdentity | null,
  observation?: OwnedProcessGroupObservationReceipt
): Error & {
  code: "EOWNERSHIP";
  ownedProcessIdentity: OwnedProcessIdentity | null;
  ownedProcessGroupObservation?: OwnedProcessGroupObservationReceipt;
};
export function observeOwnedProcessGroup(
  identity: OwnedProcessIdentity
): OwnedProcessGroupObservation;
export function observeOwnedProcessGroupReceipt(
  identity: OwnedProcessIdentity
): OwnedProcessGroupObservationReceipt;
export function observeOwnedProcess(identity: OwnedProcessIdentity): OwnedProcessObservation;
export function signalOwnedProcessIdentity(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals,
  options?: {
    observeGroup?: () => OwnedProcessGroupObservationReceipt;
    signalGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  }
): void;

export function ownedProcessDescendsFrom(rootPid: number, candidatePid: number): boolean;
