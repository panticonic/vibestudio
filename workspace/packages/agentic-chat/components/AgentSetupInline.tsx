import { Box, Card, Flex, Text } from "@radix-ui/themes";
import { ArrowDownIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";
import { AgentConfigForm } from "./AgentConfigForm";

/**
 * Inline first-agent setup — replaces the "Add agent" button on a fresh chat.
 * The agent isn't created yet: these options are *armed* and applied to the
 * agent that's spawned the moment the user sends their first message. The card
 * hugs the composer to make it clear the way to start is to just type — the
 * settings are optional.
 */
export function AgentSetupInline() {
  const { deferredAgent, modelCatalog, defaultAgentConfig, onSaveDefaults } = useChatContext();

  if (!deferredAgent) return null;
  const { draft, setDraft } = deferredAgent;

  return (
    <Box
      className="agent-setup-scroll"
      style={{
        height: "100%",
        width: "100%",
        padding: "var(--space-3)",
        boxSizing: "border-box",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // Hug the composer; `safe` falls back to top-aligned (scrollable) on
        // short viewports instead of clipping the card.
        justifyContent: "safe flex-end",
      }}
    >
      <Flex direction="column" gap="2" align="center" style={{ width: "min(420px, 100%)" }}>
        <Card className="chat-surface-card agent-setup-card" size="2" variant="surface" style={{ width: "100%" }}>
          <Flex direction="column" gap="4">
            <Text size="2" weight="medium" color="gray">
              Agent settings
            </Text>
            <AgentConfigForm
              catalog={modelCatalog ?? null}
              value={draft}
              onChange={setDraft}
              modelEditable
              defaultAgentConfig={defaultAgentConfig}
              onSaveAsDefault={onSaveDefaults}
              showReactiveness={false}
              showHandle={false}
            />
          </Flex>
        </Card>
        <Flex align="center" gap="1">
          <Text size="2" color="gray">
            Nothing to configure — just type a message below to start
          </Text>
          <ArrowDownIcon width="14" height="14" style={{ color: "var(--gray-10)" }} />
        </Flex>
      </Flex>
    </Box>
  );
}
