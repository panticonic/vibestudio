import { Button, Flex, Spinner, Text } from "@radix-ui/themes";

export type CredentialBrowserMode = "internal" | "external";

export interface CredentialConnectOptionsProps {
  flowType?: string;
  busy?: boolean;
  connected?: boolean;
  activeMode?: CredentialBrowserMode | null;
  reconnect?: boolean;
  onConnect: (mode: CredentialBrowserMode) => void;
}

/**
 * The canonical user choice immediately before starting a provider credential
 * flow. OAuth always asks where to open sign-in; secret-entry flows have one
 * explicit action because they do not open a browser.
 */
export function CredentialConnectOptions({
  flowType,
  busy = false,
  connected = false,
  activeMode = null,
  reconnect = false,
  onConnect,
}: CredentialConnectOptionsProps) {
  if (flowType === "api-key") {
    return (
      <Flex gap="2" wrap="wrap">
        <Button size="1" onClick={() => onConnect("internal")} disabled={busy || connected}>
          {busy ? <Spinner size="1" /> : null}
          {connected ? "Connected" : reconnect ? "Update API key" : "Enter API key"}
        </Button>
      </Flex>
    );
  }

  const internalLabel = reconnect ? "Refresh in workspace browser" : "Use workspace browser";
  const externalLabel = reconnect ? "Refresh in system browser" : "Use system browser";

  return (
    <Flex direction="column" gap="2">
      <Text as="div" size="1" color="gray">
        {reconnect
          ? "Choose the browser that is signed in to the account you want to reconnect. If neither is signed in, pick the one you want to use."
          : "Choose the browser that is already signed in to the account you want to connect. If neither is signed in, pick the one you want to use."}
      </Text>
      <Flex direction="column" gap="2">
        <Button
          size="1"
          onClick={() => onConnect("internal")}
          disabled={busy || connected}
          style={{
            alignItems: "flex-start",
            height: "auto",
            justifyContent: "flex-start",
            paddingBottom: 8,
            paddingTop: 8,
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          {busy && activeMode === "internal" ? <Spinner size="1" /> : null}
          <Flex direction="column" gap="1" align="start">
            <Text as="span" size="1" weight="medium">
              {internalLabel}
            </Text>
            <Text as="span" size="1">
              Choose this when the account is signed in inside this workspace.
            </Text>
          </Flex>
        </Button>
        <Button
          size="1"
          variant="soft"
          onClick={() => onConnect("external")}
          disabled={busy || connected}
          style={{
            alignItems: "flex-start",
            height: "auto",
            justifyContent: "flex-start",
            paddingBottom: 8,
            paddingTop: 8,
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          {busy && activeMode === "external" ? <Spinner size="1" /> : null}
          <Flex direction="column" gap="1" align="start">
            <Text as="span" size="1" weight="medium">
              {externalLabel}
            </Text>
            <Text as="span" size="1" color="gray">
              Choose this when your regular browser already has the right account.
            </Text>
          </Flex>
        </Button>
      </Flex>
    </Flex>
  );
}
