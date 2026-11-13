/**
 * Wire schema for the server "panelRuntime" lease coordination service.
 */

import { z } from "zod";
import type {
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@vibestudio/shared/panel/panelLease";
import {
  AwaitPanelAttemptResultSchema,
  PanelAttemptFailureSchema,
  PanelAttemptRefSchema,
  PanelAttemptSchema,
  PanelBootProbeResultSchema,
  PanelLifecycleResultSchema,
  PanelSlotObservationSchema,
} from "@vibestudio/shared/panelContracts";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { SchemaCoversType } from "@vibestudio/shared/schemaTypeGuard";
import type {
  MethodAccessDescriptor,
  ServiceAuthorityPolicy,
} from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

// Access descriptors shared across the read/write method groups add
// documentation and safety metadata. Method/service authority is the enforced
// principal gate.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const USERLAND_READ_POLICY: ServiceAuthorityPolicy = {
  principals: ["user", "code", "host"],
};
const REGISTER_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const LEASE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const clientPlatformSchema = z.enum(["desktop", "headless", "mobile"]);
const panelSlotIdSchema = z.string().min(1).transform(asPanelSlotId);
const panelEntityIdSchema = z.string().min(1).transform(asPanelEntityId);

export const registerClientSchema = z.object({
  clientSessionId: z.string().min(1).describe("Stable id of the client session hosting panels."),
  hostConnectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Connection id of the host transport; defaults to the client session id."),
  ownerCallerId: z
    .string()
    .min(1)
    .optional()
    .describe("Caller id that owns this client (set server-side from the request context)."),
  label: z.string().min(1).describe("Human-readable label for the lease holder."),
  platform: clientPlatformSchema.describe("Client platform: desktop, headless, or mobile."),
  supportsCdp: z
    .boolean()
    .optional()
    .describe("Whether this client can serve CDP automation; defaults true for non-mobile."),
  loadOnLeaseAssignment: z
    .boolean()
    .optional()
    .describe("Whether the client should eagerly load a panel when assigned a lease."),
});

export const leaseRequestSchema = z.object({
  slotId: z.string().min(1).describe("Panel slot the lease is being requested for."),
  clientSessionId: z.string().min(1).describe("Client session that will hold the lease."),
  connectionId: z.string().min(1).describe("Connection id tying the lease to a live transport."),
  hostConnectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Host transport connection id; defaults to the client's registered host connection."),
});

