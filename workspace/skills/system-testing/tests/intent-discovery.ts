import { validateAgentCompletionReport } from "../test-runner.js";
import type { TestCase } from "../types.js";

const terminalReadAuthority = {
  authority: [
    {
      ruleId: "vague-terminal-readonly-check",
      capability: {
        kind: "prefix" as const,
        prefix: "userland:extensions/shell/native.shell.execute#",
      },
      resource: {
        kind: "exact" as const,
        key: "native.shell:extension:@workspace-extensions/shell",
      },
      tier: "gated" as const,
      decision: "once" as const,
    },
  ],
};

const phoneDiscoveryAuthority = {
  authority: [
    {
      ruleId: "vague-phone-service-discovery",
      capability: { kind: "exact" as const, key: "workspace-service:phone.provisioning" },
      resource: {
        kind: "prefix" as const,
        prefix: "do:vibestudio/internal:PhoneProvisioningDO:",
      },
      tier: "gated" as const,
      decision: "once" as const,
    },
    {
      ruleId: "vague-phone-device-discovery",
      capability: { kind: "exact" as const, key: "mobile.devices.read" },
      resource: {
        kind: "prefix" as const,
        prefix: "do:vibestudio/internal:PhoneProvisioningDO:",
      },
      tier: "gated" as const,
      decision: "once" as const,
    },
    {
      ruleId: "vague-phone-connected-client-transport",
      capability: { kind: "exact" as const, key: "connected-client.transport" },
      resource: { kind: "exact" as const, key: "connected-client.transport" },
      tier: "gated" as const,
      decision: "once" as const,
    },
  ],
};

/**
 * User-goal probes for the point before a user knows which Vibestudio surface
 * or skill applies. These intentionally rely on trajectory review instead of
 * asserting one preferred tool choreography.
 */
export const intentDiscoveryTests: TestCase[] = [
  {
    name: "vague-terminal-readonly-check",
    description:
      "Discover and use the supported terminal path for a harmless read-only environment check",
    category: "intent-discovery",
    authorityPolicy: terminalReadAuthority,
    prompt:
      "Can you quickly check that local commands work here? Keep it harmless and read-only, and tell me what happened.",
    validate: validateAgentCompletionReport,
  },
  {
    name: "vague-phone-setup-readiness",
    description:
      "Discover the phone onboarding path, observe current readiness, and stop before provisioning",
    category: "intent-discovery",
    resources: ["mobile:android-device"],
    authorityPolicy: phoneDiscoveryAuthority,
    prompt:
      "I'd like to use this workspace from my phone. See how far setup can get right now without installing or pairing anything, then give me just the next thing I need to do.",
    validate: validateAgentCompletionReport,
  },
  {
    name: "vague-panel-preparation-triage",
    description:
      "Choose an evidence-first diagnostic workflow for a panel that repeatedly stalls in preparation",
    category: "intent-discovery",
    prompt:
      "Panel loading keeps stopping at ‘Preparing panel…’ after unrelated changes. Before anyone rebuilds or edits code, consult this workspace's current guidance and give me a concise evidence-first triage plan for finding the owning lifecycle phase and deciding the next action.",
    validate: validateAgentCompletionReport,
  },
];
