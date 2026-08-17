/**
 * Wire schemas for `panelContext.describe`.
 *
 * One aggregate read that answers "what panel am I attached to?" for a
 * server-side caller or configured agent tool. The shell chrome deliberately
 * does not use it: it already has
 * main-process access via `panel.getChromeState` and composes locally.
 *
 * The snapshot is split by *who owns the fact*, and says so on the wire:
 *
 *  - `tree`, `source`, `presentation` are server-resident and always present.
 *  - `console` and `address` are not. Console bodies stay behind the CDP tool
 *    surface so that reading them records context ingestion; there is no cheap
 *    server-side log store to count them from. Favicon / editable address /
 *    back-forward state live in the presenting shell. Both are returned as an
 *    explicit typed absence with a machine-readable reason rather than as a
 *    fabricated zero or empty string — an agent that is told "unknown" can ask
 *    for the tool; an agent told "0 errors" cannot.
 */

import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

/**
 * The spec writes these principals as `["user", "host", "code", "agent"]`.
 * `agent` is not a `PrincipalKind` — linked external agent sessions carry code
 * identity and are admitted through the `code` family, exactly as `panelCdp`
 * documents for the same callers.
 */
export const PANEL_CONTEXT_POLICY: ServiceAuthorityPolicy = {
  principals: ["user", "host", "code"],
};

/** Resolver name the service must implement in `authorityPreparation`. */
export const PANEL_CONTEXT_BOUNDARY_RESOLVER = "panelContext.describe.contextBoundary";

/**
 * Identical shape to `panelCdp`'s boundary authority: the primary capability is
 * the stable user-facing `panel.inspect`, and the dynamically selected
 * cross-context leaf stays independently gated. Same-context reads are free;
 * describing a foreign panel prompts exactly as inspecting one does.
 */
const describeAuthority = {
  requirement: requirementForPrincipals(["code", "user", "host"], "panel.inspect"),
  resource: { kind: "literal" as const, key: "panel.inspect" },
  prepared: {
    resolver: PANEL_CONTEXT_BOUNDARY_RESOLVER,
    leaves: [
      {
        capability: "context.boundary",
        requirement: fixedPreparedAuthorityRequirement(
          requirementForPrincipals(["code", "user", "host"], "context.boundary")
        ),
        tier: { selectedFrom: ["gated", "critical"] as const },
      },
    ],
  },
};

/** Durable tree facts, read from workspace-state. */
export const PanelContextTreeSchema = z
  .object({
    slotId: z.string(),
    parentSlotId: z.string().nullable(),
    title: z.string().nullable(),
    /** Open sibling slots under the same parent, excluding this one. */
    siblings: z.array(z.object({ slotId: z.string(), title: z.string().nullable() }).strict()),
    /** Serialized state args exactly as recorded on the current history entry. */
    stateArgs: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

/** Code identity of whatever currently occupies the slot. */
export const PanelContextSourceSchema = z
  .object({
    source: z.string(),
    repoPath: z.string(),
    effectiveVersion: z.string(),
    executionDigest: z.string().nullable(),
    contextId: z.string(),
    entityId: z.string(),
    /** "browser" for a web panel, "workspace" for a unit-backed one. */
    kind: z.enum(["browser", "workspace"]),
  })
  .strict();

/** Lease/presentation facts owned by the panel-runtime coordinator. */
export const PanelContextPresentationSchema = z
  .object({
    state: z.enum(["ready", "loading", "unavailable"]),
    /** Reported view URL from the presenting host, when it has reported one. */
    url: z.string().nullable(),
    surface: z.enum(["desktop", "headless", "mobile"]).nullable(),
    hostConnectionId: z.string().nullable(),
    holderLabel: z.string().nullable(),
    /** Whether the current lease holder can serve CDP at all. */
    supportsCdp: z.boolean(),
    reachable: z.boolean(),
  })
  .strict();

/**
 * Console summary. Counts are behind the CDP tool surface today; `describe`
 * records no ingestion, so it must not read them.
 */
export const PanelContextConsoleSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(false),
      reason: z.literal("counts-require-cdp-read"),
      /** The tool that can answer, so the agent knows what to reach for. */
      via: z.literal("panel_console"),
    })
    .strict(),
  z
    .object({
      available: z.literal(true),
      errors: z.number().int().nonnegative(),
      warnings: z.number().int().nonnegative(),
      entries: z.number().int().nonnegative(),
    })
    .strict(),
]);

/**
 * Presentation-local facts (favicon, editable address, back/forward). These
 * live in the presenting shell's panel registry, not on the server.
 */
export const PanelContextAddressSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(false),
      reason: z.enum(["presentation-local", "no-cdp-capable-holder"]),
    })
    .strict(),
  z
    .object({
      available: z.literal(true),
      displayAddress: z.string().nullable(),
      editableAddress: z.string().nullable(),
      faviconUrl: z.string().nullable(),
      canGoBack: z.boolean(),
      canGoForward: z.boolean(),
    })
    .strict(),
]);

export const PanelContextSnapshotSchema = z
  .object({
    panelId: z.string(),
    tree: PanelContextTreeSchema,
    source: PanelContextSourceSchema,
    presentation: PanelContextPresentationSchema,
    console: PanelContextConsoleSchema,
    address: PanelContextAddressSchema,
  })
  .strict();
export type PanelContextSnapshot = z.infer<typeof PanelContextSnapshotSchema>;

export const panelContextMethods = defineServiceMethods({
  describe: {
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "panel-context.identity",
      rationale:
        "Bounded identity and lease projection for one exact panel target; conversation content and console bodies stay behind the separately gated CDP tools",
    },
    presentation: {
      title: "Read a panel's identity and status",
      action: "read a panel's identity and status",
      description: "Allows {requesterKind} to read a panel's identity and status.",
      group: "panels",
      authorityCategory: { domain: "computer", verb: "see" },
    },
    description:
      "Describe one panel: its slot and siblings, the code identity currently occupying it, and its presentation lease. Console counts and presentation-local address facts are reported as explicitly absent rather than guessed.",
    args: z.tuple([z.string()]),
    returns: PanelContextSnapshotSchema,
    authority: describeAuthority,
    access: { sensitivity: "read" },
    examples: [{ args: ["panel:tree/root/0"] }],
  },
});
