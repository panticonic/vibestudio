import { describe, expect, it } from "vitest";
import { doRefUrl } from "./workerdRpcRelay.js";

describe("workerdRpcRelay", () => {
  it("encodes arbitrary-depth DO source paths segment by segment", () => {
    expect(
      doRefUrl(
        {
          source: "workspace/workers/gad store",
          className: "EventStore",
          objectKey: "ctx/tree:chat",
        },
        "append.events"
      )
    ).toBe("/_w/workspace/workers/gad%20store/EventStore/ctx%2Ftree%3Achat/append.events");
  });
});
