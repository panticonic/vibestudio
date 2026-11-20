import { afterEach, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";

const onEnvelope = vi.hoisted(() => vi.fn());
vi.mock("./browserShellBridge.js", () => ({
  installFallbackShellBridge: () => ({ onEnvelope }),
}));

afterEach(() => vi.unstubAllGlobals());

it("retains committed args arriving before runtime setup and leaves reactive dispatch to the runtime", async () => {
  const page = {
    __vibestudioStateArgs: { ownerStage: "initial" },
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal("window", page);
  await import("./browserTransportEntry.js");
  const receive = onEnvelope.mock.calls[0]![0] as (envelope: RpcEnvelope) => void;
  const snapshot = { ownerStage: "replanned" };
  const envelope = {
    from: "main",
    target: "panel:nav-a",
    delivery: { caller: { callerId: "main", callerKind: "server" } },
    provenance: [{ callerId: "main", callerKind: "server" }],
    message: {
      type: "event",
      fromId: "main",
      event: "runtime:stateArgsChanged",
      payload: snapshot,
    },
  } satisfies RpcEnvelope;

  receive({
    ...envelope,
    delivery: { caller: { callerId: "panel:nav-other", callerKind: "panel" } },
  });
  expect(page.__vibestudioStateArgs).toEqual({ ownerStage: "initial" });
  receive(envelope);
  expect(page.__vibestudioStateArgs).toEqual(snapshot);
  expect(page.dispatchEvent).not.toHaveBeenCalled();
});
