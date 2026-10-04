import { describe, expect, it } from "vitest";
import {
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
  headForChannel,
  logIdForChannel,
} from "./index.js";

describe("channel trajectory identity", () => {
  it("derives one canonical, walkable log/head coordinate pair", () => {
    expect(channelTrajectoryFor("channel:alpha")).toEqual({
      channelId: "channel:alpha",
      logId: "channel:alpha",
      head: "main",
    });
    expect(logIdForChannel("channel:alpha")).toBe("channel:alpha");
    expect(headForChannel("channel:alpha")).toBe("main");
    expect(channelTrajectoryFor("channel:beta")).toEqual({
      channelId: "channel:beta",
      logId: "channel:beta",
      head: "main",
    });
  });

  it("rejects an absent channel identity instead of minting a shared trajectory", () => {
    expect(() => channelTrajectoryFor("")).toThrow(/non-empty channelId/);
    expect(() => logIdForChannel("")).toThrow(/non-empty channelId/);
    expect(() => headForChannel("")).toThrow(/non-empty channelId/);
  });
});

describe("trajectory invocation command identity", () => {
  const coordinates = {
    logId: "channel:alpha",
    head: "main",
    invocationId: "invocation:7",
  };

  it("is stable for one exact trajectory invocation", () => {
    const first = commandIdForTrajectoryInvocation(coordinates);
    expect(commandIdForTrajectoryInvocation({ ...coordinates })).toBe(first);
    expect(first).toBe(
      "command:trajectory-invocation:ef0c7e69d5dfa110a95b1b2c1159996a869620644b4ef981bef782bc0ab66fc6"
    );
  });

  it("domain-separates every member of the canonical tuple", () => {
    const baseline = commandIdForTrajectoryInvocation(coordinates);
    expect(
      commandIdForTrajectoryInvocation({ ...coordinates, logId: `${coordinates.logId}:other` })
    ).not.toBe(baseline);
    expect(
      commandIdForTrajectoryInvocation({ ...coordinates, head: `${coordinates.head}:other` })
    ).not.toBe(baseline);
    expect(
      commandIdForTrajectoryInvocation({
        ...coordinates,
        invocationId: `${coordinates.invocationId}:other`,
      })
    ).not.toBe(baseline);

    // A canonical tuple cannot alias through delimiter placement.
    expect(
      commandIdForTrajectoryInvocation({ logId: "a:b", head: "c", invocationId: "d" })
    ).not.toBe(commandIdForTrajectoryInvocation({ logId: "a", head: "b:c", invocationId: "d" }));
  });

  it("rejects incomplete causal coordinates", () => {
    expect(() => commandIdForTrajectoryInvocation({ ...coordinates, logId: "" })).toThrow(
      /non-empty logId/
    );
    expect(() => commandIdForTrajectoryInvocation({ ...coordinates, head: "" })).toThrow(
      /non-empty head/
    );
    expect(() => commandIdForTrajectoryInvocation({ ...coordinates, invocationId: "" })).toThrow(
      /non-empty invocationId/
    );
  });
});
