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
        return url.toString();
      }
      return candidate;
    } catch {
      return "[invalid URL removed]";
    }
  });
  // Recognize credential syntax, rather than matching a sensitive word in
  // ordinary prose (for example, "with future authorization: whether...").
  result = result.replace(
    /\b(authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi,
    (_, field: string) => {
      redactions.add("sensitive-field");
      return `${field}[removed]`;
    }
  );
  result = result.replace(
    /^(\s*(?:authorization|password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\r\n]+/gim,
    (_, field: string) => {
      redactions.add("sensitive-field");
      return `${field}[removed]`;
    }
  );
  result = result.replace(
    /(["'])(authorization|password|api[_-]?key|access[_-]?token|secret)\1\s*:\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    (_, quote: string, key: string) => {
      redactions.add("sensitive-field");
      return `${quote}${key}${quote}: ${quote}[removed]${quote}`;
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
