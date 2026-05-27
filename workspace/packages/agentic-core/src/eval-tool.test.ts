import { describe, expect, it } from "vitest";
import { buildEvalTool } from "./eval-tool.js";

function createEvalTool(overrides: Partial<Parameters<typeof buildEvalTool>[0]> = {}) {
  const scope = overrides.getScope?.() ?? {};
  return buildEvalTool({
    sandbox: {
      rpc: {
        call: async () => ({}),
      },
      loadImport: async () => "",
    },
    rpc: {
      call: async () => ({}),
    },
    runtimeTarget: "panel",
    getChatSandboxValue: () => ({
      publish: async () => ({}),
      send: async () => ({}),
      publishCustomMessage: async () => ({ messageId: "custom-1", pubsubId: 1 }),
      updateCustomMessage: async () => 2,
      callMethod: async () => ({}),
      callMethodResult: async () => ({ content: {} }),
      participantByHandle: () => null,
      callMethodByHandle: async () => ({}),
      callMethodResultByHandle: async () => ({ content: {} }),
      contextId: "ctx-test",
      channelId: "channel-test",
      rpc: { call: async () => ({}) },
    }),
    getScope: () => scope,
    ...overrides,
  });
}

describe("buildEvalTool", () => {
  it("does not accept a timeout parameter", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      timeout: 10_000,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts the supported eval parameters", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      syntax: "tsx",
      imports: { lodash: "npm:^4.17.21" },
    });

    expect(parsed.success).toBe(true);
  });

  it("documents pre-injected bindings and runtime import usage in help", async () => {
    const tool = createEvalTool({
      executeSandbox: async (_code, opts) => ({
        success: true,
        consoleOutput: "",
        returnValue: await (opts.bindings?.["help"] as () => Promise<unknown>)(),
      }),
    });

    const result = await tool.execute({ code: "return help();" }, {
      stream: async () => undefined,
    } as never);

    expect(JSON.stringify(result)).toContain("preInjected");
    expect(JSON.stringify(result)).toContain("contextId, fs, rpc");
  });

  it("adds an import hint when eval references a runtime export as a global", async () => {
    const tool = createEvalTool({
      executeSandbox: async () => ({
        success: false,
        consoleOutput: "",
        error: "contextId is not defined",
      }),
    });

    await expect(
      tool.execute({ code: "return contextId;" }, { stream: async () => undefined } as never)
    ).rejects.toThrow('import { contextId } from "@workspace/runtime"');
  });

  it("bounds huge return values and stores the full value in scope", async () => {
    const scope: Record<string, unknown> = {};
    const huge = Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      metadata: "x".repeat(2000),
    }));
    const tool = createEvalTool({
      getScope: () => scope,
      executeSandbox: async () => ({
        success: true,
        consoleOutput: "",
        returnValue: huge,
      }),
    });

    const result = await tool.execute({ code: "return huge;" }, {
      stream: async () => undefined,
    } as never);
    const rendered = JSON.stringify(result);

    expect(rendered.length).toBeLessThan(80_000);
    expect(rendered).toContain("omitted from tool transcript");
    expect(rendered).toContain("scope.__lastEvalReturn");
    expect(scope["__lastEvalReturn"]).toBe(huge);
  });
});
