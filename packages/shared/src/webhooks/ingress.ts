import * as crypto from "node:crypto";

export type WebhookVerifierConfig =
  | {
      type: "hmac-sha256";
      headerName: string;
      secret: string;
      prefix?: string;
      encoding?: "hex" | "base64";
    }
  | {
      type: "timestamped-hmac-sha256";
      signatureHeaderName: string;
      timestampHeaderName: string;
      secret: string;
      prefix?: string;
      encoding?: "hex" | "base64";
      toleranceMs?: number;
      signedPayload: "slack-v0" | "timestamp-dot-body";
    }
  | {
      type: "bearer";
      headerName: string;
      token: string;
      scheme?: string;
    }
  | {
      type: "query-token";
      paramName: string;
      token: string;
    }
  | {
      type: "oidc-jwt";
      issuer: string;
      audience: string;
      jwksUrl: string;
      headerName?: string;
      serviceAccountEmail?: string;
    };

export interface WebhookTarget {
  source: string;
  className: string;
  objectKey: string;
  method: string;
}

export type WebhookDeliveryConfig = { mode: "relay" } | { mode: "direct" };

export type WebhookPayloadFormat =
  | { type: "raw" }
  | { type: "json" }
  | { type: "cloud-pubsub"; decodeData: "base64" | "text" | "json" };

export type WebhookReplayKey =
  | { type: "header"; name: string }
  | { type: "json-pointer"; pointer: string }
  | { type: "body-sha256" };

export interface WebhookReplayConfig {
  key: WebhookReplayKey;
  ttlMs: number;
}

export interface WebhookResponsePolicy {
  successStatus: 200 | 201 | 202 | 204;
  malformedPayload: "ack" | "reject";
  dispatchError: "ack" | "retry";
}

export type WebhookDeliveredPayload =
  | {
      type: "raw";
    }
  | {
      type: "json";
      json: unknown;
    }
  | {
      type: "cloud-pubsub";
      subscription?: string;
      messageId?: string;
      publishTime?: string;
      attributes?: Record<string, string>;
      orderingKey?: string;
      dataBase64?: string;
      dataText?: string;
      dataJson?: unknown;
    };

export interface WebhookDeliveryEvent {
  subscriptionId: string;
  publicUrl: string;
  receivedAt: number;
  delivery: WebhookDeliveryConfig;
  headers: Record<string, string | string[] | undefined>;
  rawBodyBase64: string;
  payload: WebhookDeliveredPayload;
}

export interface CreateWebhookIngressSubscriptionRequest {
  label?: string;
  target: WebhookTarget;
  delivery: WebhookDeliveryConfig;
  payload: WebhookPayloadFormat;
  verifier: WebhookVerifierConfig;
  replay?: WebhookReplayConfig;
  response: WebhookResponsePolicy;
}

export interface RotateWebhookIngressSecretRequest {
  subscriptionId: string;
  secret?: string;
}

export interface WebhookIngressSubscription {
  subscriptionId: string;
  label?: string;
  ownerCallerId: string;
  ownerCallerKind: string;
  target: WebhookTarget;
  delivery: WebhookDeliveryConfig;
  payload: WebhookPayloadFormat;
  verifier: WebhookVerifierConfig;
  replay?: WebhookReplayConfig;
  response: WebhookResponsePolicy;
  publicUrl: string;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
}

export interface WebhookIngressSubscriptionSummary extends Omit<
  WebhookIngressSubscription,
  "verifier"
> {
  verifier: Omit<WebhookVerifierConfig, "secret" | "token"> & {
    hasSecret: boolean;
  };
}

export interface RotateWebhookIngressSecretResult {
  subscription: WebhookIngressSubscriptionSummary;
  secret: string;
}

export function summarizeWebhookIngressSubscription(
  subscription: WebhookIngressSubscription
): WebhookIngressSubscriptionSummary {
  const { verifier, ...rest } = subscription;
  if (verifier.type === "bearer" || verifier.type === "query-token") {
    const { token: _token, ...safe } = verifier;
    return { ...rest, verifier: { ...safe, hasSecret: Boolean(_token) } };
  }
  if (verifier.type === "oidc-jwt") {
    return { ...rest, verifier: { ...verifier, hasSecret: false } };
  }
  const { secret: _secret, ...safe } = verifier;
  return { ...rest, verifier: { ...safe, hasSecret: Boolean(_secret) } };
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
