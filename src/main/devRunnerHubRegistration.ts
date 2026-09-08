import { randomBytes } from "node:crypto";
import type { OwnedProcessIdentity } from "../dev/ownedProcessIdentity.js";

export type DevRunnerIpcTarget = Pick<NodeJS.Process, "env" | "on" | "once" | "off"> & {
  send?: NodeJS.Process["send"];
};

export async function registerOwnedHubWithDevRunner(
  identity: OwnedProcessIdentity,
  target: DevRunnerIpcTarget = process
): Promise<void> {
  if (target.env["VIBESTUDIO_DEV_RUNNER_IPC"] !== "1" || !target.send) return;
  const registrationId = randomBytes(16).toString("hex");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      target.off("message", onMessage);
      target.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== "object") return;
      const response = message as { type?: unknown; registrationId?: unknown };
      if (response.registrationId !== registrationId) return;
      if (response.type === "vibestudio:dev-owned-hub-accepted") finish();
      else if (response.type === "vibestudio:dev-owned-hub-rejected") {
        finish(new Error("Development runner rejected detached hub ownership"));
      }
    };
    const onDisconnect = () => {
      finish(new Error("Development runner disconnected before accepting detached hub ownership"));
    };
    target.on("message", onMessage);
    target.once("disconnect", onDisconnect);
    target.send?.({ type: "vibestudio:dev-owned-hub", registrationId, identity }, (error) => {
      if (error) finish(error);
    });
  });
}
