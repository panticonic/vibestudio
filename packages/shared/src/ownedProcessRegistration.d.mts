import type { ChildProcess } from "node:child_process";
import type { OwnedProcessIdentity } from "./ownedProcessIdentity.mjs";
export type OwnedProcessRegistrationTarget = Pick<NodeJS.Process, "on" | "once" | "off"> & {
  send?: NodeJS.Process["send"];
  connected?: boolean;
};
export function registerOwnedProcessGroup(
  identity: OwnedProcessIdentity,
  target?: OwnedProcessRegistrationTarget
): Promise<void>;
export function createOwnedProcessGroupReceiver(
  child: ChildProcess,
  childIdentity: OwnedProcessIdentity,
  adopt: (identity: OwnedProcessIdentity) => { retire(signal?: NodeJS.Signals): Promise<void> },
  options?: { forwardToParent?: boolean }
): { close(): Promise<void> };
