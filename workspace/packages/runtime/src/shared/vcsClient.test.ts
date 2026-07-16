import { describe, expect, it, vi } from "vitest";
import { RemoteRpcError } from "@vibestudio/rpc";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createVcsClient } from "./vcsClient.js";

describe("createVcsClient", () => {
  it("exposes exactly the schema-owned method roster", () => {
    const client = createVcsClient(async () => null as never);
    expect(Object.keys(client).sort()).toEqual(Object.keys(vcsMethods).sort());
  });

  it("dispatches one canonical request without a routing overlay", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({
      contextId: "context:1",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "event", eventId: "event:committed" },
      clean: true,
      mainEventId: "event:committed",
      mainRelation: "at",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    }));
    const client = createVcsClient(
      async <T>(method: string, ...args: unknown[]) => (await call(method, ...args)) as T
    );

    await client.status({ contextId: "context:1" });

    expect(call).toHaveBeenCalledWith("vcs.status", { contextId: "context:1" });
  });

  it("preserves typed service refusals", async () => {
    const errorData = {
      code: "RevisionChanged",
      message: "Working head changed",
      expected: { kind: "event" as const, eventId: "event:observed" },
      actual: { kind: "application" as const, applicationId: "application:current" },
    };
    const refusal = new RemoteRpcError(errorData.message, "application", errorData.code, errorData);
    const client = createVcsClient(async () => {
      throw refusal;
    });

    const rejected = await client
      .discard({
        contextId: "context:1",
        expectedWorkingHead: errorData.expected,
        commandId: "command:discard",
      })
      .catch((error) => error);

    expect(rejected).toBe(refusal);
    expect(rejected).toMatchObject({ code: "RevisionChanged", errorData });
  });
});
