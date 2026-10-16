import { expect, it } from "vitest";
import { respondToNotification } from "./notifications.js";

it("relays the choice to notification.respond", async () => {
  const calls: unknown[][] = [];
  const call = async (s: string, m: string, a: unknown[]) => void calls.push([s, m, ...a]);
  await respondToNotification(call, "n1", "reply", "ok");
  await respondToNotification(call, "n1", "approve");
  expect(calls).toEqual([
    ["notification", "respond", "n1", "reply", "ok"],
    ["notification", "respond", "n1", "approve"],
  ]);
});
