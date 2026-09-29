import {
  registerOwnedProcessGroup,
  type OwnedProcessRegistrationTarget,
} from "@vibestudio/shared/ownedProcessRegistration";
import type { OwnedProcessIdentity } from "../dev/ownedProcessIdentity.js";

export type DevRunnerIpcTarget = OwnedProcessRegistrationTarget & Pick<NodeJS.Process, "env">;

/** Dev hubs hand the same group receipt to the native runner owner chain. */
export async function registerOwnedHubWithDevRunner(
  identity: OwnedProcessIdentity,
  target: DevRunnerIpcTarget = process
): Promise<void> {
  if (target.env["VIBESTUDIO_DEV_RUNNER_IPC"] !== "1") return;
  await registerOwnedProcessGroup(identity, target);
}
