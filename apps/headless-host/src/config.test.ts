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
});
