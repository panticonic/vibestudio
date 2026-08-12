import { z } from "zod";

/**
 * The semantic protocol shared by workspace panel shells and native adapters.
 *
 * This package deliberately contains no Electron, React Native, browser, RPC,
 * or product-state dependency. A transport authenticates and carries these
 * strict envelopes; it does not add another state channel.
 */

export const PANEL_HOST_PROTOCOL_VERSION = 1 as const;
export type PanelHostProtocolVersion = typeof PANEL_HOST_PROTOCOL_VERSION;

const protocolVersionSchema = z.literal(PANEL_HOST_PROTOCOL_VERSION);
const identitySchema = z.string().min(1);
const revisionSchema = z.number().int().nonnegative();

export const PanelHostEndowmentSchema = z.enum([
  "cdp",
  "devtools",
  "downloads",
  "find",
  "native-navigation",
  "print",
  "session-data",
]);
export type PanelHostEndowment = z.infer<typeof PanelHostEndowmentSchema>;

export const PanelShellHelloSchema = z
  .object({
    /** Opaque host-sealed identity; the protocol never parses or repairs it. */
    sealedLaunchIdentity: identitySchema,
    supportedProtocolVersions: z.array(protocolVersionSchema),
  })
  .strict();
export type PanelShellHello = z.infer<typeof PanelShellHelloSchema>;

export const PanelHostHandshakeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    hostGeneration: identitySchema,
    /** Host-minted renderer generation. It cannot be self-asserted by a shell. */
    shellGeneration: identitySchema,
    sealedLaunchIdentity: identitySchema,
    endowments: z.array(PanelHostEndowmentSchema),
  })
  .strict();
export type PanelHostHandshake = z.infer<typeof PanelHostHandshakeSchema>;

export const PanelHostHandshakeResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), handshake: PanelHostHandshakeSchema }).strict(),
  z.object({ accepted: z.literal(false), reason: z.literal("unsupported-protocol") }).strict(),
]);
export type PanelHostHandshakeResult = z.infer<typeof PanelHostHandshakeResultSchema>;

export const NativePanelBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export type NativePanelBounds = z.infer<typeof NativePanelBoundsSchema>;

export const PanelMaterializationIdentitySchema = z
  .object({
    runtimeEntityId: identitySchema,
    leaseConnectionId: identitySchema,
  })
  .strict();
export type PanelMaterializationIdentity = z.infer<typeof PanelMaterializationIdentitySchema>;

export const DesiredNativeNavigationSchema = z
  .object({ revision: revisionSchema, url: identitySchema })
  .strict();
export type DesiredNativeNavigation = z.infer<typeof DesiredNativeNavigationSchema>;

export const DesiredSessionDataSchema = z
  .object({ revision: revisionSchema, partition: identitySchema })
  .strict();
export type DesiredSessionData = z.infer<typeof DesiredSessionDataSchema>;

export const DesiredPanelSurfaceSchema = z
  .object({
    surfaceId: identitySchema,
    materialization: PanelMaterializationIdentitySchema.nullable(),
    visible: z.boolean(),
    focused: z.boolean(),
    bounds: NativePanelBoundsSchema.nullable(),
    /** Product policy only. Native focus, attachment, and leases remain adapter facts. */
    retention: z.enum(["reclaimable", "retain"]),
    navigation: DesiredNativeNavigationSchema.optional(),
    sessionData: DesiredSessionDataSchema.optional(),
  })
  .strict();
export type DesiredPanelSurface = z.infer<typeof DesiredPanelSurfaceSchema>;

/** A complete desired snapshot. Omitting a previously desired surface destroys it. */
export const PanelHostDesiredSnapshotSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    hostGeneration: identitySchema,
    shellGeneration: identitySchema,
    revision: revisionSchema,
    surfaces: z.array(DesiredPanelSurfaceSchema),
  })
  .strict();
export type PanelHostDesiredSnapshot = z.infer<typeof PanelHostDesiredSnapshotSchema>;

export const NativePanelCrashSchema = z
  .object({ occurrence: z.number().int().positive(), reason: identitySchema })
  .strict();
export type NativePanelCrash = z.infer<typeof NativePanelCrashSchema>;

export const ObservedPanelSurfaceSchema = z.discriminatedUnion("state", [
  z
    .object({
      surfaceId: identitySchema,
      state: z.literal("ready"),
      nativeSurfaceId: identitySchema,
      materialization: PanelMaterializationIdentitySchema.nullable(),
      visible: z.boolean(),
      focused: z.boolean(),
      bounds: NativePanelBoundsSchema.nullable(),
      navigationUrl: identitySchema.optional(),
    })
    .strict(),
  z
    .object({
      surfaceId: identitySchema,
      state: z.literal("crashed"),
      nativeSurfaceId: z.null(),
      lastCrash: NativePanelCrashSchema,
    })
    .strict(),
]);
export type ObservedPanelSurface = z.infer<typeof ObservedPanelSurfaceSchema>;

export const PanelHostObservedSnapshotSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    hostGeneration: identitySchema,
    shellGeneration: identitySchema,
    desiredRevision: revisionSchema.nullable(),
    observationRevision: revisionSchema,
    endowments: z.array(PanelHostEndowmentSchema),
    surfaces: z.array(ObservedPanelSurfaceSchema),
  })
  .strict();
export type PanelHostObservedSnapshot = z.infer<typeof PanelHostObservedSnapshotSchema>;

export const PanelHostRejectionReasonSchema = z.enum([
  "foreign-host-generation",
  "invalid-desired-state",
  "revision-conflict",
  "stale-revision",
  "stale-shell-generation",
  "unsupported-endowment",
  "unsupported-protocol",
]);
export type PanelHostRejectionReason = z.infer<typeof PanelHostRejectionReasonSchema>;

export const PanelHostApplyResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), observation: PanelHostObservedSnapshotSchema }).strict(),
  z.object({ accepted: z.literal(false), reason: PanelHostRejectionReasonSchema }).strict(),
]);
export type PanelHostApplyResult = z.infer<typeof PanelHostApplyResultSchema>;

export const PanelHostEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("print"),
      options: z.object({ silent: z.boolean().optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("find"), query: identitySchema, forward: z.boolean().optional() })
    .strict(),
  z
    .object({
      kind: z.literal("download"),
      url: identitySchema,
      suggestedFilename: identitySchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("open-devtools") }).strict(),
]);
export type PanelHostEffect = z.infer<typeof PanelHostEffectSchema>;

export const PanelHostEffectRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    hostGeneration: identitySchema,
    shellGeneration: identitySchema,
    requestId: identitySchema,
    surfaceId: identitySchema,
    effect: PanelHostEffectSchema,
  })
  .strict();
export type PanelHostEffectRequest = z.infer<typeof PanelHostEffectRequestSchema>;

export const PanelHostEffectReceiptSchema = z
  .object({
    requestId: identitySchema,
    surfaceId: identitySchema,
    effect: z.enum(["print", "find", "download", "open-devtools"]),
    outcome: z.literal("succeeded"),
  })
  .strict();
export type PanelHostEffectReceipt = z.infer<typeof PanelHostEffectReceiptSchema>;

export const PanelHostEffectResultSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      accepted: z.literal(true),
      receipt: PanelHostEffectReceiptSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.union([
        PanelHostRejectionReasonSchema,
        z.enum(["request-conflict", "surface-unavailable"]),
      ]),
    })
    .strict(),
]);
export type PanelHostEffectResult = z.infer<typeof PanelHostEffectResultSchema>;
