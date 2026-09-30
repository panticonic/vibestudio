import { STARTUP_DESTINATION } from "@vibestudio/service-schemas/usageAnalytics";

/** One payload-free request per application process. No reporting state, pairing, secret, or retry. */
export function createAnonymousStartupCounter(request: typeof fetch = fetch): () => Promise<void> {
  let counted = false;
  return async () => {
    if (counted) return;
    counted = true;
    try {
      await request(STARTUP_DESTINATION, {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Startup counting is best-effort; do not retry an ambiguous acceptance or generate an error report.
    }
  };
}
