import React, { useRef, useState } from "react";
import { Badge, Card, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { DotsHorizontalIcon } from "@radix-ui/react-icons";
import type { Participant } from "@workspace/pubsub";
import { APPROVAL_LEVELS, type ToolApprovalProps } from "@workspace/tool-ui";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata, PendingAgent } from "../types";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { PendingAgentBadge } from "./PendingAgentBadge";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { AgentLauncher } from "./AgentLauncher";
import { AgentDialog } from "./AgentDialog";

const NOOP = () => {};

/** Shallow-compare two Maps by entry value (used for small maps like activeStatus). */
function mapsShallowEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (b.get(key) !== val) return false;
  }
  return true;
}

/**
 * Chat header bar with connection status, participant badges, and actions.
 * Reads all data from ChatContext.
 *
 * The participantActiveStatus is stabilised with a ref — the previous Map
 * reference is returned when the values haven't changed so that the inner
 * React.memo boundary isn't defeated during streaming (messages changes
 * every frame but active-status rarely flips).
 */
export function ChatHeader() {
  const {
    channelId,
    connected,
    status,
    sessionEnabled,
    messages,
    participants,
    pendingAgents,
    toolApproval,
    onCallMethod,
    onDebugConsoleChange,
    onRemoveAgent,
  } = useChatContext();

  // Memoize participant active status: single reverse scan instead of O(P*M) filter per render.
  // Stabilised with a ref — return the previous Map reference when the values haven't
  // changed so that ChatHeaderInner's React.memo boundary isn't defeated during streaming.
  const prevActiveStatusRef = useRef<Map<string, boolean>>(new Map());
  const participantActiveStatus = React.useMemo(() => {
    const statusMap = new Map<string, boolean>();
    const pIds = new Set(Object.keys(participants));
    const found = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && found.size < pIds.size; i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.kind !== "message" || !pIds.has(msg.senderId) || found.has(msg.senderId)) continue;
      statusMap.set(msg.senderId, !msg.complete && !msg.error);
      found.add(msg.senderId);
    }

    // Return previous reference if values are identical (avoids breaking memo)
    const prev = prevActiveStatusRef.current;
    if (mapsShallowEqual(prev, statusMap)) return prev;
    prevActiveStatusRef.current = statusMap;
    return statusMap;
  }, [messages, participants]);

  return (
    <ChatHeaderInner
      channelId={channelId}
      connected={connected}
      status={status}
      sessionEnabled={sessionEnabled}
      participants={participants}
      participantActiveStatus={participantActiveStatus}
      pendingAgents={pendingAgents}
      onCallMethod={onCallMethod}
      toolApproval={toolApproval}
      onRemoveAgent={onRemoveAgent}
      onDebugConsoleChange={onDebugConsoleChange}
    />
  );
}

// ---------- Memoized inner component ----------

interface ChatHeaderInnerProps {
  channelId: string | null;
  connected: boolean;
  status: string;
  sessionEnabled?: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantActiveStatus: Map<string, boolean>;
  pendingAgents: Map<string, PendingAgent>;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  toolApproval?: ToolApprovalProps;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}

function chatHeaderInnerPropsEqual(
  prev: ChatHeaderInnerProps,
  next: ChatHeaderInnerProps
): boolean {
  return (
    prev.channelId === next.channelId &&
    prev.connected === next.connected &&
    prev.status === next.status &&
    prev.sessionEnabled === next.sessionEnabled &&
    prev.participants === next.participants &&
    prev.pendingAgents === next.pendingAgents &&
    prev.onCallMethod === next.onCallMethod &&
    prev.toolApproval === next.toolApproval &&
    prev.onRemoveAgent === next.onRemoveAgent &&
    prev.onDebugConsoleChange === next.onDebugConsoleChange &&
    mapsShallowEqual(prev.participantActiveStatus, next.participantActiveStatus)
  );
}

