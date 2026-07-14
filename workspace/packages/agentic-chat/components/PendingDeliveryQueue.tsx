import { Box, Button, Card, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { Cross2Icon, ExclamationTriangleIcon, ImageIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";

/**
 * Pre-send delivery queue — the messages the user sent before any agent existed.
 * They are held client-side (unsent) and flush LIVE once the spawned agent joins
 * the roster. A spinner + plain-language line explain the wait ("Launching
 * agent…"); if the launch fails, an error + Retry replaces the spinner. Each
 * item can be removed before it is delivered. Sits just above the composer, in
 * the slot the post-join Outbox uses (the two are never both non-empty).
 */
export function PendingDeliveryQueue() {
  const { deferredAgent } = useChatContext();
  if (!deferredAgent || deferredAgent.queued.length === 0) return null;
  const { queued, launching, launchFailed, launchError, retryLaunch, cancelQueued } = deferredAgent;

  return (
    <Box flexShrink="0" className="pending-delivery-root" data-testid="pending-delivery-queue">
      <Card
        className={`chat-surface-card pending-delivery-card${launchFailed ? " pending-delivery-card-failed" : ""}`}
        size="1"
        variant="surface"
      >
        <Flex align="center" justify="between" gap="2" className="pending-delivery-header">
          <Flex align="center" gap="2" style={{ minWidth: 0 }} role="status" aria-live="polite">
            {launchFailed ? (
              <>
                <ExclamationTriangleIcon style={{ color: "var(--red-9)", flexShrink: 0 }} />
                <Text size="1" color="red" weight="medium" truncate>
                  Couldn't start your agent — these send once it's running.
                </Text>
              </>
            ) : (
              <>
                <Spinner size="1" />
                <Text size="1" color="gray" weight="medium" truncate>
                  {launching
                    ? "Launching your agent — these send the moment it joins…"
                    : "Waiting for an agent to join — these send as soon as one does…"}
                </Text>
              </>
            )}
          </Flex>
          {launchFailed && (
            <Button
              size="1"
              variant="soft"
              color="red"
              className="app-touch-target"
              onClick={retryLaunch}
            >
              <ReloadIcon />
              Retry
            </Button>
          )}
        </Flex>
        {launchFailed && launchError && (
          <Text
            as="p"
            size="1"
            color="red"
            mt="1"
            className="pending-delivery-error"
            data-testid="agent-launch-error"
          >
            {launchError}
          </Text>
        )}
        <Flex
          direction="column"
          gap="1"
          mt="2"
          role="list"
          aria-label="Messages waiting for your agent"
          className="pending-delivery-list"
        >
          {queued.map((m) => {
            const attachmentCount = m.attachments?.length ?? 0;
            return (
              <Flex
                key={m.id}
                role="listitem"
                align="center"
                justify="between"
                gap="2"
                className="pending-delivery-item"
              >
                <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                  {attachmentCount > 0 && <ImageIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />}
                  <Text size="2" truncate className="pending-delivery-text">
                    {m.text || (attachmentCount > 0 ? `${attachmentCount} image${attachmentCount > 1 ? "s" : ""}` : "")}
                  </Text>
                </Flex>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="app-touch-target"
                  aria-label="Remove queued message"
                  title="Remove before it sends"
                  onClick={() => cancelQueued(m.id)}
                >
                  <Cross2Icon />
                </IconButton>
              </Flex>
            );
          })}
        </Flex>
      </Card>
    </Box>
  );
}
