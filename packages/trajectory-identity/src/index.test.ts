import { describe, expect, it } from "vitest";
import {
  CHANNEL_TRAJECTORY_LOG_PREFIX,
  channelIdFromTrajectoryLog,
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
  headForChannel,
  logIdForChannel,
} from "./index.js";

describe("channel trajectory identity", () => {
  it("derives one canonical, walkable log/head coordinate pair", () => {
    expect(channelTrajectoryFor("channel:alpha")).toEqual({
      channelId: "channel:alpha",
      logId: `${CHANNEL_TRAJECTORY_LOG_PREFIX}channel:alpha`,
      head: `${CHANNEL_TRAJECTORY_LOG_PREFIX}channel:alpha`,
    });
    expect(headForChannel("channel:alpha")).toBe(logIdForChannel("channel:alpha"));
    expect(channelIdFromTrajectoryLog(logIdForChannel("channel:alpha"))).toBe("channel:alpha");
  });

  it("rejects an absent channel identity instead of minting a shared trajectory", () => {
    expect(() => channelTrajectoryFor("")).toThrow(/non-empty channelId/);
    expect(channelIdFromTrajectoryLog("branch:other:channel:alpha")).toBeNull();
    expect(channelIdFromTrajectoryLog(CHANNEL_TRAJECTORY_LOG_PREFIX)).toBeNull();
  });
});

describe("trajectory invocation command identity", () => {
  const coordinates = {
    logId: "branch:channel:channel:alpha",
    head: "branch:channel:channel:alpha",
    invocationId: "invocation:7",
  };

  it("is stable for one exact trajectory invocation", () => {
    const first = commandIdForTrajectoryInvocation(coordinates);
    expect(commandIdForTrajectoryInvocation({ ...coordinates })).toBe(first);
    expect(first).toBe(
      "command:trajectory-invocation:1fab89634d5430dbaadd2a83838ee7302a06e7fce9d70b3a7a350b267481084e"
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
