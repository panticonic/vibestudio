import { afterEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELAY_ORIGIN,
  buildBackhaulUrl,
  getRelayOrigin,
  ensureRelayBackhaulIdentity,
  loadRelayBackhaulIdentity,
} from "./relayBackhaulClient.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibestudio-relay-identity-"));
  tempDirs.push(dir);
  const file = join(dir, "identity.pem");
  ensureRelayBackhaulIdentity(file);
  return file;
}

describe("relay backhaul bootstrap", () => {
  it("uses the Vibestudio apex unless a relay deployment override is supplied", () => {
    expect(getRelayOrigin({})).toBe(DEFAULT_RELAY_ORIGIN);
    expect(getRelayOrigin({ VIBESTUDIO_RELAY_URL: "https://relay.test///" })).toBe(
      "https://relay.test"
    );
  });

  it("builds a verifiable proof from the persistent workspace identity", () => {
    const first = loadRelayBackhaulIdentity(identityFile());
    const now = Date.now();
    const url = new URL(buildBackhaulUrl(DEFAULT_RELAY_ORIGIN, first, now));
    const publicKeyDer = Buffer.from(url.searchParams.get("key")!, "base64url");
    const timestamp = url.searchParams.get("ts")!;

    expect(url.origin).toBe("wss://vibestudio.app");
    expect(url.pathname).toBe("/backhaul");
    expect(url.searchParams.get("relayId")).toBe(first.relayId);
    expect(first.relayId).toBe(`rly_${createHash("sha256").update(publicKeyDer).digest("hex")}`);
    expect(
      verify(
        "sha256",
        Buffer.from(`${first.relayId}\n${timestamp}`),
        {
          key: createPublicKey({ key: publicKeyDer, type: "spki", format: "der" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(url.searchParams.get("sig")!, "base64url")
      )
    ).toBe(true);
  });

  it("derives the same relay id whenever the persistent identity is reloaded", () => {
    const file = identityFile();
    expect(loadRelayBackhaulIdentity(file).relayId).toBe(loadRelayBackhaulIdentity(file).relayId);
  });
});
