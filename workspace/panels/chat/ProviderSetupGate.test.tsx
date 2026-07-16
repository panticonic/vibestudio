// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProviderSetupGate } from "./ProviderSetupGate.js";
import type { ProviderSetupOption } from "./modelSetup.js";

const OPTION: ProviderSetupOption = {
  providerId: "openai-codex",
  label: "Sign in with ChatGPT Codex",
  modelRef: "openai-codex:gpt-selected",
  modelBaseUrl: "https://api.openai.com/v1",
};

const API_KEY_OPTION: ProviderSetupOption = {
  providerId: "anthropic",
  label: "Add Anthropic API key",
  modelRef: "anthropic:claude-selected",
  modelBaseUrl: "https://api.anthropic.com/v1",
};

function InitialPromptProbe({
  prompt,
  modelRef,
  onProcess,
}: {
  prompt: string;
  modelRef: string;
  onProcess: (prompt: string, modelRef: string) => void;
}) {
  useEffect(() => {
    onProcess(prompt, modelRef);
  }, [modelRef, onProcess, prompt]);
  return <div>Chat mounted</div>;
}

describe("ProviderSetupGate", () => {
  it("asks where to open OAuth before connecting the exact selected provider model", async () => {
    const onConnectProvider = vi.fn(async () => ({ ok: true }));
    render(
      <Theme>
        <ProviderSetupGate providers={[OPTION]} onConnectProvider={onConnectProvider} />
      </Theme>
    );

    fireEvent.click(screen.getByRole("button", { name: OPTION.label }));
    expect(onConnectProvider).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Use workspace browser/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use system browser/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Use system browser/i }));

    await waitFor(() =>
      expect(onConnectProvider).toHaveBeenCalledWith(OPTION, { browser: "external" })
    );
  });

  it("retains the injected prompt behind the gate, then processes it exactly once on the selected model", async () => {
    const initialPrompt = "I just opened this workspace for the first time, help me get onboarded.";
    const processPrompt = vi.fn();

    function Harness() {
      const [selectedModel, setSelectedModel] = useState<string | null>(null);
      return selectedModel ? (
        <InitialPromptProbe
          prompt={initialPrompt}
          modelRef={selectedModel}
          onProcess={processPrompt}
        />
      ) : (
        <ProviderSetupGate
          providers={[OPTION]}
          onConnectProvider={async (option) => {
            setSelectedModel(option.modelRef);
            return { ok: true };
          }}
        />
      );
    }

    render(
      <Theme>
        <Harness />
      </Theme>
    );

    expect(processPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: OPTION.label }));
    expect(processPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Use workspace browser/i }));

    await waitFor(() =>
      expect(processPrompt).toHaveBeenCalledWith(initialPrompt, "openai-codex:gpt-selected")
    );
    expect(processPrompt).toHaveBeenCalledTimes(1);
  });

  it("uses secret entry for API-key providers instead of presenting browser choices", async () => {
    const onConnectProvider = vi.fn(async () => ({ ok: true }));
    render(
      <Theme>
        <ProviderSetupGate providers={[API_KEY_OPTION]} onConnectProvider={onConnectProvider} />
      </Theme>
    );

    fireEvent.click(screen.getByRole("button", { name: API_KEY_OPTION.label }));
    expect(screen.queryByRole("button", { name: /Use workspace browser/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter API key" }));

    await waitFor(() =>
      expect(onConnectProvider).toHaveBeenCalledWith(API_KEY_OPTION, { browser: "internal" })
    );
  });

  it("releases the same retained prompt after an explicit local-model choice", async () => {
    const processPrompt = vi.fn();

    function Harness() {
      const [local, setLocal] = useState(false);
      return local ? (
        <InitialPromptProbe prompt="onboard me" modelRef="local:small" onProcess={processPrompt} />
      ) : (
        <ProviderSetupGate
          providers={[]}
          localModelName="Small Local"
          onConnectProvider={async () => ({ ok: false })}
          onUseLocalModel={async () => setLocal(true)}
        />
      );
    }

    render(
      <Theme>
        <Harness />
      </Theme>
    );
    fireEvent.click(screen.getByRole("button", { name: "Use local model" }));

    await waitFor(() => expect(processPrompt).toHaveBeenCalledWith("onboard me", "local:small"));
    expect(processPrompt).toHaveBeenCalledTimes(1);
  });
});