const ChatHeaderInner = React.memo(function ChatHeaderInner({
  channelId,
  connected,
  status,
  sessionEnabled,
  participants,
  participantActiveStatus,
  pendingAgents,
  onCallMethod,
  toolApproval,
  onRemoveAgent,
  onDebugConsoleChange,
}: ChatHeaderInnerProps) {
  const visiblePendingAgents = pendingAgents
    ? Array.from(pendingAgents.entries()).filter(([handle, _info]) => {
        // Hide pending badge if a participant with this handle already joined.
        return !Object.values(participants ?? {}).some(
          (p) => (p?.metadata?.handle as string | undefined) === handle
        );
      })
    : [];

  return (
    <Card
      className="chat-surface-card chat-header-card"
      size="1"
      variant="surface"
      style={{ flexShrink: 0 }}
    >
      {/* Wide layout */}
      <Flex
        className="chat-wide-only"
        justify="between"
        align="center"
        wrap="wrap"
        gap="2"
        style={{ minWidth: 0 }}
      >
        <Flex gap="2" align="center" wrap="wrap" style={{ minWidth: 0, flex: "1 1 240px" }}>
          <Text size="5" weight="bold" style={{ minWidth: 0 }}>
            Agentic Chat
          </Text>
          <Badge
            color={sessionEnabled ? "blue" : "orange"}
            title={
              (sessionEnabled
                ? "Session persistence enabled - messages are saved and can be replayed"
                : "Ephemeral session - messages are not persisted") +
              (channelId ? ` — channel ${channelId}` : "")
            }
          >
            {sessionEnabled ? "Session" : "Ephemeral"}
          </Badge>
        </Flex>
        <Flex gap="2" align="center" wrap="wrap" style={{ minWidth: 0 }}>
          <Badge color={connected ? "green" : "gray"}>{connected ? "Connected" : status}</Badge>
          {Object.values(participants).map((p) => {
            const hasActive = participantActiveStatus.get(p.id) ?? false;

            return (
              <ParticipantBadgeMenu
                key={p.id}
                participant={p}
                hasActiveMessage={hasActive}
                onCallMethod={onCallMethod ?? NOOP}
                onRemoveAgent={onRemoveAgent}
                onOpenDebugConsole={onDebugConsoleChange ?? undefined}
              />
            );
          })}
          {/* Pending/failed agents not yet in roster */}
          {visiblePendingAgents.map(([handle, info]) => (
            <PendingAgentBadge
              key={`pending-${handle}`}
              handle={handle}
              agentId={info.agentId}
              status={info.status}
              error={info.error}
              onOpenDebugConsole={onDebugConsoleChange ?? undefined}
            />
          ))}
          <AgentLauncher />
          {toolApproval && (
            <ToolPermissionsDropdown
              settings={toolApproval.settings}
              onSetFloor={toolApproval.onSetFloor}
            />
          )}
        </Flex>
      </Flex>

      {/* Narrow layout — title + connection dot + one overflow menu */}
      <Flex
        className="chat-narrow-only"
        justify="between"
        align="center"
        gap="2"
        style={{ minWidth: 0 }}
      >
        <Flex gap="2" align="center" style={{ minWidth: 0 }}>
          <Text size="4" weight="bold" truncate style={{ minWidth: 0 }}>
            Agentic Chat
          </Text>
          <span
            className="chat-connection-dot"
            style={{ background: connected ? "var(--green-9)" : "var(--gray-8)" }}
            title={connected ? "Connected" : status}
            aria-label={connected ? "Connected" : status}
          />
        </Flex>
        <ChatHeaderOverflowMenu
          channelId={channelId}
          sessionEnabled={sessionEnabled}
          participants={participants}
          pendingCount={visiblePendingAgents.length}
          toolApproval={toolApproval}
          onRemoveAgent={onRemoveAgent}
          onDebugConsoleChange={onDebugConsoleChange}
        />
      </Flex>
    </Card>
  );
}, chatHeaderInnerPropsEqual);

/**
 * Single overflow menu for narrow containers: session info, participant
 * management, Add agent, and approval mode all live here so the compact
 * header stays minimal.
 */
function ChatHeaderOverflowMenu({
  channelId,
  sessionEnabled,
  participants,
  pendingCount,
  toolApproval,
  onRemoveAgent,
  onDebugConsoleChange,
}: {
  channelId: string | null;
  sessionEnabled?: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  pendingCount: number;
  toolApproval?: ToolApprovalProps;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}) {
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [settingsParticipantId, setSettingsParticipantId] = useState<string | null>(null);

  const participantList = Object.values(participants);
  const agentCount =
    participantList.filter((p) => isAgentParticipantType(p.metadata.type)).length + pendingCount;

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            variant="soft"
            color="gray"
            size="2"
            aria-label="Chat menu"
            style={{ minWidth: 40, minHeight: 40 }}
          >
            <Flex align="center" gap="1">
              {agentCount > 0 && (
                <Text size="1" weight="medium">
                  {agentCount} {agentCount === 1 ? "agent" : "agents"}
                </Text>
              )}
              <DotsHorizontalIcon />
            </Flex>
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Label>
            {sessionEnabled ? "Session" : "Ephemeral"}
            {channelId ? ` — ${channelId}` : ""}
          </DropdownMenu.Label>
          {participantList.length > 0 && <DropdownMenu.Separator />}
          {participantList.map((p) => {
            const handle = p.metadata.handle;
            if (!isAgentParticipantType(p.metadata.type)) {
              return (
                <DropdownMenu.Item key={p.id} disabled>
                  @{handle}
                </DropdownMenu.Item>
              );
            }
            return (
              <DropdownMenu.Sub key={p.id}>
                <DropdownMenu.SubTrigger>@{handle}</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent>
                  <DropdownMenu.Item onSelect={() => setSettingsParticipantId(p.id)}>
                    Settings…
                  </DropdownMenu.Item>
                  {onDebugConsoleChange && (
                    <DropdownMenu.Item onSelect={() => onDebugConsoleChange(handle)}>
                      Debug Console
                    </DropdownMenu.Item>
                  )}
                  {onRemoveAgent && (
                    <>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item color="red" onSelect={() => onRemoveAgent(handle)}>
                        Remove Agent
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            );
          })}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => setAddAgentOpen(true)}>Add agent</DropdownMenu.Item>
          {toolApproval && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>
                Approvals:{" "}
                {APPROVAL_LEVELS[toolApproval.settings.globalFloor as keyof typeof APPROVAL_LEVELS]
                  ?.label}
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent>
                {([0, 1, 2] as const).map((level) => (
                  <DropdownMenu.CheckboxItem
                    key={level}
                    checked={toolApproval.settings.globalFloor === level}
                    onCheckedChange={() => toolApproval.onSetFloor(level)}
                  >
                    {APPROVAL_LEVELS[level].label}
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <AgentDialog open={addAgentOpen} onOpenChange={setAddAgentOpen} />
      {settingsParticipantId && (
        <AgentDialog
          open
          onOpenChange={(open) => {
            if (!open) setSettingsParticipantId(null);
          }}
          editParticipantId={settingsParticipantId}
        />
      )}
    </>
  );
}
