import React, { useRef, useState } from "react";
import { Badge, Button, Card, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { DotsHorizontalIcon } from "@radix-ui/react-icons";
import type { ChannelPresenceStatus, Participant } from "@workspace/pubsub";
import { APPROVAL_LEVELS, type ToolApprovalProps } from "@workspace/tool-ui";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata, PendingAgent } from "../types";
import {
  useAccountProfiles,
  type AccountProfile,
  type AccountRpc,
} from "../hooks/useAccountProfiles";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { PendingAgentBadge } from "./PendingAgentBadge";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { AgentLauncher } from "./AgentLauncher";
import { AgentDialog } from "./AgentDialog";
import { ForkSwitcher } from "./ForkSwitcher";
import { ChannelPeopleMenu } from "./ChannelPeopleMenu";

const NOOP = () => {};

/**
 * Self-subscribing "Open Claude Code" launcher (wide layout). Renders only when
 * the host wired {@link AgenticChatActions.onOpenClaudeCode}; the narrow layout
 * exposes the same action through the overflow menu.
 */
function ClaudeCodeLauncher() {
  const { onOpenClaudeCode, channelId, participants } = useChatContext();
  if (!onOpenClaudeCode || !channelId) return null;
  // Reflect a live linked Claude Code session from the roster (§8.1): when a
  // linked-agent vessel is present the button shows attach state (attached =
  // running/online) instead of a bare "launch".
  const linked = Object.values(participants).find(
    (p) => p.metadata.linkedAgent === true || p.metadata.agentKind === "claude-code"
  );
  const attached = linked?.metadata.linkedAttachment === "attached";
  const title = linked
    ? attached
      ? "Claude Code attached — reopen the session"
      : "Claude Code linked but offline — relaunch to reattach"
    : "Launch Claude Code";
  return (
    <Button
      variant="soft"
      size="1"
      color={attached ? "green" : undefined}
      onClick={() => void onOpenClaudeCode(channelId)}
      title={title}
    >
      {linked ? (
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            marginRight: 4,
            background: attached ? "var(--green-9)" : "var(--gray-8)",
          }}
        />
      ) : null}
      {linked ? (attached ? "Claude Code" : "Claude Code (offline)") : "Claude Code"}
    </Button>
  );
}

function friendlyConnectionStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "error":
      return "Connection failed";
    case "disconnected":
      return "Offline";
    case "connecting":
    case "connecting...":
      return "Connecting…";
    case "reconnecting":
    case "reconnecting...":
      return "Reconnecting…";
    default:
      return status || "Offline";
  }
}

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
    channelTitle,
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
    chat,
    clientRef,
  } = useChatContext();

  // Live account-profile projection for channel-stamped `user:<userId>`
  // participants (WP6 §6): handle/displayName/avatar/color resolve from the
  // host, so a hubControl.updateProfile re-renders here without roster rewrites.
  const participantIds = React.useMemo(() => Object.keys(participants), [participants]);
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    participantIds
  );

  const [participantPresenceStatus, setParticipantPresenceStatus] = useState<
    Map<string, ChannelPresenceStatus>
  >(new Map());
  React.useEffect(() => {
    if (!connected || !channelId) {
      setParticipantPresenceStatus((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const client = clientRef.current;
      if (!client) return;
      try {
        const result = await client.getChannelPresence();
        if (cancelled) return;
        const next = new Map(
          result.entries.map((entry) => [entry.participantId, entry.status] as const)
        );
        setParticipantPresenceStatus((current) =>
          mapsShallowEqual(current, next) ? current : next
        );
      } catch {
        // Preserve the last durable snapshot through a transient reconnect.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [channelId, clientRef, connected]);

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
      title={channelTitle ?? "Agentic Chat"}
      connected={connected}
      status={status}
      sessionEnabled={sessionEnabled}
      participants={participants}
      participantActiveStatus={participantActiveStatus}
      participantPresenceStatus={participantPresenceStatus}
      accountProfiles={accountProfiles}
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
  title: string;
  connected: boolean;
  status: string;
  sessionEnabled?: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantActiveStatus: Map<string, boolean>;
  participantPresenceStatus: Map<string, ChannelPresenceStatus>;
  /** Live `user:<userId>` → account profile projection (WP6 §6). */
  accountProfiles: Map<string, AccountProfile>;
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
    prev.title === next.title &&
    prev.connected === next.connected &&
    prev.status === next.status &&
    prev.sessionEnabled === next.sessionEnabled &&
    prev.participants === next.participants &&
    prev.accountProfiles === next.accountProfiles &&
    prev.pendingAgents === next.pendingAgents &&
    prev.onCallMethod === next.onCallMethod &&
    prev.toolApproval === next.toolApproval &&
    prev.onRemoveAgent === next.onRemoveAgent &&
    prev.onDebugConsoleChange === next.onDebugConsoleChange &&
    mapsShallowEqual(prev.participantActiveStatus, next.participantActiveStatus) &&
    mapsShallowEqual(prev.participantPresenceStatus, next.participantPresenceStatus)
  );
}

const ChatHeaderInner = React.memo(function ChatHeaderInner({
  channelId,
  title,
  connected,
  status,
  sessionEnabled,
  participants,
  participantActiveStatus,
  participantPresenceStatus,
  accountProfiles,
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
            {title}
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
          <Badge color={connected ? "green" : "gray"}>
            {connected ? "Connected" : friendlyConnectionStatus(status)}
          </Badge>
          {/* Fork switcher — current branch + siblings/children, next to roster.
              Self-subscribes to ChatContext.forkState (renders null when absent). */}
          <ForkSwitcher />
          <ChannelPeopleMenu />
          {Object.values(participants).map((p) => {
            const hasActive = participantActiveStatus.get(p.id) ?? false;

            return (
              <ParticipantBadgeMenu
                key={p.id}
                participant={p}
                profile={accountProfiles.get(p.id)}
                presenceStatus={participantPresenceStatus.get(p.id)}
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
          <ClaudeCodeLauncher />
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
            {title}
          </Text>
          <span
            className="chat-connection-dot"
            style={{ background: connected ? "var(--green-9)" : "var(--gray-8)" }}
            title={connected ? "Connected" : friendlyConnectionStatus(status)}
            aria-label={connected ? "Connected" : friendlyConnectionStatus(status)}
          />
          <ForkSwitcher />
          <ChannelPeopleMenu compact />
        </Flex>
        <ChatHeaderOverflowMenu
          channelId={channelId}
          sessionEnabled={sessionEnabled}
          participants={participants}
          accountProfiles={accountProfiles}
          participantPresenceStatus={participantPresenceStatus}
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
  accountProfiles,
  participantPresenceStatus,
  pendingCount,
  toolApproval,
  onRemoveAgent,
  onDebugConsoleChange,
}: {
  channelId: string | null;
  sessionEnabled?: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  accountProfiles: Map<string, AccountProfile>;
  participantPresenceStatus: Map<string, ChannelPresenceStatus>;
  pendingCount: number;
  toolApproval?: ToolApprovalProps;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}) {
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [settingsParticipantId, setSettingsParticipantId] = useState<string | null>(null);
  const { onOpenClaudeCode } = useChatContext();

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
            // Humans render their live account handle (WP6 §6); agents keep
            // their channel-carried handle.
            const handle = accountProfiles.get(p.id)?.handle ?? p.metadata.handle ?? p.id;
            const presenceStatus = participantPresenceStatus.get(p.id);
            if (!isAgentParticipantType(p.metadata.type)) {
              return (
                <DropdownMenu.Item key={p.id} disabled>
                  <Flex align="center" gap="2">
                    <span
                      aria-label={presenceStatus ?? "offline"}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background:
                          presenceStatus === "online"
                            ? "var(--green-9)"
                            : presenceStatus === "idle"
                              ? "var(--amber-9)"
                              : presenceStatus === "away"
                                ? "var(--orange-9)"
                                : "var(--gray-8)",
                      }}
                    />
                    @{handle} · {presenceStatus ?? "offline"}
                  </Flex>
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
                      <DropdownMenu.Item
                        color="red"
                        onSelect={() => {
                          if (window.confirm(`Remove @${handle} and its saved agent settings?`)) {
                            onRemoveAgent(handle);
                          }
                        }}
                      >
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
          {onOpenClaudeCode && channelId && (
            <DropdownMenu.Item onSelect={() => void onOpenClaudeCode(channelId)}>
              Open Claude Code
            </DropdownMenu.Item>
          )}
          {toolApproval && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>
                Approvals:{" "}
                {
                  APPROVAL_LEVELS[toolApproval.settings.globalFloor as keyof typeof APPROVAL_LEVELS]
                    ?.label
                }
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent>
                {([0, 1, 2] as const).map((level) => (
                  <DropdownMenu.CheckboxItem
                    key={level}
                    checked={toolApproval.settings.globalFloor === level}
                    onCheckedChange={() => {
                      void toolApproval.onSetFloor(level).catch((error: unknown) => {
                        console.error("[ChatHeader] Failed to update permission level:", error);
                      });
                    }}
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
