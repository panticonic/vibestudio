/**
 * Services whose startup gates workspace readiness. `clientHost` exists only
 * in the System workspace, so it is required exactly where it was registered;
 * every other name is registered in every workspace.
 */
export function requiredStartupServices(isRegistered: (name: string) => boolean): string[] {
  return [
    "vcsAttach",
    "runtime",
    "workspace-state",
    "build",
    "workspace",
    "auth",
    "shellApproval",
    ...(isRegistered("clientHost") ? ["clientHost"] : []),
    "extensionHost",
    "panelHttpWiring",
    "panelRuntime",
    "approvalPushBridge",
    "irohIngress",
    "lifecycleDriver",
    "alarmDriver",
    "durableWorkDriver",
  ];
}
