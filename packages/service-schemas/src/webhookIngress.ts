import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export const webhookIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+=:-]{0,127}$/);

export const webhookTargetSchema = z
  .object({
    source: z.string().regex(/^[A-Za-z0-9._@+=:-]+\/[A-Za-z0-9._@+=:-]+$/),
    className: webhookIdentifierSchema,
    objectKey: z.string().min(1).max(256),
    method: webhookIdentifierSchema,
  })
  .strict();

export const webhookVerifierSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hmac-sha256"),
      headerName: z.string().min(1).max(128),
      secret: z.string().min(1).max(4096),
      prefix: z.string().max(64).optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("timestamped-hmac-sha256"),
      signatureHeaderName: z.string().min(1).max(128),
      timestampHeaderName: z.string().min(1).max(128),
      secret: z.string().min(1).max(4096),
      prefix: z.string().max(64).optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
      toleranceMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000)
        .optional(),
      signedPayload: z.enum(["slack-v0", "timestamp-dot-body"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer"),
      headerName: z.string().min(1).max(128),
      token: z.string().min(1).max(4096),
      scheme: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("query-token"),
      paramName: z.string().min(1).max(128),
      token: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("oidc-jwt"),
      issuer: z.string().min(1).max(256),
      audience: z.string().min(1).max(2048),
      jwksUrl: z.string().url().default(GOOGLE_OIDC_JWKS_URL),
      headerName: z.string().min(1).max(128).optional(),
      serviceAccountEmail: z.string().email().optional(),
    })
    .strict(),
]);

export const webhookDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("relay") }).strict(),
  z.object({ mode: z.literal("direct") }).strict(),
]);

export const webhookPayloadFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("raw") }).strict(),
  z.object({ type: z.literal("json") }).strict(),
  z
    .object({
      type: z.literal("cloud-pubsub"),
      decodeData: z.enum(["base64", "text", "json"]),
    })
    .strict(),
]);

export const webhookReplayKeySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("json-pointer"), pointer: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal("body-sha256") }).strict(),
]);

export const createWebhookIngressSubscriptionSchema = z
  .object({
    label: z.string().min(1).max(256).optional().describe("Human-readable subscription label."),
    target: webhookTargetSchema.describe(
      "Worker/DO method that receives verified deliveries. For worker/DO callers, target.source must equal the caller's own source; agent eval can obtain it from agent.describe().identity."
    ),
    delivery: webhookDeliverySchema.describe(
      "relay uses the configured public relay; direct uses this server's co-located public gateway."
    ),
    payload: webhookPayloadFormatSchema.describe("How the verified request body is decoded."),
    verifier: webhookVerifierSchema.describe(
      "Authentication applied before delivery. Secrets/tokens are redacted from list results."
    ),
    replay: z
      .object({
        key: webhookReplayKeySchema,
        ttlMs: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60 * 1000),
      })
      .strict()
      .optional(),
    response: z
      .object({
        successStatus: z.union([z.literal(200), z.literal(201), z.literal(202), z.literal(204)]),
        malformedPayload: z.enum(["ack", "reject"]),
        dispatchError: z.enum(["ack", "retry"]),
      })
      .strict()
      .describe("Public HTTP status and retry behavior for malformed payloads or dispatch errors."),
  })
  .strict();

export const webhookSubscriptionIdSchema = z
  .object({ subscriptionId: webhookIdentifierSchema })
  .strict();

export const listWebhookIngressSubscriptionsOptionsSchema = z
  .object({
    includeRevoked: z
      .boolean()
      .optional()
      .describe("Include revoked subscription tombstones for audit/history views."),
  })
  .strict();

export const rotateWebhookIngressSecretSchema = z
  .object({
    subscriptionId: webhookIdentifierSchema,
    secret: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const redactedWebhookVerifierSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hmac-sha256"),
      headerName: z.string(),
      prefix: z.string().optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
      hasSecret: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("timestamped-hmac-sha256"),
      signatureHeaderName: z.string(),
      timestampHeaderName: z.string(),
      prefix: z.string().optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
      toleranceMs: z.number().optional(),
      signedPayload: z.enum(["slack-v0", "timestamp-dot-body"]),
      hasSecret: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer"),
      headerName: z.string(),
      scheme: z.string().optional(),
      hasSecret: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("query-token"),
      paramName: z.string(),
      hasSecret: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("oidc-jwt"),
      issuer: z.string(),
      audience: z.string(),
      jwksUrl: z.string(),
      headerName: z.string().optional(),
      serviceAccountEmail: z.string().optional(),
      hasSecret: z.boolean(),
    })
    .strict(),
]);

export const webhookIngressSubscriptionSummarySchema = z
  .object({
    subscriptionId: webhookIdentifierSchema,
    label: z.string().optional(),
    ownerCallerId: z.string(),
    ownerCallerKind: z.string(),
    target: webhookTargetSchema,
    delivery: webhookDeliverySchema,
    payload: webhookPayloadFormatSchema,
    verifier: redactedWebhookVerifierSchema,
    replay: z.object({ key: webhookReplayKeySchema, ttlMs: z.number() }).strict().optional(),
    response: z
      .object({
        successStatus: z.union([z.literal(200), z.literal(201), z.literal(202), z.literal(204)]),
        malformedPayload: z.enum(["ack", "reject"]),
        dispatchError: z.enum(["ack", "retry"]),
      })
      .strict(),
    publicUrl: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    revokedAt: z.number().optional(),
  })
  .strict();

export const rotateWebhookIngressSecretResultSchema = z
  .object({
    subscription: webhookIngressSubscriptionSummarySchema,
    secret: z.string(),
  })
  .strict();

export const webhookIngressMethods = defineServiceMethods({
  createSubscription: {
    args: z.tuple([createWebhookIngressSubscriptionSchema]),
    returns: webhookIngressSubscriptionSummarySchema,
    agentFacing: false,
    access: { sensitivity: "write" },
    description:
      "Create an owner-scoped public webhook subscription targeting a method in the caller's own source. In agent eval, use agent.describe().identity for target.source, target.className, and target.objectKey.",
  },
  listSubscriptions: {
    args: z.union([z.tuple([]), z.tuple([listWebhookIngressSubscriptionsOptionsSchema])]),
    returns: z.array(webhookIngressSubscriptionSummarySchema),
    agentFacing: false,
    access: { sensitivity: "read" },
    description:
      "List the caller's active webhook subscriptions (secrets redacted). Pass includeRevoked:true only for audit/history views.",
  },
  revokeSubscription: {
    args: z.tuple([webhookSubscriptionIdSchema]),
    returns: z.void(),
    agentFacing: false,
    access: { sensitivity: "destructive" },
    description: "Revoke one caller-owned webhook subscription idempotently.",
  },
  rotateSecret: {
    args: z.tuple([rotateWebhookIngressSecretSchema]),
    returns: rotateWebhookIngressSecretResultSchema,
    agentFacing: false,
    access: { sensitivity: "write" },
    description:
      "Rotate a caller-owned subscription secret, generating a strong secret when one is omitted.",
  },
});
