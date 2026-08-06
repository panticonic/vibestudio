/**
 * Notability: a reviewed list, not a computed signal
 * (docs/template-install-unit-approval-ux-plan.md §10).
 *
 * `headline` means: a reasonable non-technical person, told a part can do this,
 * would want to know before adding it — sending things outside the workspace,
 * touching accounts and sign-ins, reaching arbitrary sites, controlling the
 * computer, changing security settings.
 *
 * `everyday` means the ordinary machinery of being a part here — reading and
 * writing workspace files, posting into conversations, using models, panel
 * bookkeeping.
 *
 * Two rules sit on top of the list and are applied by {@link capabilityNotability}:
 * critical is always headline, and an unreviewed capability is headline (never
 * quietly folded away). Behavioral facts — runs in the background, runs on a
 * schedule — are headline too, but no capability row states them, so they are
 * contributed by the review builder rather than by this table.
 *
 * The table is matched exactly like the other reviewed capability catalogs: a
 * key ending in `.` or `:` matches by prefix, anything else matches the exact
 * capability or a `capability:suffix` form.
 */

export type CapabilityNotability = "headline" | "everyday";

interface NotabilityEntry {
  key: string;
  notability: CapabilityNotability;
}

/**
 * Every reviewed capability, classified once. `scripts/check-capability-notability.mjs`
 * fails the build when a capability in the host, product, or semantic catalog is
 * missing from this list, which is what makes the classification exhaustive
 * rather than best-effort.
 */
