import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import { DEFAULT_AGENT_MODEL_REF, type ModelCatalog } from "@workspace/model-catalog/catalog";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import type { UrlAudience } from "@vibestudio/shared/credentials/urlAudience";
import { getModelCatalog, ModelSettingsDO, type LocalModelEntry } from "./index.js";

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
    makeTestCatalogEntry({
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
      recommended: true,
    }),
    makeTestCatalogEntry({
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
      recommended: true,
    }),
  ],
};

class TestModelSettingsDO extends ModelSettingsDO {
  static config: WorkspaceConfig = { id: "test" };
  static writes: Array<{ key: string; value: unknown }> = [];

  protected getCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CATALOG);
  }

  // Both fixture providers count as credentialed — availability is a worker
  // overlay now (design §7.1), so the seam is audiences, not entry fields.
  protected credentialAudiences(): Promise<UrlAudience[]> {
    return Promise.resolve([
      { url: "https://api.openai.com/v1", match: "origin" },
      { url: "https://api.anthropic.com/v1", match: "origin" },
    ]);
  }

  // No local-models extension in the unit harness.
  protected fetchLocalModels(): Promise<LocalModelEntry[]> {
    return Promise.resolve([]);
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

/** No credentials at all + a live local fallback — the offline first-run shape. */
class OfflineModelSettingsDO extends TestModelSettingsDO {
  protected override credentialAudiences(): Promise<UrlAudience[]> {
    return Promise.resolve([]);
  }

  protected override fetchLocalModels() {
    return Promise.resolve([
      {
        slug: "lfm2.5-1.2b",
        displayName: "LFM2.5 1.2B Instruct",
        baseUrl: "http://127.0.0.1:43117/v1",
        contextWindow: 8192,
        maxTokens: 4096,
        measuredTokensPerSec: 18.4,
        toolsCapable: true,
        state: "ready" as const,
        downloadProgress: null,
        errorMessage: null,
      },
    ]);
  }
}

describe("ModelSettingsDO", () => {
  it("projects the Codex 5.6 Sol registry entry and all enabled effort levels", async () => {
    const catalog = await getModelCatalog();
    const sol = catalog.models.find((model) => model.ref === DEFAULT_AGENT_MODEL_REF);

    expect(DEFAULT_AGENT_MODEL_REF).toBe("openai-codex:gpt-5.6-sol");
    expect(sol).toMatchObject({
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      contextWindow: 372_000,
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      modelSpec: {
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      },
    });
  });

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

  it("falls back to the local floor when nothing is credentialed (offline first-run)", async () => {
    OfflineModelSettingsDO.config = { id: "test" };
    const { call } = await createTestDO(OfflineModelSettingsDO);

    const snapshot = await call("getSettings");
    expect(snapshot).toMatchObject({
      defaultModel: "local:lfm2.5-1.2b",
      defaultModelSource: "fallback",
    });
    const catalog = (snapshot as { catalog: ModelCatalog }).catalog;
    const local = catalog.models.find((m) => m.ref === "local:lfm2.5-1.2b");
    expect(local).toMatchObject({
      auth: "loopback",
      availability: { state: "ready" },
      tokensPerSec: 18.4,
      capabilities: { tools: true },
    });
    // Cloud entries degrade to needs-setup without credentials.
    const cloud = catalog.models.find((m) => m.ref === "openai:gpt-5");
    expect(cloud?.availability).toMatchObject({ state: "needs-setup" });
    // The journaled spec is secret-free by construction.
    expect(JSON.stringify(local?.modelSpec)).not.toMatch(/authorization|api[-_]?key/iu);
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

  it("persists extended effort levels", async () => {
    TestModelSettingsDO.config = { id: "test" };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await call("setDefaultAgentConfig", {
      model: "openai:gpt-5",
      thinkingLevel: "max",
      approvalLevel: 2,
    });

    expect(TestModelSettingsDO.writes).toEqual([
      {
        key: "defaultAgentConfig",
        value: { model: "openai:gpt-5", thinkingLevel: "max", approvalLevel: 2 },
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
