/**
 * Governance read service (WP5 §7) — the host-side half of the unified
 * governance timeline.
 *
 * Exposes `governance.list({ filter })` over the host-owned governance log
 * (`GovernanceLog`), which unions approval-provenance resolutions and
 * membership-governance events (invite/revoke/add/remove/role-change). This is
 * a pure READ surface: the log is host-owned (INV-2) and single-writer; the
 * The Workspace History Governance view stitches these host records together with the
 * userland GAD agent-approval projection for one timeline.
 *
 * The query parser lives in host-core because both the hub RPC surface and this
 * child service consume it; neither side depends on the other's registration.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { type GovernanceQuery } from "@vibestudio/shared/governance/governanceLog";
import type { GovernanceRecord } from "@vibestudio/shared/governance/types";
import { governanceMethods } from "@vibestudio/service-schemas/governance";

export function createGovernanceService(deps: {
  query: (query: GovernanceQuery) => Promise<GovernanceRecord[]>;
}): ServiceDefinition {
  const methods = governanceMethods;
  return {
    name: "governance",
    description: "Host governance log — approval provenance + membership events (read-only)",
    authority: { principals: ["user", "code", "host"] },
    methods,
    handler: defineServiceHandler("governance", methods, {
      list: async (_ctx, [input]) => {
        const raw = input ?? {};
        return await deps.query({
          ...raw,
          limit: Math.max(1, Math.min(500, raw.limit ?? 100)),
        });
      },
    }),
  };
}
