import type { OAuthConnectionErrorCode } from "@vibestudio/credential-client/types";

/** Structured failure produced while establishing or refreshing a credential. */
export class OAuthConnectionError extends Error {
  constructor(
    public code: OAuthConnectionErrorCode,
    message: string = code
  ) {
    super(message);
  }
}

/** Plain coded error used by provider-response parsing for wire-compatible failures. */
export function oauthConnectionError(
  code: OAuthConnectionErrorCode,
  message: string
): Error & { code: OAuthConnectionErrorCode } {
  return Object.assign(new Error(message), { code });
}

/** Provider response text with any token or client secret it echoes redacted. */
export function sanitizeOAuthErrorText(text: string): string {
  return text
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2"
    )
    .replace(/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** One readable message for a failed token exchange, preferring the provider's own error. */
export function formatOAuthTokenExchangeError(
  status: number,
  data: Record<string, unknown> | null,
  text: string
): string {
  const details: string[] = [];
  const providerError = data?.["error"];
  const providerDescription = data?.["error_description"];
  if (typeof providerError === "string" && providerError.trim()) {
    details.push(providerError.trim());
  }
  if (typeof providerDescription === "string" && providerDescription.trim()) {
    details.push(providerDescription.trim());
  }
  if (details.length) {
    return `OAuth token exchange failed: ${status} ${details.join(": ")}`;
  }
  const sanitizedText = sanitizeOAuthErrorText(text);
  return sanitizedText
    ? `OAuth token exchange failed: ${status}; response: ${sanitizedText}`
    : `OAuth token exchange failed: ${status}`;
}
