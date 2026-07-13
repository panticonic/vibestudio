export function canonicalCredentialUrl(raw: string): string {
  return new URL(raw).toString();
}

export function validateCredentialClientConfigUrls(authorizeUrl: string, tokenUrl: string): void {
  const authorize = new URL(authorizeUrl);
  const token = new URL(tokenUrl);
  if (authorize.protocol !== "https:") {
    throw new Error("OAuth authorizeUrl must use https");
  }
  if (token.protocol !== "https:") {
    throw new Error("OAuth tokenUrl must use https");
  }
  if (authorize.hash) {
    throw new Error("OAuth authorizeUrl must not include a fragment");
  }
  if (token.hash) {
    throw new Error("OAuth tokenUrl must not include a fragment");
  }
  if (token.search) {
    throw new Error("OAuth tokenUrl must not include query parameters");
  }
}
