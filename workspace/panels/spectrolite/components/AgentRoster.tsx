/**
 * Resident-agent management — list with remove buttons + an "Add agent"
 * menu. Rendered inside the workspace settings drawer/sheet. The header
 * shows a separate read-only `AgentBadges` strip (no controls, so the
 * settings drawer stays the only place with add/remove testids).
 */

import { useMemo, useState } from "react";
import { Badge, Button, DropdownMenu, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import { PersonIcon, PlusIcon, Cross2Icon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import { useApp, useAppState } from "../app/context";
import type { RosterAgent } from "../app/state";

export function useVisibleRoster(): RosterAgent[] {
  const roster = useAppState((s) => s.roster);
  const removedHandles = useAppState((s) => s.removedHandles);
  return useMemo(
    () => roster.filter((agent) => !removedHandles.includes(agent.handle)),
    [roster, removedHandles]
  );
}

/** Read-only avatar strip for the header. */
export function AgentBadges() {
  const agents = useVisibleRoster();
  if (agents.length === 0) return null;
  return (
    <Flex align="center" gap="1">
      {agents.map((agent) => (
        <Tooltip key={agent.handle} content={`@${agent.handle} is in the channel`}>
          <Badge variant="soft" color="iris" data-testid={`spectrolite-agent-${agent.handle}`}>
            <PersonIcon width="10" height="10" /> {agent.handle}
          </Badge>
        </Tooltip>
      ))}
    </Flex>
  );
}

export function AgentRoster() {
  const app = useApp();
  const isMobile = useIsMobile();
  const agents = useVisibleRoster();
  const availableAgents = useAppState((s) => s.availableAgents);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const add = async (agentId: string) => {
    setBusy(true);
    setOperationError(null);
    try {
      await app.session.addAgent(agentId);
    } catch (err) {
      console.warn("[Spectrolite] add agent failed:", err);
      setOperationError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (handle: string) => {
    setBusy(true);
    setOperationError(null);
    try {
      await app.session.removeAgent(handle);
    } catch (err) {
      console.warn("[Spectrolite] remove agent failed:", err);
      setOperationError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="2">
      {agents.length === 0 ? (
        <Text size="1" color="gray">
          No agents in the channel yet.
        </Text>
      ) : (
        agents.map((agent) => (
          <Flex
            key={agent.handle}
            data-testid={`spectrolite-agent-${agent.handle}`}
            align="center"
            justify="between"
            gap="2"
            px="2"
            py="1"
            className="spectrolite-agent-row"
            style={{ minHeight: isMobile ? 48 : 36 }}
          >
            <Flex align="center" gap="2">
              <span className="spectrolite-agent-avatar">
                <PersonIcon />
              </span>
              <Text size="2" weight="medium">
                @{agent.handle}
              </Text>
              <Badge size="1" color={agent.status === "live" ? "grass" : "gray"} variant="soft">
                {agent.status}
              </Badge>
            </Flex>
            <IconButton
              size="2"
              variant="ghost"
              color="gray"
              disabled={busy}
              onClick={() => void remove(agent.handle)}
              aria-label={`Remove @${agent.handle}`}
              data-testid={`spectrolite-agent-remove-${agent.handle}`}
              style={isMobile ? { minHeight: 40, minWidth: 40 } : undefined}
            >
              <Cross2Icon />
            </IconButton>
          </Flex>
        ))
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button
            size={isMobile ? "3" : "2"}
            variant="soft"
            disabled={busy || availableAgents.length === 0}
            style={{ minHeight: isMobile ? 48 : undefined }}
            data-testid="spectrolite-agent-add-trigger"
          >
            <PlusIcon /> Add agent
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {availableAgents.length === 0 ? (
            <DropdownMenu.Item disabled>(no agents available)</DropdownMenu.Item>
          ) : (
            availableAgents.map((a) => (
              <DropdownMenu.Item
                key={`${a.id}-${a.className}`}
                data-testid={`spectrolite-agent-option-${a.className}`}
                onSelect={() => void add(a.id)}
              >
                {a.name}{" "}
                <Text color="gray" size="1">
                  ({a.className})
                </Text>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {operationError ? (
        <Text color="red" size="1" role="alert" data-testid="spectrolite-agent-operation-error">
          {operationError}
        </Text>
      ) : null}
    </Flex>
  );
}
