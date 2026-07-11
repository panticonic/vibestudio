import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { IdentityDb } from "@vibestudio/shared/users/identityDb";
import { UserStore } from "@vibestudio/shared/users/userStore";
import { DeviceAuthStore } from "../deviceAuthStore.js";
import {
  agentCallerId,
  connectionInfoResponse,
  responseForCredential,
  shellCallerId,
} from "./model.js";

function makeStore(): { store: DeviceAuthStore; userId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-auth-model-"));
  const db = new IdentityDb({ path: ":memory:", readOnly: false });
  const userId = new UserStore(db).createRoot({ handle: "root", displayName: "Root" }).id;
  return {
    store: new DeviceAuthStore({ db, serverIdPath: path.join(dir, "server-id.json") }),
    userId,
  };
}

describe("auth response model", () => {
  it("reports the running child identity without pairing-invite state", () => {
    const { store } = makeStore();

    expect(
      connectionInfoResponse({
        deviceAuthStore: store,
        getServerBootId: () => "boot_test",
        getWorkspaceId: () => "workspace_test",
        getConnectionInfo: () => ({
          serverUrl: "http://127.0.0.1:3030",
          protocol: "http",
          externalHost: "127.0.0.1",
          gatewayPort: 3030,
        }),
      })
    ).toEqual({
      serverUrl: "http://127.0.0.1:3030",
      protocol: "http",
      externalHost: "127.0.0.1",
      gatewayPort: 3030,
      serverId: store.getServerId(),
      serverBootId: "boot_test",
      workspaceId: "workspace_test",
    });
  });

  it("returns a shell credential only when explicitly requested", () => {
    const { store, userId } = makeStore();
    const tokenManager = new TokenManager();
    const credential = store.issueDevice({ userId, label: "Laptop", platform: "desktop" });
    const deps = {
      tokenManager,
      deviceAuthStore: store,
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
    };

    expect(responseForCredential(deps, credential, { includeShellToken: false })).toEqual({
      ...credential,
      serverId: store.getServerId(),
      serverBootId: "boot_test",
      workspaceId: "workspace_test",
    });

    const response = responseForCredential(deps, credential, { includeShellToken: true });
    expect(response.callerId).toBe(shellCallerId(credential.deviceId));
    expect(response.shellToken).toBe(tokenManager.getToken(shellCallerId(credential.deviceId)));
    expect(agentCallerId("entity_one")).toBe("agent:entity_one");
  });
});
