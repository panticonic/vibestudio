import { useMemo, useState } from "react";
import { Button, Card, Dialog, Flex, Text } from "@radix-ui/themes";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata } from "../types";
import { useAccountProfiles, type AccountRpc } from "../hooks/useAccountProfiles";
import { ChannelPeopleMenu } from "./ChannelPeopleMenu";
import { ForkSwitcher } from "./ForkSwitcher";
import { LazyAgentDialog } from "./LazyAgentDialog";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";

interface ChatNativeActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Touch-oriented conversation controls opened from the native panel menu. */
export function ChatNativeActionsDialog({ open, onOpenChange }: ChatNativeActionsDialogProps) {
  const {
    channelId,
    participants,
    messages,
    chat,
    deferredAgent,
    toolApproval,
    onAddAgent,
    onReplaceAgent,
    onOpenClaudeCode,
    onRemoveAgent,
    onDebugConsoleChange,
  } = useChatContext();
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [settingsParticipantId, setSettingsParticipantId] = useState<string | null>(null);
  const participantIds = useMemo(() => Object.keys(participants), [participants]);
  const accountProfiles = useAccountProfiles(
    (chat as { rpc?: AccountRpc } | undefined)?.rpc,
    participantIds
  );
  const agents = useMemo(
    () =>
      Object.values(participants).filter((participant) =>
        isAgentParticipantType(participant.metadata.type)
      ),
    [participants]
  );
  const canChangeAgent = (!!onAddAgent || !!onReplaceAgent) && !deferredAgent?.active;
  const agentActionLabel =
    messages.length === 0 && agents.length === 1 && onReplaceAgent ? "Switch agent" : "Add agent";

  const leaveDialog = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Content className="chat-native-actions-dialog" maxWidth="440px">
          <Dialog.Title>Conversation actions</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Manage this conversation without adding another toolbar to the panel.
          </Dialog.Description>

          <Flex direction="column" gap="4" mt="4">
            <Flex direction="column" gap="2">
              <Text size="1" weight="bold" color="gray">
                Conversation
              </Text>
              <Flex gap="2" wrap="wrap">
                <ForkSwitcher />
                <ChannelPeopleMenu />
              </Flex>
            </Flex>

            <Flex direction="column" gap="2">
              <Text size="1" weight="bold" color="gray">
                Agents
              </Text>
              {agents.map((participant) => {
                const typedParticipant = participant as typeof participant & {
                  metadata: ChatParticipantMetadata;
                };
                const handle =
                  accountProfiles.get(participant.id)?.handle ??
                  typedParticipant.metadata.handle ??
                  participant.id;
                return (
                  <Card key={participant.id} size="1" variant="surface">
                    <Flex align="center" justify="between" gap="2" wrap="wrap">
                      <Text size="2" weight="medium">
                        @{handle}
                      </Text>
                      <Flex gap="2" wrap="wrap">
                        <Button
                          size="2"
                          variant="soft"
                          onClick={() =>
                            leaveDialog(() => setSettingsParticipantId(participant.id))
                          }
                        >
                          Settings
                        </Button>
                        {onDebugConsoleChange ? (
                          <Button
                            size="2"
                            variant="soft"
                            color="gray"
                            onClick={() => leaveDialog(() => onDebugConsoleChange(handle))}
                          >
                            Debug
                          </Button>
                        ) : null}
                        {onRemoveAgent ? (
                          <Button
                            size="2"
                            variant="soft"
                            color="red"
                            onClick={() => {
                              if (
                                window.confirm(`Remove @${handle} and its saved agent settings?`)
                              ) {
                                leaveDialog(() => onRemoveAgent(handle));
                              }
                            }}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </Flex>
                    </Flex>
                  </Card>
                );
              })}
              <Flex gap="2" wrap="wrap">
                {canChangeAgent ? (
                  <Button size="2" onClick={() => leaveDialog(() => setAddAgentOpen(true))}>
                    {agentActionLabel}
                  </Button>
                ) : null}
                {onOpenClaudeCode && channelId ? (
                  <Button
                    size="2"
                    variant="soft"
                    onClick={() =>
                      leaveDialog(() => {
                        void onOpenClaudeCode(channelId);
                      })
                    }
                  >
                    Open Claude Code
                  </Button>
                ) : null}
              </Flex>
            </Flex>

            {toolApproval ? (
              <Flex direction="column" gap="2">
                <Text size="1" weight="bold" color="gray">
                  Autonomy
                </Text>
                <Flex>
                  <ToolPermissionsDropdown
                    settings={toolApproval.settings}
                    onSetFloor={toolApproval.onSetFloor}
                  />
                </Flex>
              </Flex>
            ) : null}
          </Flex>

          <Flex justify="end" mt="5">
            <Dialog.Close>
              <Button variant="soft" color="gray" size="2">
                Done
              </Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <LazyAgentDialog open={addAgentOpen} onOpenChange={setAddAgentOpen} />
      {settingsParticipantId ? (
        <LazyAgentDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSettingsParticipantId(null);
          }}
          editParticipantId={settingsParticipantId}
        />
      ) : null}
    </>
  );
}
