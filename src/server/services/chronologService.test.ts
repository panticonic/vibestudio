import { expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { withTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createChronologService, type ChronologWorkspaceData } from "./chronologService.js";

const group = "a".repeat(64);
const publicKey = "b".repeat(64);
const txId = "c".repeat(64);

function fixture() {
  const hub = {
    chronologPrincipal: vi.fn(async () => ({ publicKey, pkcs8Hex: "abcd" })),
    chronologPublicPrincipal: vi.fn(async () => ({ publicKey })),
  };
  const data = {
    identity: vi.fn<ChronologWorkspaceData["identity"]>(),
    list: vi.fn<ChronologWorkspaceData["list"]>(),
    create: vi.fn<ChronologWorkspaceData["create"]>(),
    invite: vi.fn<ChronologWorkspaceData["invite"]>(),
    join: vi.fn<ChronologWorkspaceData["join"]>(),
    reviewProgram: vi.fn(async () => ["INSERT INTO project (name) VALUES ('approved')"]),
    transact: vi.fn(async () => ({ txId })),
    outcome: vi.fn(async () => ({ status: "accepted" as const })),
    query: vi.fn<ChronologWorkspaceData["query"]>(),
    subscribe: vi.fn<ChronologWorkspaceData["subscribe"]>(),
  };
  const service = withTestServiceDispatcher(createChronologService({ hub, data }));
  const ctx: ServiceContext = {
    caller: createVerifiedCaller("panel:workspace", "panel", null, null, {
      userId: "alice",
      handle: "alice",
    }),
  };
  return { service, ctx, hub, data };
}

it("releases the initiating user's key only after the dispatcher approves the sealed program", async () => {
  const { service, ctx, hub, data } = fixture();
  const input = { group, operationId: "once", program: "affe" };
  const assert = vi.fn<() => Promise<void>>(async () => {
    throw new Error("Denied");
  });
  const context = {
    ...ctx,
    authority: { assert, allows: vi.fn() } as unknown as ServiceContext["authority"],
  };
  await expect(service.handler(context, "transact", [input])).rejects.toThrow("Denied");
  expect(hub.chronologPrincipal).not.toHaveBeenCalled();
  expect(data.transact).not.toHaveBeenCalled();

  const approved = { ...input };
  assert.mockImplementationOnce(async () => {
    expect(hub.chronologPrincipal).not.toHaveBeenCalled();
    input.program = "dead";
  });
  await expect(service.handler(context, "transact", [input])).rejects.toThrow("Denied");
  expect(hub.chronologPrincipal).not.toHaveBeenCalled();
  expect(assert).toHaveBeenCalledTimes(3);

  assert.mockImplementation(async () => {
    expect(hub.chronologPrincipal).not.toHaveBeenCalled();
  });
  await expect(service.handler(context, "transact", [approved])).resolves.toEqual({ txId });
  expect(assert).toHaveBeenLastCalledWith(
    expect.objectContaining({
      capability: "chronolog.write",
      resourceKey: group,
      challenge: expect.objectContaining({
        allowedDecisions: ["once", "deny"],
        substance: expect.objectContaining({
          facts: [{ label: "Step 1", value: "INSERT INTO project (name) VALUES ('approved')" }],
        }),
      }),
    })
  );
  expect(hub.chronologPrincipal).toHaveBeenCalledWith({ userId: "alice" }, expect.anything());
  expect(data.transact).toHaveBeenCalledWith({ publicKey, pkcs8Hex: "abcd" }, approved, undefined);
});

it("uses public identity only for outcome lookup and refuses an unverified caller", async () => {
  const { service, hub, ctx, data } = fixture();
  await expect(service.handler(ctx, "outcome", [{ group, txId }])).resolves.toEqual({
    status: "accepted",
  });
  expect(hub.chronologPublicPrincipal).toHaveBeenCalledWith({ userId: "alice" }, expect.anything());
  expect(hub.chronologPrincipal).not.toHaveBeenCalled();
  expect(data.outcome).toHaveBeenCalledWith(publicKey, { group, txId }, undefined);
  await expect(
    service.handler({ caller: createVerifiedCaller("worker:outsider", "worker") }, "outcome", [
      { group, txId },
    ])
  ).rejects.toThrow();
  expect(data.outcome).toHaveBeenCalledTimes(1);
});
