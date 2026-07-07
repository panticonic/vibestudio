import { Badge, Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { HomeIcon, LightningBoltIcon, LockClosedIcon } from "@radix-ui/react-icons";

/**
 * First-run narrative card (design §9, item 9). Shown as the empty-transcript
 * state of a brand-new chat: it explains, once and unobtrusively, that this
 * workspace can run models on-device and that a small local model answers for
 * free and offline whenever no cloud provider is connected. It disappears the
 * moment the first message lands, so it never competes with real content.
 */
export function FirstRunCard() {
  return (
    <Flex align="center" justify="center" style={{ height: "100%", padding: 24 }}>
      <Card size="3" style={{ maxWidth: 460, width: "100%" }}>
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <HomeIcon width="18" height="18" />
            <Heading size="4">Chat runs on your terms</Heading>
          </Flex>
          <Text size="2" color="gray">
            Send a message to start. You can point this conversation at a cloud
            provider or at a model running directly on this device — switch any
            time from the model picker.
          </Text>
          <Box>
            <Flex direction="column" gap="2">
              <Feature
                icon={<HomeIcon width="14" height="14" />}
                color="green"
                title="On-device fallback"
                body="If no cloud provider is connected, a small local model (LFM2.5) answers automatically — free, with nothing leaving your machine."
              />
              <Feature
                icon={<LightningBoltIcon width="14" height="14" />}
                color="amber"
                title="Loaded on demand"
                body="The local fallback isn't kept running. It loads the first time it's needed, so it costs nothing until you use it."
              />
              <Feature
                icon={<LockClosedIcon width="14" height="14" />}
                color="blue"
                title="Your keys, your models"
                body="Connect providers or download local models from the model picker and the Local Models panel."
              />
            </Flex>
          </Box>
        </Flex>
      </Card>
    </Flex>
  );
}

function Feature({
  icon,
  color,
  title,
  body,
}: {
  icon: React.ReactNode;
  color: "green" | "amber" | "blue";
  title: string;
  body: string;
}) {
  return (
    <Flex gap="3" align="start">
      <Badge color={color} variant="soft" size="1" style={{ marginTop: 2, flexShrink: 0 }}>
        {icon}
      </Badge>
      <Box style={{ minWidth: 0 }}>
        <Text size="2" weight="medium" as="p">
          {title}
        </Text>
        <Text size="1" color="gray" as="p">
          {body}
        </Text>
      </Box>
    </Flex>
  );
}
