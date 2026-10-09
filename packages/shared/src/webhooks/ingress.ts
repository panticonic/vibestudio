import * as crypto from "node:crypto";

export {
  WEBHOOK_DEFAULT_DIRECT_MAX_BODY_BYTES,
  WEBHOOK_DEFAULT_MAX_BODY_BYTES,
  WEBHOOK_HARD_MAX_BODY_BYTES,
  WEBHOOK_RELAY_MAX_BODY_BYTES,
} from "./limits.js";

import type {
  WebhookIngressSubscription,
  WebhookIngressSubscriptionSummary,
  WebhookVerifierConfig,
} from "./contracts.js";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookBodyBudget,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressSubscription,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookReplayKey,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "./contracts.js";

export function summarizeWebhookIngressSubscription(
  subscription: WebhookIngressSubscription,
  maxBodyBytes: number
): WebhookIngressSubscriptionSummary {
  const { verifier, ...rest } = subscription;
  if (verifier.type === "bearer" || verifier.type === "query-token") {
    const { token: _token, ...safe } = verifier;
    return { ...rest, maxBodyBytes, verifier: { ...safe, hasSecret: Boolean(_token) } };
  }
  if (verifier.type === "oidc-jwt") {
    return { ...rest, maxBodyBytes, verifier: { ...verifier, hasSecret: false } };
  }
  const { secret: _secret, ...safe } = verifier;
  return { ...rest, maxBodyBytes, verifier: { ...safe, hasSecret: Boolean(_secret) } };
}

export function verifyWebhookPayload(
  config: WebhookVerifierConfig,
  payload: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  options: { now?: number; url?: string } = {}
): boolean {
  const now = options.now ?? Date.now();
  switch (config.type) {
    case "bearer": {
      const actual = getHeader(headers, config.headerName);
      if (!actual) return false;
      const expected = config.scheme ? `${config.scheme} ${config.token}` : config.token;
      return timingSafeStringEqual(actual, expected);
    }
    case "hmac-sha256": {
      const actual = getHeader(headers, config.headerName);
      if (!actual) return false;
      const digest = crypto
        .createHmac("sha256", config.secret)
        .update(payload)
        .digest(config.encoding ?? "hex");
      return timingSafeStringEqual(actual, `${config.prefix ?? ""}${digest}`);
    }
    case "timestamped-hmac-sha256": {
      const actual = getHeader(headers, config.signatureHeaderName);
      const timestamp = getHeader(headers, config.timestampHeaderName);
      if (!actual || !timestamp) return false;
      const parsedTs = Number(timestamp);
      if (!Number.isFinite(parsedTs)) return false;
      const tsMs = parsedTs < 10_000_000_000 ? parsedTs * 1000 : parsedTs;
      const toleranceMs = config.toleranceMs ?? 5 * 60 * 1000;
      if (Math.abs(now - tsMs) > toleranceMs) return false;
      const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
      const signedPayload =
        config.signedPayload === "slack-v0"
          ? `v0:${timestamp}:${payloadText}`
          : `${timestamp}.${payloadText}`;
      const digest = crypto
        .createHmac("sha256", config.secret)
        .update(signedPayload)
        .digest(config.encoding ?? "hex");
      return timingSafeStringEqual(actual, `${config.prefix ?? ""}${digest}`);
    }
    case "query-token": {
      if (!options.url) return false;
      const actual = new URL(options.url, "http://internal").searchParams.get(config.paramName);
      return actual ? timingSafeStringEqual(actual, config.token) : false;
    }
    case "oidc-jwt":
      return false;
  }
}

export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.join(",");
    return value;
  }
  return undefined;
}

export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