const REVIEWED_NOTABILITY: readonly NotabilityEntry[] = [
  // ── Accounts & sign-ins ────────────────────────────────────────────────────
  { key: "account-providers.", notability: "headline" },
  { key: "accounts.connect", notability: "headline" },
  { key: "accounts.disconnect", notability: "headline" },
  { key: "account.profile.read", notability: "everyday" },
  { key: "account.profile.update", notability: "everyday" },
  { key: "agent.credentials.manage", notability: "headline" },
  { key: "credential.use", notability: "headline" },
  { key: "credentials.audit.read", notability: "headline" },
  { key: "keychain", notability: "headline" },
  { key: "browser-passwords.", notability: "headline" },
  { key: "browser-form-fill.manage", notability: "headline" },
  { key: "protected-input.submit", notability: "headline" },

  // ── Publishing & sending ───────────────────────────────────────────────────
  { key: "external.open", notability: "headline" },
  { key: "open-external", notability: "headline" },
  { key: "external-browser-open", notability: "headline" },
  { key: "git.publish", notability: "headline" },
  { key: "git.remotes.manage", notability: "headline" },
  { key: "git.project.import", notability: "headline" },
  { key: "git.pull", notability: "headline" },
  { key: "push.send", notability: "headline" },
  { key: "push.manage", notability: "everyday" },
  { key: "webhooks.manage", notability: "headline" },
  { key: "notifications", notability: "everyday" },

  // ── The web ────────────────────────────────────────────────────────────────
  { key: "network.fetch", notability: "headline" },
  { key: "network.response.read", notability: "headline" },
  { key: "workspace.gateway.access", notability: "headline" },
  { key: "browser-data.read", notability: "headline" },
  { key: "browser-data.write", notability: "headline" },
  { key: "browser-data.delete", notability: "headline" },
  { key: "adblock.manage", notability: "everyday" },
  { key: "panel.navigate", notability: "everyday" },

  // ── This computer ──────────────────────────────────────────────────────────
  { key: "process.execute", notability: "headline" },
  { key: "application.shutdown", notability: "headline" },
  { key: "application.update", notability: "headline" },
  { key: "clipboard", notability: "headline" },
  { key: "native-menus", notability: "everyday" },
  { key: "window-management", notability: "everyday" },
  { key: "panel-hosting", notability: "everyday" },
  { key: "panel.inspect", notability: "headline" },
  { key: "workerd.inspector", notability: "headline" },
  { key: "runtime.inspect", notability: "everyday" },
  { key: "runtime.code-execution.manage", notability: "headline" },
  { key: "runtime.execution.recover", notability: "headline" },
  { key: "runtime.supervision.manage", notability: "headline" },
  { key: "code-runner.reset", notability: "everyday" },
  { key: "server-logs.read", notability: "everyday" },
  { key: "development.native.build.retire", notability: "everyday" },
  { key: "development.native.execute", notability: "headline" },
  { key: "development.native.session.retire", notability: "everyday" },
  { key: "development.runs.force-retire", notability: "everyday" },
  { key: "development.sessions.cleanup.retry", notability: "everyday" },
  { key: "development.sessions.destroy", notability: "everyday" },
  { key: "development.sessions.force-retire", notability: "everyday" },
  { key: "service:development.", notability: "everyday" },
  { key: "internal-model-runtime.use", notability: "everyday" },

  // ── People & devices ───────────────────────────────────────────────────────
  { key: "devices.pair", notability: "headline" },
  { key: "devices.revoke", notability: "headline" },
  { key: "devices.read", notability: "everyday" },
  { key: "incoming-pair-links", notability: "headline" },
  { key: "mobile.provision", notability: "headline" },
  { key: "mobile.devices.read", notability: "everyday" },
  { key: "connections.approve", notability: "headline" },
  { key: "connected-client.transport", notability: "headline" },
  { key: "remote-client.connect", notability: "headline" },
  { key: "remote-client.clear", notability: "everyday" },
  { key: "remote-client.read", notability: "everyday" },
  { key: "presence.read", notability: "everyday" },
  { key: "panel.presence.read", notability: "everyday" },
  { key: "panel.presence.update", notability: "everyday" },
  { key: "workspace.members.read", notability: "everyday" },
  { key: "workspace.members.manage", notability: "headline" },
  { key: "workspace.members.remove", notability: "headline" },
  { key: "users.revoke", notability: "headline" },
  { key: "channel.admin", notability: "headline" },
  { key: "channel.archive", notability: "headline" },
  { key: "channel.members.remove", notability: "headline" },

  // ── Apps & automation ──────────────────────────────────────────────────────
  // Parts calling and hearing from other parts. The receiving part's own method
  // policy is the authorization floor; this row is the ordinary machinery of
  // being a part here, and folding it into the everyday list is what keeps a
  // simple panel from reading like a threat.
  { key: "rpc:", notability: "everyday" },
  { key: "event:", notability: "everyday" },
  // The host's OWN workspace services, reached through the same
  // `workspace-service:` vocabulary userland services use.
  //
  // Being on this list is what makes them *reviewed*, and reviewed is what lets
  // clearance policy pre-authorize them (§6.1). Without an entry they fell to
  // the unreviewed default — contextual and headline — which for `apps/shell`
  // meant it could never hold a standing grant for the state store it reads on
  // every panel load. The workspace came up with `code:apps/shell@… lacks
  // workspace-service:workspace.state (approval-required)` in the console,
  // panels failing to load, and no prompt anywhere to answer.
  //
  // Classified here rather than by a provider declaration because there is no
  // declaration to read: these ship in the host build, so the platform owns
  // their classification outright (U4). A userland `workspace-service:` is
  // still unreviewed unless its provider rides the same reviewed set.
  { key: "workspace-service:workspace.state", notability: "everyday" },
  { key: "workspace-service:gad.workspace", notability: "everyday" },
  // Shipped workspace-service envelopes. These authorize discovery/routing to
  // an exact live provider; the provider's own methods retain their independent
  // receiver policy and authority checks. Classifying the envelope as everyday
  // lets initial manifest acceptance clear routine panel startup without
  // turning any protected provider method into an open effect.
  { key: "workspace-service:channel", notability: "everyday" },
  { key: "workspace-service:models", notability: "everyday" },
  { key: "workspace-service:missions", notability: "everyday" },
  { key: "workspace-service:testkit-driver", notability: "everyday" },
  { key: "workspace-service:browser.data", notability: "everyday" },
  { key: "automations.register", notability: "headline" },
  { key: "automations.control", notability: "headline" },
  { key: "missions.", notability: "headline" },
  { key: "subagents.create", notability: "headline" },
  { key: "extensions.reload", notability: "headline" },
  { key: "workspace-units.manage", notability: "headline" },
  { key: "workspace-units.publish", notability: "headline" },
  { key: "workspace-host.manage", notability: "headline" },
  { key: "workspaces.create", notability: "headline" },
  { key: "workspaces.delete", notability: "headline" },
  { key: "workspaces.open", notability: "everyday" },
  { key: "workspaces.read", notability: "everyday" },
  { key: "workspace-panels.manage", notability: "everyday" },
  { key: "workspace.configure", notability: "headline" },
  { key: "workspace.config.apply", notability: "headline" },
  { key: "workspace.dependencies.install", notability: "headline" },
  { key: "workspace.dependencies.inspect", notability: "everyday" },
  { key: "workspace.build-cache.manage", notability: "everyday" },
  { key: "workspace.runtime-state.inspect", notability: "everyday" },
  { key: "workspace.runtime-state.manage", notability: "headline" },
  { key: "reviewed-closure.", notability: "headline" },
  { key: "service:workers.resolveService", notability: "everyday" },

  // ── Your files & work ──────────────────────────────────────────────────────
  { key: "workspace.files.read", notability: "everyday" },
  { key: "workspace.files.write", notability: "everyday" },
  { key: "workspace.history.write", notability: "everyday" },
  { key: "workspace.graph.delete", notability: "headline" },
  { key: "workspace.storage.materialize", notability: "everyday" },
  { key: "workspace.storage.delete", notability: "headline" },
  { key: "workspace-main-advance", notability: "headline" },
  { key: "workspace-repo-delete", notability: "headline" },
  { key: "settings.read", notability: "everyday" },
  { key: "context.boundary", notability: "everyday" },
  { key: "context.clone", notability: "everyday" },
  { key: "context.materialize", notability: "everyday" },
  { key: "context.relationships.record", notability: "everyday" },
  { key: "context.semantic.drop", notability: "headline" },
  { key: "context.semantic.fork", notability: "everyday" },

  // ── Safety controls ────────────────────────────────────────────────────────
  // Reading the controls is ordinary; changing them is never folded away.
  { key: "approvals.read", notability: "everyday" },
  { key: "approvals.decide", notability: "headline" },
  { key: "permissions.read", notability: "everyday" },
  { key: "permissions.revoke", notability: "headline" },
  { key: "governance.read", notability: "everyday" },
  { key: "security.audit.read", notability: "headline" },
  { key: "content.trust.policy.manage", notability: "headline" },
  { key: "content.trust.vouch", notability: "headline" },
];

