import { expect, it } from "vitest";
import { createTestDO, createTestRpcFetch } from "@vibestudio/durable/test-utils";
import { EvalDO } from "./EvalDO.js";

it("reads native custody after release without acting as the retired runtime", async () => {
  let retired = false;
  const nested: string[] = [];
  const reply = createTestRpcFetch((envelope) => {
    nested.push(envelope.message.type === "request" ? envelope.message.method : "<other>");
    return undefined;
  });
  const rpcFetch: typeof fetch = async (input, init) => {
    if (retired) {
      const envelope = JSON.parse(String(init?.body));
      nested.push(envelope.message.method);
      return new Response(
        JSON.stringify({ error: "Not a member of this workspace", code: "EACCES" }),
        { status: 403 }
      );
    }
    return reply(input, init);
  };
  const { call, db } = await createTestDO(EvalDO, { RPC_FETCH: rpcFetch });
  expect(await call("readPendingCaptureEvidence", {})).toEqual({ rows: [], after: null });
  expect(nested).toContain("workspace-state.alarmClear");
  for (const phase of ["quiesce", "peer-obligations", "release"])
    await call("__lifecycle/prepare", {
      phase,
      epoch: "retire:evidence",
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    });
  retired = true;
  nested.length = 0;
  await expect(call("readPendingCaptureEvidence", {})).resolves.toEqual({ rows: [], after: null });
  expect(nested).toEqual([]);
  // Reaper retries may activate the same retired entity in a fresh process.
  const restored = await createTestDO(EvalDO, { RPC_FETCH: rpcFetch }, { db, initialize: false });
  await expect(restored.call("readPendingCaptureEvidence", {})).resolves.toEqual({
    rows: [],
    after: null,
  });
  expect(nested).toEqual([]);
  // A crash after release acknowledgement but before registry retirement may
  // restart retirement with another epoch; it must not rerun released hooks.
  for (const phase of ["quiesce", "peer-obligations", "release"])
    await expect(
      restored.call("__lifecycle/prepare", {
        phase,
        epoch: "retry:evidence",
        mode: "retire",
        reason: "entity_retire",
        deadlineMs: 0,
      })
    ).resolves.toEqual({ status: "ready" });
  await expect(
    restored.call("__lifecycle/prepare", {
      phase: "cancel",
      epoch: "retry:evidence",
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    })
  ).rejects.toThrow("cannot reopen released resources");
  expect(nested).toEqual([]);
});
