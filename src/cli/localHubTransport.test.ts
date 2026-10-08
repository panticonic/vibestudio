import { describe, expect, it } from "vitest";
import type { CliDeviceCredentials } from "./credentialStore.js";
import { resolveLocalHubControlTransport } from "./localHubTransport.js";

describe("local hub control resolution", () => {
  it("uses a local credential's paired gateway rather than discovering another local hub", async () => {
    await expect(
      resolveLocalHubControlTransport({
        transport: "local",
        url: "http://127.0.0.1:48123/_workspace/system-child",
      } as CliDeviceCredentials)
    ).resolves.toEqual({ serverUrl: "http://127.0.0.1:48123" });
  });
  it("preserves Iroh's authenticated device binding even on the same machine", async () => {
    await expect(
      resolveLocalHubControlTransport({
        transport: "iroh",
        url: `iroh://${"a".repeat(64)}/_workspace/system-child`,
      } as CliDeviceCredentials)
    ).resolves.toBeNull();
  });
});
