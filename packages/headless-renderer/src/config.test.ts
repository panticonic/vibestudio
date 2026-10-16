import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

describe("headless-host config authentication", () => {
  it("accepts a server capability only through the private IPC override", () => {
    expect(
      resolveConfig(
        { serverUrl: "http://127.0.0.1:3030", ipcToken: "ipc-secret" },
        {} as NodeJS.ProcessEnv
      ).auth
    ).toEqual({ kind: "token", token: "ipc-secret" });
  });

  it("rejects retired public token environment configuration", () => {
    expect(() =>
      resolveConfig({ serverUrl: "http://127.0.0.1:3030" }, {
        VIBESTUDIO_HEADLESS_TOKEN: "public-secret",
      } as NodeJS.ProcessEnv)
    ).toThrow(/private server IPC/);
  });

  it("accepts an injected paired transport without raw token configuration", () => {
    const connectionFactory = async () => {
      throw new Error("not invoked while resolving config");
    };
    expect(
      resolveConfig(
        { serverUrl: "http://127.0.0.1:3030", connectionFactory },
        {} as NodeJS.ProcessEnv
      ).auth
    ).toEqual({ kind: "injected" });
  });

  it("places transient browser state under its instance owner", () => {
    const first = resolveConfig(
      {
        serverUrl: "http://127.0.0.1:3030",
        ipcToken: "secret",
        clientSessionId: "headless-one",
      },
      { VIBESTUDIO_INSTANCE_ROOT: "/owned/first" } as NodeJS.ProcessEnv
    );
    const second = resolveConfig(
      {
        serverUrl: "http://127.0.0.1:3030",
        ipcToken: "secret",
        clientSessionId: "headless-two",
      },
      { VIBESTUDIO_INSTANCE_ROOT: "/owned/second" } as NodeJS.ProcessEnv
    );

    expect(first.profileRoot).toBe("/owned/first/vibestudio-headless");
    expect(second.profileRoot).toBe("/owned/second/vibestudio-headless");
    expect(first.profileRoot).not.toBe(second.profileRoot);
    expect(first.cacheDir).toBe(second.cacheDir);
  });
});
