import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const credentialTests: TestCase[] = [
  {
    name: "credential-store-inspect-revoke",
    description: "Store a dummy URL-bound credential, inspect it without leaking, revoke it",
    category: "credentials",
    prompt:
      "Exercise the credential lifecycle with an obviously fake test credential bound to a made-up https URL that will never be called: store it, confirm it appears in the stored-credential listing and inspect its metadata without ever revealing the secret value, then revoke it and confirm it is gone. Finish with CRED_LIFECYCLE_OK, no-secret-leak, and revoked:yes.",
    validate: (result) =>
      checked(result, ["CRED_LIFECYCLE_OK", "no-secret-leak", "revoked:yes"]),
  },
  {
    name: "credential-client-config-status",
    description: "Inspect OAuth client configuration status without secrets",
    category: "credentials",
    prompt:
      "Report the OAuth client configuration status for the providers this workspace knows about — which are configured and which are not — without exposing any client secrets. Finish with CRED_CLIENT_STATUS_OK and providers:<count>.",
    validate: (result) => checked(result, ["CRED_CLIENT_STATUS_OK", "providers:"]),
  },
];
