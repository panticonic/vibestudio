import type { MessageTier } from "@workspace/agentic-protocol";

export interface SandboxSendOptions {
  idempotencyKey?: string;
  tier?: MessageTier;
  metadata?: Record<string, unknown>;
}

export function normalizeSandboxSendOptions(
  options: SandboxSendOptions | undefined,
  fallbackIdempotencyKey: string
): {
  idempotencyKey: string;
  tier: MessageTier;
  metadata?: Record<string, unknown>;
} {
  return {
    idempotencyKey: options?.idempotencyKey ?? fallbackIdempotencyKey,
    tier: options?.tier ?? "secondary",
    ...(options?.metadata ? { metadata: options.metadata } : {}),
  };
}
