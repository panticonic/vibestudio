import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import type { ModelCatalog } from "@workspace/model-catalog/catalog";
import { ModelSettingsDO } from "./index.js";

const CATALOG: ModelCatalog = {
  providers: [
    {
      id: "openai",
      label: "openai",
      baseUrls: ["https://api.openai.com/v1"],
      recommendedModelRef: "openai:gpt-5",
      connectable: true,
    },
    {
      id: "anthropic",
      label: "anthropic",
      baseUrls: ["https://api.anthropic.com/v1"],
      recommendedModelRef: "anthropic:claude-opus-4-1",
      connectable: true,
    },
  ],
  models: [
    {
      ref: "openai:gpt-5",
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 128000,
      maxTokens: 16000,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      templatedBaseUrl: false,
      connectable: true,
      recommended: true,
    },
    {
      ref: "anthropic:claude-opus-4-1",
      id: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 200000,
      maxTokens: 32000,
      thinkingLevels: ["low", "medium", "high"],
      templatedBaseUrl: false,
      connectable: true,
      recommended: true,
    },
  ],
};

class TestModelSettingsDO extends ModelSettingsDO {
  static config: WorkspaceConfig = { id: "test" };
  static writes: Array<{ key: string; value: unknown }> = [];

  protected getCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CATALOG);
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return Promise.resolve(TestModelSettingsDO.config);
  }

  protected setWorkspaceConfigField(key: string, value: unknown): Promise<void> {
    TestModelSettingsDO.writes.push({ key, value });
    TestModelSettingsDO.config = {
      ...TestModelSettingsDO.config,
      [key]: value,
    };
    return Promise.resolve();
  }
}

describe("ModelSettingsDO", () => {
  it("reads the configured workspace default agent config (model + behavior)", async () => {
    TestModelSettingsDO.config = {
      id: "test",
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 1,
      },
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 1,
      },
    });
  });

  it("falls back when the configured model is missing, keeping valid behavior", async () => {
    TestModelSettingsDO.config = {
      id: "test",
      defaultAgentConfig: { model: "missing:model", thinkingLevel: "low" },
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "openai:gpt-5",
      defaultModelSource: "fallback",
      invalidDefaultModel: "missing:model",
      defaultAgentConfig: { model: "openai:gpt-5", thinkingLevel: "low" },
    });
  });

  it("persists a validated default agent config to workspace config", async () => {
    TestModelSettingsDO.config = { id: "test" };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(
      call("setDefaultAgentConfig", {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 2,
      })
    ).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
      defaultAgentConfig: {
        model: "anthropic:claude-opus-4-1",
        thinkingLevel: "high",
        approvalLevel: 2,
      },
    });
    expect(TestModelSettingsDO.writes).toEqual([
      {
        key: "defaultAgentConfig",
        value: { model: "anthropic:claude-opus-4-1", thinkingLevel: "high", approvalLevel: 2 },
      },
    ]);
  });

  it("drops invalid behavior fields when persisting", async () => {
    TestModelSettingsDO.config = { id: "test" };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await call("setDefaultAgentConfig", {
      model: "openai:gpt-5",
      thinkingLevel: "bogus",
      approvalLevel: 9,
    });
    expect(TestModelSettingsDO.writes).toEqual([
      { key: "defaultAgentConfig", value: { model: "openai:gpt-5" } },
    ]);
  });

  it("rejects unknown default model refs", async () => {
    TestModelSettingsDO.config = { id: "test" };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("setDefaultAgentConfig", { model: "missing:model" })).rejects.toThrow(
      "Unknown model ref: missing:model"
    );
  });
});
