import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliConfigRoot,
  cliCredentialPath,
  hubIdentityPath,
  workspaceIdentityPath,
} from "../scripts/cli/lib/config-paths.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CLI config paths", () => {
  it("gives compiled and raw-node CLI entry points one XDG layout", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/vibestudio-xdg");
    const root = path.join("/tmp/vibestudio-xdg", "vibestudio");
    expect(cliConfigRoot()).toBe(root);
    expect(cliCredentialPath()).toBe(path.join(root, "cli-credentials.json"));
    expect(hubIdentityPath()).toBe(path.join(root, "server-auth", "webrtc", "identity.pem"));
    expect(workspaceIdentityPath("dev")).toBe(
      path.join(root, "workspaces", "dev", "reach", "webrtc", "identity.pem")
    );
  });
});
