import { describe, expect, it } from "vitest";
import { interactionSurfaceTests } from "./interaction-surfaces.js";
import { notificationTests } from "./notifications.js";
import { webhookTests } from "./webhooks.js";
import { workerTests } from "./workers.js";

const temporaryResourceCases = [
  ...workerTests.filter((test) =>
    ["create-destroy", "worker-do-sql-persistence", "worker-env"].includes(test.name)
  ),
  ...interactionSurfaceTests.filter((test) => test.name === "custom-message-update-clear"),
  ...notificationTests,
  ...webhookTests.filter((test) => test.name === "webhook-subscription-lifecycle"),
];

describe("temporary-resource system-test prompts", () => {
  it("leaves ownership cleanup to product guidance and harness validation", () => {
    expect(temporaryResourceCases).toHaveLength(7);
    for (const test of temporaryResourceCases) {
      expect(test.prompt).not.toMatch(
        /\b(?:archive|close|destroy|dismiss|retire|revoke|clean\s*up|cleanup)\b/iu
      );
    }
  });
});
