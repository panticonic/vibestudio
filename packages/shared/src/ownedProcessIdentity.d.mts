export interface OwnedProcessIdentity {
  version: 1;
  platform: "linux" | "darwin";
  pid: number;
  processGroupId: number;
  startCoordinate: string;
}
export type OwnedProcessObservation = "owned" | "absent" | "unknown";
export type OwnedProcessGroupObservation = OwnedProcessObservation | "retained";
export function parseOwnedProcessIdentity(value: unknown): OwnedProcessIdentity;
export function captureOwnedProcessIdentity(pid: number): OwnedProcessIdentity;
export function observeOwnedProcessGroup(
  identity: OwnedProcessIdentity
): OwnedProcessGroupObservation;
export function observeOwnedProcess(identity: OwnedProcessIdentity): OwnedProcessObservation;
export function signalOwnedProcessIdentity(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals
): void;

export function ownedProcessDescendsFrom(rootPid: number, candidatePid: number): boolean;
