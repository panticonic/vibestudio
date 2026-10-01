import { randomUUID } from "node:crypto";

/** The runner retains the instance and owns the next Electron process. */
export function requestDeveloperRelaunch(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error?: Error): void => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object") return;
      const response = message as Record<string, unknown>;
      if (response["requestId"] !== requestId) return;
      if (response["type"] === "vibestudio:dev-relaunch-accepted") finish();
      else if (response["type"] === "vibestudio:dev-relaunch-rejected")
        finish(new Error(String(response["reason"])));
    };
    const onDisconnect = (): void =>
      finish(new Error("Developer runner disconnected during relaunch"));
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    if (!process.send || !process.connected) {
      onDisconnect();
      return;
    }
    try {
      process.send({ type: "vibestudio:dev-relaunch", requestId, args }, (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
