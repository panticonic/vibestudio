import type { Credential } from "@vibestudio/credential-client/types";

/**
 * Credentials recognizable by their own syntax, wherever they appear: a token pasted into a failure message is not in
 * the credential store, so exact-value redaction cannot know it.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * The single owner of what a report must not carry. Every path that lets a draft leave (preview, download, send) is
 * bound to the revision `problemReports.prepare` freezes after this runs; drafting helpers do not redact on their own.
 * Export policy is applied before freezing; it is not an anonymization claim.
 */
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
    /\b((?:authorization|password|passwd|token|api[_-]?key|access[_-]?token|secret)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    (_, field: string) => {
      redactions.add("sensitive-field");
      return `${field}[removed]`;
    }
  );
  result = result.replace(
    /^(\s*(?:authorization|password|passwd|token|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\r\n]+/gim,
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
  for (const shape of TOKEN_SHAPES)
    result = result.replace(shape, () => {
      redactions.add("credential-token");
      return "[removed]";
    });
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
