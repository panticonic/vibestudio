/** Shared connection-attempt policy for Host transports and owned Node bootstraps.
 * This changes neither DNS authority, overall deadlines nor replay policy. */
export function networkFamilyAttemptTimeout(
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const configured = env["VIBESTUDIO_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS"]?.trim();
  if (configured === "0") return undefined;
  const milliseconds = configured ? Number(configured) : 1500;
  if (!Number.isInteger(milliseconds) || milliseconds < 10 || milliseconds > 60_000)
    throw new Error("VIBESTUDIO_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS must be 0 or an integer from 10 to 60000");
  return milliseconds;
}
