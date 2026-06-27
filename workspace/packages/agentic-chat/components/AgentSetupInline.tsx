import { useMemo } from "react";
import { Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { MagicWandIcon, PaperPlaneIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { AgentTypeCard } from "./AgentTypeCard";

/**
 * Inline first-agent setup — replaces the "Add agent" button on a fresh chat.
 * The agent isn't created yet: these options are *armed* and applied to the
 * agent that's spawned the moment the user sends their first message. The copy
 * makes that explicit ("added when you send"), and the form can be left as-is to
 * accept the workspace defaults.
 */
export function AgentSetupInline() {
  const { deferredAgent, modelCatalog, connectedModelRefs, defaultAgentConfig, onSaveDefaults } =
    useChatContext();
  const connectedRefs = useMemo(() => new Set(connectedModelRefs ?? []), [connectedModelRefs]);

  if (!deferredAgent) return null;
  const { draft, setDraft, agentId, setAgentId, availableAgents } = deferredAgent;
  const showGallery = availableAgents.length > 1;

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
        // `safe center` keeps the card centered when it fits but falls back to
        // top-aligned (scrollable) on short viewports instead of clipping it.
        justifyContent: "safe center",
      }}
    >
      <Card
        className="chat-surface-card agent-setup-card"
        size="3"
        variant="surface"
        style={{ width: "min(460px, 100%)" }}
      >
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1" align="center" style={{ textAlign: "center" }}>
            <Box className="agent-setup-glyph" aria-hidden>
              <MagicWandIcon width="22" height="22" />
            </Box>
            <Heading as="h2" size="4">
              Set up your agent
            </Heading>
            <Flex align="center" gap="1" justify="center" wrap="wrap">
              <PaperPlaneIcon width="12" height="12" style={{ color: "var(--accent-11)" }} />
              <Text size="2" color="gray">
                Added automatically when you send your first message.
              </Text>
            </Flex>
            <Text size="1" color="gray">
              Adjust the options below, or just start typing to use these defaults.
            </Text>
          </Flex>

          {showGallery && (
            <Flex direction="column" gap="2">
              {availableAgents.map((a) => (
                <AgentTypeCard
                  key={`${a.id}:${a.className}`}
                  agent={a}
                  selected={a.id === agentId}
                  onSelect={() => setAgentId(a.id)}
                />
              ))}
            </Flex>
          )}

          <AgentConfigForm
            catalog={modelCatalog ?? null}
            connectedRefs={connectedRefs}
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
    </Box>
  );
}
