import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-unified-grants-"));
}

const workerAlpha = {
  callerId: "worker:alpha",
  callerKind: "worker" as const,
  repoPath: "workers/alpha",
  effectiveVersion: "hash-1",
};

describe("CapabilityGrantStore userland decisions", () => {
  it("records, looks up, lists, and revokes custom userland decisions in the authority DB", async () => {
    const store = new CapabilityGrantStore({ statePath: tempDir() });
    await store.recordUserland(workerAlpha, { id: "team-x:foo", label: "Foo" }, "allow", 10);

    expect(store.lookupUserland(workerAlpha, "team-x:foo")).toMatchObject({
      choice: "allow",
      scope: "caller",
    });
    expect(store.listUserland(workerAlpha)).toHaveLength(1);
    await expect(store.revokeUserland(workerAlpha, "team-x:foo")).resolves.toBe(true);
    await expect(store.revokeUserland(workerAlpha, "team-x:foo")).resolves.toBe(false);
    expect(store.lookupUserland(workerAlpha, "team-x:foo")).toBeNull();
    store.close();
  });

  it("persists caller and durable-session decisions across host restarts", async () => {
    const statePath = tempDir();
    const first = new CapabilityGrantStore({ statePath });
    await first.recordUserland(workerAlpha, { id: "caller-choice" }, "yes", 20);
    await first.recordUserland(
      workerAlpha,
      { id: "session-choice" },
      "allow",
      21,
      undefined,
      "session"
    );
    first.close();

    const restarted = new CapabilityGrantStore({ statePath });
    expect(restarted.lookupUserland(workerAlpha, "caller-choice")).toMatchObject({ choice: "yes" });
    expect(restarted.lookupUserland(workerAlpha, "session-choice")).toMatchObject({
      choice: "allow",
      scope: "session",
    });
    expect(restarted.pruneSession(workerAlpha.callerId)).toBe(1);
    expect(restarted.lookupUserland(workerAlpha, "session-choice")).toBeNull();
    restarted.close();
  });

  it("matches version decisions by exact code identity and keeps internal identities caller-bound", async () => {
    const store = new CapabilityGrantStore({ statePath: tempDir() });
    await store.recordUserland(
      workerAlpha,
      { id: "version-choice" },
      "allow",
      10,
      undefined,
      "version"
    );
    expect(
      store.lookupUserland({ ...workerAlpha, callerId: "worker:beta" }, "version-choice")
    ).toMatchObject({ choice: "allow", scope: "version" });

    const internal = {
      callerId: "do:vibestudio/internal:EvalDO:one",
      callerKind: "do" as const,
      repoPath: "vibestudio/internal",
      effectiveVersion: "internal",
    };
    await store.recordUserland(
      internal,
      { id: "internal-choice" },
      "allow",
      11,
      undefined,
      "version"
    );
    expect(store.lookupUserland(internal, "internal-choice")).toMatchObject({ choice: "allow" });
    expect(
      store.lookupUserland(
        { ...internal, callerId: "do:vibestudio/internal:EvalDO:two" },
        "internal-choice"
      )
    ).toBeNull();
    store.close();
  });

  it("keeps the exact extension issuer in the unified decision identity", async () => {
    const store = new CapabilityGrantStore({ statePath: tempDir() });
    const issuer = { kind: "extension" as const, id: "extensions/shell", label: "Shell" };
    await store.recordUserland(
      workerAlpha,
      { id: "extension-choice" },
      "allow",
      10,
      issuer,
      "version"
    );
    expect(store.lookupUserland(workerAlpha, "extension-choice", issuer)).toMatchObject({
      issuer: { kind: "extension", id: "extensions/shell" },
      choice: "allow",
    });
    expect(store.lookupUserland(workerAlpha, "extension-choice")).toBeNull();
    store.close();
  });
});
