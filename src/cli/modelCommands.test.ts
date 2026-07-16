import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInvocation, renderCommandHelp } from "./commandTable.js";
import { createModelCommands, type ModelConnectResult } from "./modelCommands.js";
import { setPlainOutput } from "./output.js";

const CONNECTED: ModelConnectResult = {
  providerId: "openai-codex",
  credential: {
    id: "credential-1",
    label: "ChatGPT Codex model credential",
    lifecycle: { state: "active", canRefresh: true },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  setPlainOutput(false);
});

function command(connect = vi.fn(async () => CONNECTED)) {
  const modelConnect = createModelCommands({ connect })[0];
  if (!modelConnect) throw new Error("model connect command is missing");
  return { modelConnect, connect };
}

describe("model connect CLI command", () => {
  it("passes the exact provider to the injected canonical connector", async () => {
    const { modelConnect, connect } = command();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await modelConnect.run(parseInvocation(modelConnect, ["openai-codex"]), []);

    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith("openai-codex");
  });

  it("emits only the secret-free result in JSON mode", async () => {
    const connectorResult = {
      ...CONNECTED,
      accessToken: "must-not-escape",
      credential: {
        ...CONNECTED.credential,
        refreshToken: "must-not-escape",
        accountMetadata: { email: "must-not-escape@example.test" },
      },
    };
    const { modelConnect } = command(vi.fn(async () => connectorResult));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await modelConnect.run(
      parseInvocation(modelConnect, ["openai-codex", "--json"]),
      []
    );

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(CONNECTED);
    expect(String(log.mock.calls[0]?.[0])).not.toMatch(/token|authorize|callback/i);
  });

  it("reports refresh availability in readable output", async () => {
    setPlainOutput(true);
    const { modelConnect } = command();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await modelConnect.run(parseInvocation(modelConnect, ["openai-codex"]), []);

    expect(code).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "connected openai-codex: ChatGPT Codex model credential",
      "future refresh: available",
    ]);
  });

  it.each([[[]], [["openai-codex", "openai"]]])(
    "rejects missing or extra providers before invoking the connector",
    async (positionals) => {
      const { modelConnect, connect } = command();
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const code = await modelConnect.run(parseInvocation(modelConnect, positionals), []);

      expect(code).toBe(2);
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it("declares only the standard structured-output flag", () => {
    const { modelConnect } = command();

    expect(modelConnect.flags?.map((flag) => flag.name)).toEqual(["json"]);
    expect(renderCommandHelp(modelConnect)).toContain("Usage: vibestudio model connect <provider>");
    expect(renderCommandHelp(modelConnect)).toContain("--plain");
    expect(renderCommandHelp(modelConnect)).not.toContain("--browser");
  });
});
