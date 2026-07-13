import { describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "@vibestudio/rpc";
import { translateWsServerEvent } from "./wsTransport.js";

describe("translateWsServerEvent", () => {
  it("delivers general server pushes through the RpcClient event path", () => {
    const delivered: RpcMessage[] = [];
    const payload = { head: "ctx:test", changedPaths: ["projects/vault/A.mdx"] };

    expect(
      translateWsServerEvent(
        "event:vcs:head:ctx:test",
        payload,
        { viewId: "panel:one" },
        (message) => delivered.push(message)
      )
    ).toBe(true);
    expect(delivered).toEqual([
      {
        type: "event",
        fromId: "main",
        event: "event:vcs:head:ctx:test",
        payload,
      },
    ]);
  });

  it("keeps panel:event scoped to its target panel", () => {
    const deliver = vi.fn();
    expect(
      translateWsServerEvent(
        "panel:event",
        { panelId: "panel:other", type: "focus" },
        { viewId: "panel:one" },
        deliver
      )
    ).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });
});
