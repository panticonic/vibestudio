import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeOwnedProcessGroup, type OwnedProcessIdentity } from "./ownedProcessIdentity.mjs";

const receipt: OwnedProcessIdentity = {
  version: 1,
  platform: "linux",
  pid: 101,
  processGroupId: 101,
  startCoordinate: "1000",
};
function stat(pid: number, state: string, group = 101, birth = "1000") {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[2] = String(group);
  fields[19] = birth;
  return `${pid} (native child) ${fields.join(" ")}`;
}
function processes(entries: Record<number, string>) {
  vi.spyOn(fs, "readdirSync").mockReturnValue(Object.keys(entries) as never);
  vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
    const pid = Number(String(path).split("/")[2]);
    if (entries[pid] === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return entries[pid] as never;
  });
  // kill(0) sees the group even when all of its members have already exited.
  vi.spyOn(process, "kill").mockReturnValue(true);
}
afterEach(() => vi.restoreAllMocks());
describe.skipIf(process.platform !== "linux")("native group execution liveness", () => {
  it("retires a group consisting entirely of unreaped zombies", () => {
    processes({ 101: stat(101, "Z"), 202: stat(202, "Z") });
    expect(observeOwnedProcessGroup(receipt)).toBe("absent");
  });
  it("retains live descendants after the leader becomes a zombie", () => {
    processes({ 101: stat(101, "Z"), 202: stat(202, "S") });
    expect(observeOwnedProcessGroup(receipt)).toBe("retained");
  });
  it("ignores another group's live process when the original leader is reaped", () => {
    processes({ 202: stat(202, "Z"), 303: stat(303, "S", 303), 100: stat(100, "I", 0) });
    expect(observeOwnedProcessGroup(receipt)).toBe("absent");
  });
  it("checks group membership without demanding an unrelated process birth identity", () => {
    processes({ 202: stat(202, "Z"), 303: "303 (unrelated exiting process) X 1 303" });
    expect(observeOwnedProcessGroup(receipt)).toBe("absent");
  });
  it("retains a live group member even when its birth coordinate is unavailable", () => {
    processes({ 101: stat(101, "Z"), 202: "202 (owned member) S 101 101" });
    expect(observeOwnedProcessGroup(receipt)).toBe("retained");
  });
  it("refuses ownership when the exact leader has no birth coordinate", () => {
    processes({ 101: "101 (leader) S 1 101" });
    expect(observeOwnedProcessGroup(receipt)).toBe("unknown");
  });
  it("does not grant ownership to a reused PID, even if it is a zombie", () => {
    processes({ 101: stat(101, "Z", 101, "2000") });
    expect(observeOwnedProcessGroup(receipt)).toBe("unknown");
  });
});
