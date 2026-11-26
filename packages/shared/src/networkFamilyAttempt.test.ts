import { describe, it, expect } from "vitest";
import { pinnedConnectionOptions } from "./networkDestination.js";
describe("pinned address attempt window", () => {
 const lookup = (() => { throw new Error("configuration must not resolve DNS"); }) as any;
 it("retains exact authorized lookup and gives each address time to connect", () => {
  expect(pinnedConnectionOptions({lookup}, {})).toEqual({lookup,autoSelectFamilyAttemptTimeout:1500});
 });
 it("allows the existing Node default without changing DNS", () => {
  expect(pinnedConnectionOptions({lookup}, {VIBESTUDIO_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS:"0"})).toEqual({lookup});
 });
 it("honors explicit bounded policy", () => {
  expect(pinnedConnectionOptions({lookup}, {VIBESTUDIO_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS:"2200"}).autoSelectFamilyAttemptTimeout).toBe(2200);
 });
 for(const value of ["-1","1","NaN","Infinity","1.5","60001"])
  it("rejects invalid configuration "+value, () => {expect(() => pinnedConnectionOptions({lookup}, {VIBESTUDIO_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS:value})).toThrow();});
});
