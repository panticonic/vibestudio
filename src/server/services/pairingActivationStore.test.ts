import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PairingActivationStore } from "./pairingActivationStore.js";

function filePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pairing-activation-")), "pending.json");
}

describe("PairingActivationStore", () => {
  it("replays the exact proposed credential after restart until its absolute deadline", () => {
    const target = filePath();
    const first = new PairingActivationStore(target);
    const proposed = first.prepare("a".repeat(64), 2_000_000_000_000);
    const reopened = new PairingActivationStore(target);

    expect(reopened.prepare("a".repeat(64), 2_000_000_000_000)).toEqual(proposed);
    expect(proposed.deviceId).toMatch(/^dev_[A-Za-z0-9_-]{24}$/u);
    expect(proposed.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("rejects stale schema and durably prunes expired retry secrets", () => {
    const target = filePath();
    const store = new PairingActivationStore(target);
    store.prepare("a".repeat(64), 100);
    store.prepare("b".repeat(64), 200);
    expect(store.removeExpired(100)).toHaveLength(1);
    expect(new PairingActivationStore(target).list()).toHaveLength(1);

    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 0, pending: [] }));
    expect(() => new PairingActivationStore(target)).toThrow(/canonical schema/u);
  });
});
