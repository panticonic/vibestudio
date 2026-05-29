import { useState } from "react";
import { Button, IconButton } from "@radix-ui/themes";
import { PlusIcon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react/responsive";
import { isAgentParticipantType } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import { AgentDialog } from "./AgentDialog";

/**
 * Header entry point for adding/switching agents. The label adapts: before the
 * conversation starts (and a single agent is present) it offers to "Switch
 * agent"; otherwise it "Add"s another agent. Reads everything from context.
 */
export function AgentLauncher() {
  const { onAddAgent, onReplaceAgent, messages, participants } = useChatContext();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!onAddAgent && !onReplaceAgent) return null;

  const agentCount = Object.values(participants).filter((p) =>
    isAgentParticipantType(p.metadata.type)
  ).length;
  const isSwitch = messages.length === 0 && agentCount === 1 && !!onReplaceAgent;
  const label = isSwitch ? "Switch agent" : "Add agent";

  return (
    <>
      {isMobile ? (
        <IconButton variant="soft" size="1" aria-label={label} onClick={() => setOpen(true)}>
          <PlusIcon />
        </IconButton>
      ) : (
        <Button variant="soft" size="1" onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      <AgentDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
