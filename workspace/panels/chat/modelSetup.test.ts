import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelSettingsSnapshot } from "@workspace/model-catalog/catalog";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import {
  completeProviderSetup,
  localModelChoice,
  providerSetupOptions,
  requiresModelSetupChoice,
} from "./modelSetup.js";

function catalog(): ModelCatalog {
  return {
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        baseUrls: ["https://api.anthropic.com/v1"],
        recommendedModelRef: "anthropic:recommended",
        connectable: true,
      },
      {
        id: "openai-codex",
        label: "ChatGPT",
        baseUrls: ["https://api.openai.com/v1"],
        recommendedModelRef: "openai-codex:recommended",
        connectable: true,
      },
      {
        id: "local",
        label: "Local",
        baseUrls: ["http://127.0.0.1:43117/v1"],
        recommendedModelRef: "local:small",
        connectable: false,
      },
    ],
    models: [
      makeTestCatalogEntry({
        ref: "anthropic:other",
        id: "other",
        name: "Other Claude",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        availability: { state: "needs-setup", detail: "no-credential" },
      }),
      makeTestCatalogEntry({
        ref: "anthropic:recommended",
        id: "recommended",
        name: "Recommended Claude",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        recommended: true,
        availability: { state: "needs-setup", detail: "no-credential" },
      }),
      makeTestCatalogEntry({
        ref: "openai-codex:recommended",
        id: "recommended",
        name: "Recommended Codex",
        provider: "openai-codex",
        baseUrl: "https://api.openai.com/v1",
        recommended: true,
        availability: { state: "needs-setup", detail: "no-credential" },
      }),
      makeTestCatalogEntry({
        ref: "local:small",
        id: "small",
        name: "Small Local",
        provider: "local",
        baseUrl: "http://127.0.0.1:43117/v1",
        auth: "loopback",
        connectable: false,
        availability: { state: "startable", detail: "will-load-on-use" },
      }),
    ],
  };
}

function snapshot(overrides: Partial<ModelSettingsSnapshot> = {}): ModelSettingsSnapshot {
  return {
    catalog: catalog(),
    defaultModel: "local:small",
    defaultModelSource: "fallback",
    defaultAgentConfig: { model: "local:small" },
    ...overrides,
  };
}

describe("first-run model setup", () => {
  it("requires a choice only for an implicit fallback with no usable cloud credential", () => {
    expect(requiresModelSetupChoice(snapshot())).toBe(true);
    expect(requiresModelSetupChoice(snapshot({ defaultModelSource: "workspace" }))).toBe(false);

    const ready = catalog();
    ready.models[0] = {
      ...ready.models[0]!,
      availability: { state: "ready", detail: "credentialed" },
    };
    expect(requiresModelSetupChoice(snapshot({ catalog: ready }))).toBe(false);
  });

  it("offers each connectable provider once in canonical order with its exact recommended model", () => {
    expect(providerSetupOptions(catalog())).toEqual([
      {
        providerId: "openai-codex",
        label: "Sign in with ChatGPT Codex",
        modelRef: "openai-codex:recommended",
        modelBaseUrl: "https://api.openai.com/v1",
      },
      {
        providerId: "anthropic",
        label: "Add Anthropic API key",
        modelRef: "anthropic:recommended",
        modelBaseUrl: "https://api.anthropic.com/v1",
      },
    ]);
  });

  it("finds the usable local choice without treating it as a credential provider", () => {
    expect(localModelChoice(catalog(), "local:small")?.name).toBe("Small Local");
  });

  it("connects first and persists the exact selected model before releasing setup", async () => {
    const option = providerSetupOptions(catalog())[0]!;
    const events: string[] = [];
    const result = await completeProviderSetup(
      option,
      { model: "local:small", approvalLevel: 1 },
      async (selected, opts) => {
        events.push(`connect:${selected.providerId}:${opts.browser}`);
        return { ok: true };
      },
      { browser: "external" },
      async (config) => {
        events.push(`save:${config.model}:${config.approvalLevel}`);
      }
    );

    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["connect:openai-codex:external", "save:openai-codex:recommended:1"]);
  });
});
