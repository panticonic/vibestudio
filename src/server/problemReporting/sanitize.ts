import type { Credential } from "@vibestudio/credential-client/types";
/** Export policy is applied before freezing; it is not an anonymization claim. */
export function sanitizeReportText(
  text: string,
  secrets: readonly string[] = [],
  home?: string
): { text: string; redactions: string[] } {
  let result = text;
  const redactions = new Set<string>();
  for (const secret of secrets)
    if (secret && result.includes(secret)) {
      result = result.split(secret).join("[secret removed]");
      redactions.add("registered-secret");
    }
  if (home && result.includes(home)) {
    result = result.split(home).join("[home]");
    redactions.add("home-path");
  }
  result = result.replace(/https?:\/\/[^\s<>"']+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.search || url.username || url.password) {
        url.search = "";
        url.username = "";
        url.password = "";
        redactions.add("url-credentials-and-query");
      }
      return url.toString();
    } catch {
      return "[invalid URL removed]";
    }
  });
  result = result.replace(
    /\b(authorization|password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi,
    (_, key: string) => {
      redactions.add("sensitive-field");
      return `${key}: [removed]`;
    }
  );
  return { text: result, redactions: [...redactions] };
}

/** Executed inside the host; neither this closure nor secret material is a workspace service value. */
export function registeredSecretRedactor(
  credentials: readonly Credential[],
  base: (text: string) => string = (text) => text
): (text: string) => string {
  const secrets = credentials
    .flatMap((credential) => [
      credential.accessToken,
      credential.refreshToken,
      credential.oauth1ConsumerSecret,
      credential.oauth1TokenSecret,
      credential.awsSecretAccessKey,
      credential.awsSessionToken,
      credential.sshPrivateKey,
      credential.cookieHeader,
      credential.samlAssertion,
      credential.modelProviderSession?.credential.access,
      credential.modelProviderSession?.credential.refresh,
      ...(credential.cookieSession?.cookies.map((cookie) => cookie.value) ?? []),
    ])
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  return (text) => sanitizeReportText(base(text), secrets).text;
}
