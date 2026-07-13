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
