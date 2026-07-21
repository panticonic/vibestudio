import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialUseGrantStore } from "./credentialUseGrantStore.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-credential-use-grants-"));
}

describe("CredentialUseGrantStore", () => {
  it("persists grants through the atomic JSON writer", () => {
    const statePath = tempDir();
    const grant = {
      bindingId: "binding_fetch",
      use: "fetch" as const,
      resource: "https://api.example.test/",
      action: "use" as const,
      scope: "version" as const,
      repoPath: "workers/agent.ts",
      effectiveVersion: "ev-1",
      grantedAt: 123,
      grantedBy: "user",
    };

    const store = new CredentialUseGrantStore({ statePath });
    store.upsert("cred_1", grant);

    const filePath = path.join(statePath, "credential-use-grants.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      grants: [{ credentialId: "cred_1", ...grant }],
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const reloaded = new CredentialUseGrantStore({ statePath });
    expect(reloaded.list("cred_1")).toEqual([grant]);
    expect(reloaded.list("cred_2")).toEqual([]);
  });

  it.each([
    [
      "retired caller grant",
      {
        grants: [
          {
            credentialId: "cred_1",
            bindingId: "binding_fetch",
            use: "fetch",
            resource: "https://api.example.test/",
            action: "use",
            scope: "caller",
            callerId: "worker:agent",
            grantedAt: 123,
            grantedBy: "self",
          },
        ],
      },
    ],
    [
      "retired repository grant",
      {
        grants: [
          {
            credentialId: "cred_1",
            bindingId: "binding_fetch",
            use: "fetch",
            resource: "https://api.example.test/",
            action: "use",
            scope: "repo",
            repoPath: "workers/agent",
            grantedAt: 123,
            grantedBy: "repo",
          },
        ],
      },
    ],
  ])("fails closed on the %s schema without overwriting it", (_label, persisted) => {
    const statePath = tempDir();
    const filePath = path.join(statePath, "credential-use-grants.json");
    fs.writeFileSync(filePath, JSON.stringify(persisted));

    const store = new CredentialUseGrantStore({ statePath });

    expect(() => store.list("cred_1")).toThrow(/cannot be loaded without risking data loss/);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(persisted);
  });

  it("atomically migrates the recognized unversioned object and array shapes", () => {
    const grant = {
      credentialId: "cred_1",
      bindingId: "binding_fetch",
      use: "fetch",
      resource: "https://api.example.test/",
      action: "use",
      scope: "version",
      repoPath: "workers/agent.ts",
      effectiveVersion: "ev-1",
      grantedAt: 123,
      grantedBy: "user",
    };
    for (const persisted of [{ grants: [grant] }, [grant]]) {
      const statePath = tempDir();
      const filePath = path.join(statePath, "credential-use-grants.json");
      fs.writeFileSync(filePath, JSON.stringify(persisted));

      const store = new CredentialUseGrantStore({ statePath });
      expect(store.list("cred_1")).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
        schemaVersion: 1,
        grants: [grant],
      });
    }
  });

  it("rejects a future version without modifying the file", () => {
    const statePath = tempDir();
    const filePath = path.join(statePath, "credential-use-grants.json");
    const persisted = { schemaVersion: 2, grants: [] };
    fs.writeFileSync(filePath, JSON.stringify(persisted));

    const store = new CredentialUseGrantStore({ statePath });
    expect(() => store.listAll()).toThrow(/unsupported schema version 2/);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(persisted);
  });
});
