import { describe, expect, it } from "vitest";
import { consumeWorkspaceChildSecrets } from "./workspaceChildSecrets.js";

describe("consumeWorkspaceChildSecrets", () => {
  it("captures bootstrap capabilities and removes them from descendant environments", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      VIBESTUDIO_IDENTITY_DB_PATH: "/hub/identity.db",
      VIBESTUDIO_HUB_URL: "http://127.0.0.1:3030",
      VIBESTUDIO_HUB_CONTROL_TOKEN: "child-capability",
      VIBESTUDIO_ADMIN_TOKEN: "child-admin-capability",
      VIBESTUDIO_RELAY_SIGNING_SECRET: "relay-signing-secret",
    };

    expect(consumeWorkspaceChildSecrets(env)).toEqual({
      identityDbPath: "/hub/identity.db",
      hubUrl: "http://127.0.0.1:3030",
      hubControlToken: "child-capability",
      adminToken: "child-admin-capability",
      relaySigningSecret: "relay-signing-secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("scrubs every capability even when the bootstrap contract is incomplete", () => {
    const env: NodeJS.ProcessEnv = {
      VIBESTUDIO_IDENTITY_DB_PATH: "/hub/identity.db",
      VIBESTUDIO_HUB_CONTROL_TOKEN: "child-capability",
      VIBESTUDIO_ADMIN_TOKEN: "child-admin-capability",
    };

    expect(() => consumeWorkspaceChildSecrets(env)).toThrow("Workspace runtime requires identity");
    expect(env).toEqual({});
  });
});
