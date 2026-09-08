export interface OwnedProcessIdentity {
  version: 1;
  platform: "linux" | "darwin";
  pid: number;
  processGroupId: number;
  startCoordinate: string;
}
export type OwnedProcessObservation = "owned" | "absent" | "unknown";
export function captureOwnedProcessIdentity(pid: number): OwnedProcessIdentity;
export function observeOwnedProcess(identity: OwnedProcessIdentity): OwnedProcessObservation;
export function signalOwnedProcessIdentity(
  identity: OwnedProcessIdentity,
  signal: NodeJS.Signals
): void;