function matches(key: string, capability: string): boolean {
  // Exact shipped service envelopes do not classify similarly named provider
  // methods. Receiver-defined method vocabulary still comes from the receiver.
  if (key.startsWith("workspace-service:") && !key.endsWith(":") && !key.endsWith(".")) {
    return capability === key;
  }
  return key.endsWith(":") || key.endsWith(".")
    ? capability.startsWith(key)
    : capability === key || capability.startsWith(`${key}:`);
}

/** The reviewed classification, ignoring tier and provider input. Null when unreviewed. */
export function reviewedCapabilityNotability(capability: string): CapabilityNotability | null {
  // Longest key wins so `browser-passwords.` cannot be shadowed by a shorter
  // sibling and a specific entry always beats its own prefix family.
  let best: NotabilityEntry | null = null;
  for (const entry of REVIEWED_NOTABILITY) {
    if (!matches(entry.key, capability)) continue;
    if (!best || entry.key.length > best.key.length) best = entry;
  }
  return best?.notability ?? null;
}

/**
 * The notability a review renders with.
 *
 * - Critical is always headline, whatever any list says (§10).
 * - A receiver-declared (`workspace-service:`) capability supplies its own value;
 *   the platform may promote it to headline and never demote it.
 * - An unreviewed capability is headline, so a foreign template cannot ship a
 *   capability that is both auto-granted and auto-hidden (§6.1).
 */
export function capabilityNotability(input: {
  capability: string;
  tier: "gated" | "critical";
  /** Provider-authored value for a receiver-declared capability. */
  declared?: CapabilityNotability;
}): CapabilityNotability {
  if (input.tier === "critical") return "headline";
  const reviewed = reviewedCapabilityNotability(input.capability);
  if (reviewed === "headline") return "headline";
  if (reviewed === "everyday") return "everyday";
  if (input.capability.startsWith("workspace-service:")) {
    return input.declared ?? "headline";
  }
  return reviewed ?? "headline";
}

/** Keys of the reviewed list, for the catalog completeness check. */
export function reviewedNotabilityKeys(): readonly string[] {
  return REVIEWED_NOTABILITY.map((entry) => entry.key);
}
