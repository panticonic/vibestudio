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

/**
 * Stored body-budget intent. Transport defaults remain semantic so an
 * operator can change the direct-ingress ceiling without rewriting every
 * subscription or changing its public URL.
 */
export type WebhookBodyBudget =
  | { mode: "transport-default" }
  | { mode: "fixed"; maxBodyBytes: number };

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
  /**
   * Maximum decoded request-body bytes accepted for this subscription.
   * Relay defaults to its 1,500,000-byte transport ceiling. Direct delivery
   * defaults to the host's configured direct-ingress ceiling.
   */
  maxBodyBytes?: number;
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
  bodyBudget: WebhookBodyBudget;
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
  /** Effective limit on this host at the time the summary was produced. */
  maxBodyBytes: number;
  verifier: Omit<WebhookVerifierConfig, "secret" | "token"> & {
    hasSecret: boolean;
  };
}

export interface RotateWebhookIngressSecretResult {
  subscription: WebhookIngressSubscriptionSummary;
  secret: string;
}
