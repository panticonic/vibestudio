/** Canonical credential-free HTTP(S) identity for a Git remote. */
export function normalizeRemoteUrl(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Remote URL is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid remote URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Remote URL must use http or https: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error("Remote URL must not contain embedded credentials");
  }
  if (url.search || url.hash) {
    throw new Error(
      "Remote URL must not contain query parameters or fragments; use the credential system for authentication"
    );
  }
  return url.href;
}
