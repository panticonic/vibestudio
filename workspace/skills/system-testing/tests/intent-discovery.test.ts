import { describe, expect, it } from "vitest";

import { agentGoalPromptFindings } from "../prompt-contract.js";
import { intentDiscoveryTests } from "./intent-discovery.js";

function scenario(name: string) {
  const found = intentDiscoveryTests.find((test) => test.name === name);
  if (!found) throw new Error(`Missing intent-discovery scenario ${name}`);
  return found;
}

describe("vague intent discovery scenarios", () => {
  it("states user outcomes without prescribing internal tools or choreography", () => {
    for (const test of intentDiscoveryTests) {
      expect(agentGoalPromptFindings(test.prompt), test.name).toEqual([]);
      expect(test.validation, test.name).toBeUndefined();
    }
  });

  it("allows phone observation but never unattended provisioning", () => {
    const phoneScenario = scenario("vague-phone-setup-readiness");
    expect(phoneScenario.resources).toEqual(["mobile:android-device"]);
    const policy = phoneScenario.authorityPolicy;
    expect(policy).not.toBeInstanceOf(Function);
    if (!policy || policy instanceof Function)
      throw new Error("Expected a static authority policy");
    expect(policy.authority.map((rule) => rule.capability)).toEqual([
      { kind: "exact", key: "workspace-service:phone.provisioning" },
      { kind: "exact", key: "mobile.devices.read" },
      { kind: "exact", key: "connected-client.transport" },
    ]);
  });

  it("keeps the terminal grant scoped to the installed shell extension", () => {
    const policy = scenario("vague-terminal-readonly-check").authorityPolicy;
    expect(policy).not.toBeInstanceOf(Function);
    if (!policy || policy instanceof Function)
      throw new Error("Expected a static authority policy");
    expect(policy.authority).toEqual([
      expect.objectContaining({
        capability: {
          kind: "prefix",
          prefix: "userland:extensions/shell/native.shell.execute#",
        },
        resource: {
          kind: "exact",
          key: "native.shell:extension:@workspace-extensions/shell",
        },
        decision: "once",
      }),
    ]);
  });
});
