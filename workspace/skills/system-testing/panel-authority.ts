import type {
  AgentExecutionTestAuthorityRule,
  AgentExecutionTestPolicySpec,
} from "@vibestudio/shared/authority/testPolicy";

/**
 * Panel creation and CDP inspection share the same workerd-hosted runtime and
 * driver lifecycle. Treat that constrained platform surface as one scheduler
 * resource so test concurrency cannot create overlapping panel hosts that
 * exhaust the runtime before their cleanup is acknowledged.
 */
export const PANEL_AUTOMATION_RESOURCE = "workerd:panel-automation";

export function panelAutomationResourcesForSuite(options: {
  usesPanelAutomation?: boolean;
}): string[] | undefined {
  return options.usesPanelAutomation ? [PANEL_AUTOMATION_RESOURCE] : undefined;
}

/**
 * The authority needed by a panel-control test is deliberately explicit and
 * narrow.  The ordinary workspace-state service rule covers reads, but the
 * panel runtime mutates the same WorkspaceDO through its dedicated capability
 * and CDP inspection is a separate receiver capability.
 */
export const PANEL_RUNTIME_STATE_AUTHORITY: AgentExecutionTestAuthorityRule = {
  ruleId: "manage-panel-state",
  capability: { kind: "exact", key: "workspace.runtime-state.manage" },
  resource: { kind: "exact", key: "workspace.runtime-state.manage" },
  tier: "gated",
  decision: "once",
};

/**
 * Browser panels get their own runtime context. CDP inspection therefore
 * carries the same context-boundary leaf as any other operation on an
 * existing panel, even when the test created that panel moments earlier.
 * Keep this explicit in the case policy so the unattended harness does not
 * fall back to a real approval waiter for a test-owned browser context.
 */
export const PANEL_CONTEXT_BOUNDARY_AUTHORITY: AgentExecutionTestAuthorityRule = {
  ruleId: "manage-panel-context-boundary",
  capability: { kind: "exact", key: "context.boundary" },
  resource: { kind: "prefix", prefix: "context/" },
  tier: "gated",
  decision: "once",
};

/** Workspace-panel CDP is performed by the installed testkit driver DO. */
export const PANEL_TESTKIT_DRIVER_AUTHORITY: AgentExecutionTestAuthorityRule = {
  ruleId: "use-testkit-driver",
  capability: { kind: "exact", key: "workspace-service:testkit-driver" },
  resource: {
    kind: "exact",
    key: "do:workers/testkit-driver:TestkitDriverDO:workspace-testkit-driver",
  },
  tier: "gated",
  decision: "once",
};

/** Reload/rebuild operations restart one exact runtime presentation. */
export const PANEL_RUNTIME_SUPERVISION_AUTHORITY: AgentExecutionTestAuthorityRule = {
  ruleId: "manage-panel-runtime-supervision",
  capability: { kind: "exact", key: "runtime.supervision.manage" },
  resource: { kind: "exact", key: "runtime.supervision.manage" },
  tier: "gated",
  decision: "once",
};

export function panelControlAuthorityPolicy(
  inspectionRuleId: string,
  additionalAuthority: readonly AgentExecutionTestAuthorityRule[] = []
): Omit<AgentExecutionTestPolicySpec, "testId" | "agent" | "unexpectedPrompts"> {
  return {
    authority: [
      PANEL_RUNTIME_STATE_AUTHORITY,
      PANEL_CONTEXT_BOUNDARY_AUTHORITY,
      PANEL_TESTKIT_DRIVER_AUTHORITY,
      {
        ruleId: inspectionRuleId,
        capability: { kind: "exact", key: "panel.inspect" },
        resource: { kind: "exact", key: "panel.inspect" },
        tier: "gated",
        decision: "once",
      },
      ...additionalAuthority,
    ],
  };
}