export const panelHostViewReportSchema = z
  .object({
    url: z.string(),
    loading: z.boolean(),
    boot: PanelBootProbeResultSchema,
    // Host-originated typed failure (navigation, renderer crash). The boot
    // record carries renderer-owned facts only; without this field a host can
    // push readiness but must smuggle its own failures through the probe.
    failure: z
      .object({
        reporter: z.enum(["build", "materialization", "host"]),
        failure: PanelAttemptFailureSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const panelRendererViewReportSchema = panelHostViewReportSchema.omit({ failure: true });
export type PanelRendererViewReport = z.infer<typeof panelRendererViewReportSchema>;

export const runtimeLeaseVersionSchema = z
  .object({
    epoch: z.string().min(1),
    counter: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<RuntimeLeaseVersion>;

export const panelRuntimeLeaseSchema = z
  .object({
    slotId: panelSlotIdSchema,
    runtimeEntityId: panelEntityIdSchema,
    clientSessionId: z.string().min(1),
    hostConnectionId: z.string().min(1),
    connectionId: z.string().min(1),
    holderLabel: z.string().min(1),
    platform: clientPlatformSchema,
    supportsCdp: z.boolean(),
    loadOnLeaseAssignment: z.boolean(),
    acquiredAt: z.number(),
    expiresAt: z.number().optional(),
    // Set while an agent is actively automating the panel via CDP — pins it loaded (no unload/evict).
    keepLoaded: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<PanelRuntimeLease, z.ZodTypeDef, unknown>;

export const panelRuntimeSlotObservationSchema = PanelSlotObservationSchema;

export const runtimeLeaseSnapshotSchema = z
  .object({
    version: runtimeLeaseVersionSchema,
    leases: z.array(panelRuntimeLeaseSchema),
  })
  .strict() satisfies z.ZodType<RuntimeLeaseSnapshot, z.ZodTypeDef, unknown>;

// ── Compile-time drift guards ────────────────────────────────────────────────────────────────────
// The `satisfies z.ZodType<T>` above only checks schema⊆type; these add the missing direction so a
// field added to a hand-written lease type WITHOUT adding it to its strict schema fails to compile
// HERE (naming the missing key) instead of rejecting that field at runtime parse. See SchemaCoversType.
const _leaseSchemaCoversType: SchemaCoversType<
  PanelRuntimeLease,
  z.infer<typeof panelRuntimeLeaseSchema>
> = true;
const _snapshotSchemaCoversType: SchemaCoversType<
  RuntimeLeaseSnapshot,
  z.infer<typeof runtimeLeaseSnapshotSchema>
> = true;
const _versionSchemaCoversType: SchemaCoversType<
  RuntimeLeaseVersion,
  z.infer<typeof runtimeLeaseVersionSchema>
> = true;
void _leaseSchemaCoversType;
void _snapshotSchemaCoversType;
void _versionSchemaCoversType;

export const panelRuntimeAcquireResultSchema = z.union([
  z
    .object({
      acquired: z.literal(true),
      lease: panelRuntimeLeaseSchema,
      version: runtimeLeaseVersionSchema,
    })
    .strict(),
  z
    .object({
      acquired: z.literal(false),
      lease: panelRuntimeLeaseSchema,
      version: runtimeLeaseVersionSchema,
    })
    .strict(),
]) satisfies z.ZodType<PanelRuntimeAcquireResult, z.ZodTypeDef, unknown>;

export const panelRuntimeViewReportResultSchema = z.enum(["reported", "stale"]);

// ── Tendrils: putting a panel on a chosen device (docs/tendrils-plan.md 4.5) ────────────────────
export const presentationAlertSchema = z.enum(["none", "inbox", "interrupt"]);

export const presentationTargetSchema = z
  .object({
    deviceId: z.string().min(1).describe("Paired device id (or local:<console> for this machine)."),
    label: z.string().describe("Human-readable device name."),
    platform: clientPlatformSchema,
    online: z.boolean().describe("Whether the device has a client session connected now."),
    clientSessionId: z.string().min(1).nullable(),
  })
  .strict();
export type PresentationTarget = z.infer<typeof presentationTargetSchema>;

export const presentationRequestInputSchema = z
  .object({
    slotId: z.string().min(1).describe("Panel slot to show."),
    deviceId: z.string().min(1).describe("Target device from listPresentationTargets."),
    focus: z.boolean().describe("Bring the panel to the front on that device."),
    alert: presentationAlertSchema.describe(
      "none: show quietly; inbox: also notify; interrupt: notify with high priority."
    ),
  })
  .strict();

export const presentResultSchema = z
  .object({
    state: z
      .enum(["presented", "pending-device", "pushed"])
      .describe(
        "presented: the online device was asked to show it; pushed: the device is away and was notified; pending-device: it will be shown when the device next connects."
      ),
  })
  .strict();
export type PresentResult = z.infer<typeof presentResultSchema>;

export const presentationRequestSchema = presentationRequestInputSchema
  .extend({ requestedAt: z.number() })
  .strict();

export const panelRuntimeMethods = defineServiceMethods({
  registerClient: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Register (or refresh) a panel-hosting client session so it can be assigned runtime leases.",
    args: z.tuple([registerClientSchema]),
    returns: z.void(),
    access: REGISTER_ACCESS,
  },
  unregisterClient: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Unregister a client session by id, releasing any leases it held and reassigning default CDP hosts as needed.",
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
    access: LEASE_ACCESS,
  },
  getSnapshot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Get the current lease snapshot (version + all active panel runtime leases).",
    args: z.tuple([]),
    returns: runtimeLeaseSnapshotSchema,
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  observeSlot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale:
        "Bounded observation of the active presentation lease and its host-reported boot state",
    },
    description: "Observe the canonical attempt, route, and build axes for one panel slot.",
    args: z.tuple([z.string().min(1)]),
    returns: panelRuntimeSlotObservationSchema,
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  getAttempt: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Resolves opaque attempt references without acquiring authority",
    },
    description: "Resolve one exact coordinator-minted panel attempt reference.",
    args: z.tuple([PanelAttemptRefSchema]),
    returns: AwaitPanelAttemptResultSchema,
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  awaitAttempt: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Waits on one exact panel boot lifecycle without acquiring authority",
    },
    description: "Wait until an exact panel attempt advances beyond a known revision.",
    args: z.tuple([PanelAttemptRefSchema, z.number().int().nonnegative()]),
    returns: AwaitPanelAttemptResultSchema,
    progressSemantics: {
      kind: "external-wait",
      operation: "panel.boot",
      resource: { arg: 0, kind: "panel-attempt" },
    },
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  awaitSlot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Waits on the canonical panel observation stream without acquiring authority",
    },
    description: "Wait until any axis of a panel slot observation advances beyond a version.",
    args: z.tuple([z.string().min(1), runtimeLeaseVersionSchema]),
    returns: panelRuntimeSlotObservationSchema,
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  acquire: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Acquire the runtime lease for a panel entity. Succeeds for the current holder or an unleased entity; otherwise returns acquired:false with the existing lease.",
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
    access: LEASE_ACCESS,
  },
  takeOver: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Forcibly take over a panel entity's runtime lease, revoking and closing any conflicting holder's connection.",
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
    access: LEASE_ACCESS,
  },
  ensureSlot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Assigns a presentation lease only for the exact runtime entity already committed by the builtin topology owner",
    },
    description: "Ensure that the current runtime entity for a slot has a presentation host lease.",
    args: z.tuple([panelSlotIdSchema]),
    returns: z
      .object({
        status: z.enum(["assigned", "already-held", "mobile-held", "unavailable"]),
        lease: panelRuntimeLeaseSchema.nullable(),
        attempt: PanelAttemptSchema.nullable(),
      })
      .strict(),
    authority: { principals: ["host", "user", "code"] },
    access: LEASE_ACCESS,
  },
  unloadSlot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Releases presentation resources without changing builtin-owned panel topology or product state",
    },
    description:
      "Release the active presentation lease for a panel slot while preserving its runtime entity and topology.",
    args: z.tuple([panelSlotIdSchema]),
    returns: PanelLifecycleResultSchema,
    authority: { principals: ["host", "user", "code"] },
    access: LEASE_ACCESS,
  },
  takeOverSlot: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Transfers presentation to the caller's already-attested host lease without changing panel product state",
    },
    description:
      "Transfer a panel slot's presentation lease to the host currently presenting the calling panel.",
    args: z.tuple([panelSlotIdSchema]),
    returns: z
      .object({
        panelId: panelSlotIdSchema,
        status: z.literal("taken_over"),
        focused: z.literal(true),
        loaded: z.literal(true),
        holderLabel: z.string().min(1),
      })
      .strict(),
    authority: { principals: ["code"] },
    access: LEASE_ACCESS,
  },
  release: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Release the lease for a panel entity held by the given connection id. No-op unless the connection matches the current holder.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: LEASE_ACCESS,
  },
  reportView: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "P-panels: a lease-owning host reports the current panel boot state; ownership is verified server-side and no authority is widened.",
    },
    description:
      "Report the current page and boot observation for a leased panel from a host without an inspection transport. Returns stale when the lease was superseded before publication.",
    args: z.tuple([panelEntityIdSchema, z.string().min(1), panelHostViewReportSchema]),
    returns: panelRuntimeViewReportResultSchema,
    access: LEASE_ACCESS,
  },
  listPresentationTargets: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Lists the caller's own paired devices and this machine as places to show a panel",
    },
    description:
      "List the devices a panel can be shown on: the caller's paired devices and this machine, with whether each is online.",
    args: z.tuple([]),
    returns: z.array(presentationTargetSchema),
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  requestPresentation: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Asks one of the caller's own devices to show an existing panel; the device's client decides how, and nothing about the panel or its authority changes",
    },
    description:
      "Ask one of the caller's devices to show a panel slot. Durable: an away device shows it when it next connects, and is notified when alert is not none.",
    args: z.tuple([presentationRequestInputSchema]),
    returns: presentResultSchema,
    authority: { principals: ["user", "code", "host"] },
    access: LEASE_ACCESS,
  },
  listPresentationRequests: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "A connecting client reads the requests addressed to its own device",
    },
    description:
      "List pending presentation requests for the calling client's own device (clients read these on connect).",
    args: z.tuple([]),
    returns: z.array(presentationRequestSchema),
    authority: { principals: ["user", "host"] },
    access: READ_ACCESS,
  },
  historyProof: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Reads whether each history entry's build has started successfully; no content",
    },
    description:
      "Build proof of a panel slot's history entries, newest first: proven (started successfully), failed (failed by its own code before ever starting; with the failure), or unproven.",
    args: z.tuple([z.string().min(1)]),
    returns: z.array(
      z
        .object({
          entryKey: z.string(),
          entityId: z.string(),
          buildKey: z.string().nullable(),
          state: z.enum(["unproven", "proven", "failed"]),
          failure: z.unknown(),
        })
        .strict()
    ),
    authority: USERLAND_READ_POLICY,
    access: READ_ACCESS,
  },
  reportOwnView: {
    website: {
      kind: "closed",
      reason:
        "The panelRuntime receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "A panel principal publishes its own bootstrap transition only while its authenticated connection owns the exact active lease.",
    },
    description:
      "Publish the calling panel runtime's current page and bootstrap observation. Returns stale unless its authenticated connection owns the exact active lease.",
    args: z.tuple([panelRendererViewReportSchema]),
    returns: panelRuntimeViewReportResultSchema,
    authority: { principals: ["code"] },
    access: LEASE_ACCESS,
  },
});
