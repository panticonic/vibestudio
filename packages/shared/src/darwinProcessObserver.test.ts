import { describe, expect, it } from "vitest";
import {
  parseDarwinProcessGroupSnapshot,
  readDarwinProcessGroupSnapshot,
  resolveDarwinProcessObserverPath,
} from "./darwinProcessObserver.mjs";

function member(pid: number, state: string, pgid = 42) {
  return {
    pid,
    ppid: 1,
    pgid,
    uid: 501,
    state,
    startCoordinate: "1791234567.000042",
    command: "fixture",
  };
}

describe("Darwin libproc process observer contract", () => {
  it("resolves packaged code to the signed helper outside app.asar", () => {
    expect(
      resolveDarwinProcessObserverPath(
        "/Applications/Vibestudio.app/Contents/Resources/app.asar",
        "arm64"
      )
    ).toBe("/Applications/Vibestudio.app/Contents/MacOS/owned-process-group-observer");
    expect(resolveDarwinProcessObserverPath("/opt/vibestudio", "x64")).toBe(
      "/opt/vibestudio/dist/native-process-observer/darwin-x64/owned-process-group-observer"
    );
  });

  it("keeps kernel active counts independent from the bounded diagnostic members", () => {
    const snapshot = parseDarwinProcessGroupSnapshot(
      JSON.stringify({
        version: 1,
        processGroupId: 42,
        leader: member(42, "Z"),
        activeMemberCount: 1,
        truncated: true,
        members: [member(42, "Z"), member(43, "?")],
      }),
      42
    );
    expect(snapshot.activeMemberCount).toBe(1);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.members[1]?.state).toBe("?");
  });

  it("propagates denied kernel observations instead of turning them into absent members", () => {
    const failure = new Error("proc_pidinfo denied");
    expect(() =>
      readDarwinProcessGroupSnapshot(42, 42, {
        observerPath: "/observer",
        run: () => ({ status: 1, stdout: "", stderr: failure.message, error: failure }),
      })
    ).toThrow(failure);
    expect(() =>
      readDarwinProcessGroupSnapshot(42, 42, {
        observerPath: "/observer",
        run: () => ({
          status: 1,
          stdout: "",
          stderr: "proc_pidinfo failed: Operation not permitted (errno 1)",
        }),
      })
    ).toThrow(/Operation not permitted/u);
  });

  it("rejects incomplete counts and foreign group members", () => {
    expect(() =>
      parseDarwinProcessGroupSnapshot(
        JSON.stringify({
          version: 1,
          processGroupId: 42,
          leader: member(42, "Z"),
          activeMemberCount: 0,
          truncated: false,
          members: [member(43, "S")],
        }),
        42
      )
    ).toThrow(/underreported/u);
    expect(() =>
      parseDarwinProcessGroupSnapshot(
        JSON.stringify({
          version: 1,
          processGroupId: 42,
          leader: member(42, "S"),
          activeMemberCount: 1,
          truncated: false,
          members: [member(43, "S", 99)],
        }),
        42
      )
    ).toThrow(/foreign group/u);
  });

  it("rejects a terminal count that contradicts a live leader in the group", () => {
    expect(() =>
      parseDarwinProcessGroupSnapshot(
        JSON.stringify({
          version: 1,
          processGroupId: 42,
          leader: member(42, "R"),
          activeMemberCount: 0,
          truncated: false,
          members: [],
        }),
        42
      )
    ).toThrow(/omitted an active process-group leader/u);
  });
});
