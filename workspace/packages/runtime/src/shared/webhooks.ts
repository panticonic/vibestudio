import type { RpcCaller } from "@vibestudio/rpc";
import type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretResult,
  WebhookIngressSubscriptionSummary,
} from "@vibestudio/shared/webhooks/ingress";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "@vibestudio/shared/webhooks/ingress";
export interface WebhookIngressClient {
  createSubscription(
    input: CreateWebhookIngressSubscriptionRequest
  ): Promise<WebhookIngressSubscriptionSummary>;
  listSubscriptions(options?: {
    includeRevoked?: boolean;
  }): Promise<WebhookIngressSubscriptionSummary[]>;
  revokeSubscription(subscriptionId: string): Promise<void>;
  rotateSecret(subscriptionId: string, secret?: string): Promise<RotateWebhookIngressSecretResult>;
}
export function createWebhookIngressClient(rpc: RpcCaller): WebhookIngressClient {
  return {
    createSubscription(input) {
      return rpc.call<WebhookIngressSubscriptionSummary>(
        "main",
        "webhookIngress.createSubscription",
        [input]
      );
    },
    listSubscriptions(options) {
      return rpc.call<WebhookIngressSubscriptionSummary[]>(
        "main",
        "webhookIngress.listSubscriptions",
        options ? [options] : []
      );
    },
    async revokeSubscription(subscriptionId) {
      await rpc.call<void>("main", "webhookIngress.revokeSubscription", [{ subscriptionId }]);
    },
    rotateSecret(subscriptionId, secret) {
      return rpc.call<RotateWebhookIngressSecretResult>("main", "webhookIngress.rotateSecret", [
        { subscriptionId, secret },
      ]);
    },
  };
}
