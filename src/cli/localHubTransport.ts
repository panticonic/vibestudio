import type { CliDeviceIdentity } from "./credentialStore.js";

export interface LocalHubControlTransport {
  serverUrl: string;
}

/** A paired device's authenticated transport is part of its credential identity. */
export async function resolveLocalHubControlTransport(
  credentials: CliDeviceIdentity
): Promise<LocalHubControlTransport | null> {
  return credentials.transport === "local" ? { serverUrl: new URL(credentials.url).origin } : null;
}
