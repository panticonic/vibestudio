import { Box, Button, Callout, Flex, Text } from "@radix-ui/themes";
import { useState } from "react";
import type { ConnectProviderResult } from "@workspace/agentic-core";
import {
  CredentialConnectOptions,
  type CredentialBrowserMode,
} from "@workspace/agentic-chat/credential-connect-options";
import { getProviderConnectPreset } from "@workspace/model-catalog/providerConnect";
import type { ProviderSetupOption } from "./modelSetup.js";

interface ProviderSetupGateProps {
  providers: ProviderSetupOption[];
  localModelName?: string;
  onConnectProvider: (
    option: ProviderSetupOption,
    opts: { browser: CredentialBrowserMode }
  ) => Promise<ConnectProviderResult>;
  onUseLocalModel?: () => Promise<void>;
}

export function ProviderSetupGate({
  providers,
  localModelName,
  onConnectProvider,
  onUseLocalModel,
}: ProviderSetupGateProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [pending, setPending] = useState<CredentialBrowserMode | "local" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider =
    providers.find((option) => option.providerId === selectedProviderId) ?? null;
  const selectedPreset = selectedProvider
    ? getProviderConnectPreset(selectedProvider.providerId)
    : null;

  const connect = async (browser: CredentialBrowserMode) => {
    if (!selectedProvider) return;
    setPending(browser);
    setError(null);
    try {
      const result = await onConnectProvider(selectedProvider, { browser });
      if (!result.ok) setError(result.error ?? "Couldn't connect that provider.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const useLocal = async () => {
    if (!onUseLocalModel) return;
    setPending("local");
    setError(null);
    try {
      await onUseLocalModel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <Flex
      align="center"
      justify="center"
      style={{ minHeight: "100dvh", padding: 24, boxSizing: "border-box" }}
    >
      <Box style={{ width: "min(680px, 100%)" }}>
        <Flex direction="column" gap="4">
          <Box>
            <Text as="div" size="5" weight="bold">
              Connect an AI provider
            </Text>
            <Text as="div" size="2" color="gray" mt="2">
              Sign in or add an API key before starting this conversation. Vibestudio will use your
              connected provider as the default for this workspace.
            </Text>
          </Box>

          {selectedProvider ? (
            <Flex direction="column" gap="3">
              <Flex align="center" gap="2">
                <Button
                  size="1"
                  variant="ghost"
                  color="gray"
                  disabled={pending !== null}
                  onClick={() => {
                    setSelectedProviderId(null);
                    setError(null);
                  }}
                >
                  Back
                </Button>
                <Text size="2" weight="medium">
                  {selectedProvider.label}
                </Text>
              </Flex>
              <CredentialConnectOptions
                flowType={selectedPreset?.flow.type}
                busy={pending !== null}
                activeMode={pending === "local" ? null : pending}
                onConnect={(browser) => void connect(browser)}
              />
              {pending && pending !== "local" ? (
                <Text size="1" color="gray">
                  {selectedPreset?.flow.type === "api-key"
                    ? "Approve the credential request, then enter the key in the trusted prompt."
                    : `Approve the credential request if prompted, then finish signing in in the ${pending === "internal" ? "workspace" : "system"} browser.`}
                </Text>
              ) : null}
            </Flex>
          ) : (
            <Flex gap="2" wrap="wrap">
              {providers.map((option) => (
                <Button
                  key={option.providerId}
                  size="2"
                  variant={option.providerId === "openai-codex" ? "solid" : "soft"}
                  disabled={pending !== null}
                  onClick={() => {
                    setSelectedProviderId(option.providerId);
                    setError(null);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </Flex>
          )}

          {!selectedProvider && localModelName && onUseLocalModel ? (
            <Flex direction="column" gap="2">
              <Text size="1" color="gray">
                Or run {localModelName} on this device. This may download model files, and local
                answers can be less capable than hosted models.
              </Text>
              <Box>
                <Button
                  size="2"
                  variant="outline"
                  color="gray"
                  disabled={pending !== null}
                  loading={pending === "local"}
                  onClick={() => void useLocal()}
                >
                  Use local model
                </Button>
              </Box>
            </Flex>
          ) : null}

          {error ? (
            <Callout.Root color="red" size="1" role="alert">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}
        </Flex>
      </Box>
    </Flex>
  );
}
