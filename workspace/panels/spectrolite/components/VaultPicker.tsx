/** Pick an existing semantic repository to use as a Spectrolite vault. */

import { useEffect, useState } from "react";
import { Box, Card, Code, Flex, Heading, IconButton, Spinner, Text } from "@radix-ui/themes";
import { ArchiveIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import { discoverVaults, type VaultEntry } from "../state/vaultDiscovery";

export interface VaultPickerProps {
  agentHandle?: string;
  onSelect: (contextPath: string) => void;
}

export function VaultPicker({ agentHandle, onSelect }: VaultPickerProps) {
  const isMobile = useIsMobile();
  const [vaults, setVaults] = useState<VaultEntry[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setVaults(null);
    setDiscoverError(null);
    discoverVaults()
      .then((entries) => {
        if (!cancelled) setVaults(entries);
      })
      .catch((error) => {
        if (cancelled) return;
        setVaults([]);
        setDiscoverError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  return (
    <Flex
      align={isMobile ? "start" : "center"}
      justify="center"
      className="spectrolite-picker"
      style={{ minHeight: "100%" }}
      p={isMobile ? "4" : "6"}
    >
      <Flex direction="column" gap="5" style={{ maxWidth: 560, width: "100%" }}>
        <Flex direction="column" gap="2" align="center" mt={isMobile ? "4" : "0"}>
          <span className="spectrolite-gem" aria-hidden>
            ◆
          </span>
          <Heading size="6" align="center">
            Spectrolite
          </Heading>
          <Text size="2" color="gray" align="center" as="p" style={{ maxWidth: 420 }}>
            A live MDX knowledge base with a resident editing agent
            {agentHandle ? (
              <>
                {" "}
                — <Text weight="medium">@{agentHandle}</Text> is already in the room.
              </>
            ) : null}{" "}
            Vaults are semantic repositories under <Code>projects/</Code>.
          </Text>
        </Flex>

        <Card size="2">
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between">
              <Text size="2" weight="bold">
                Open a vault
              </Text>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                onClick={() => setRefreshNonce((value) => value + 1)}
                aria-label="Refresh vault list"
              >
                <ReloadIcon />
              </IconButton>
            </Flex>
            {vaults === null ? (
              <Flex align="center" gap="2" py="2">
                <Spinner />
                <Text size="1" color="gray">
                  Scanning workspace…
                </Text>
              </Flex>
            ) : vaults.length === 0 ? (
              <Text size="1" color="gray">
                {discoverError
                  ? `Could not scan the workspace: ${discoverError}`
                  : "No semantic vault repositories are available."}
              </Text>
            ) : (
              <Flex direction="column" gap="1">
                {vaults.map((vault) => (
                  <button
                    key={vault.relPath}
                    type="button"
                    className="spectrolite-vault-row"
                    onClick={() => onSelect(vault.contextPath)}
                    data-testid={`spectrolite-vault-${vault.name}`}
                  >
                    <span className="spectrolite-vault-icon">
                      <ArchiveIcon />
                    </span>
                    <Box style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                      <Text size="2" weight="medium" as="div" truncate>
                        {vault.name}
                      </Text>
                      <Text size="1" color="gray" as="div" truncate>
                        {vault.relPath}
                      </Text>
                    </Box>
                  </button>
                ))}
              </Flex>
            )}
          </Flex>
        </Card>
      </Flex>
    </Flex>
  );
}
