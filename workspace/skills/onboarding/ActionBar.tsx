import { Button, Flex, Spinner, Text } from "@radix-ui/themes";
import { ReloadIcon } from "@radix-ui/react-icons";
import { useState } from "react";

interface ActionBarProps {
  props?: {
    mode?: "preparing" | "resume" | "reopen" | "error";
    label?: string;
  };
  chat: {
    send: (content: string, options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
  };
}

export default function OnboardingActionBar({ props, chat }: ActionBarProps) {
  const mode = props?.mode ?? "preparing";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(action: "resume" | "refresh") {
    setPending(true);
    setError(null);
    try {
      await chat.send(action === "resume" ? "Resume setup" : "Open a fresh setup overview", {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-overview",
            action,
            targetId: "setup-overview",
          },
        },
      });
    } catch {
      setError("Setup could not be opened. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (mode === "preparing") {
    return (
      <Flex align="center" gap="2" px="3" py="2">
        <Spinner size="1" />
        <Text size="1" color="gray">
          Preparing setup overview…
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="1" px="3" py="2">
      <Flex align="center" justify="between" gap="2">
        <Text size="1" color={mode === "error" ? "red" : "gray"}>
          {props?.label ??
            (mode === "resume"
              ? "A setup workflow is ready to resume."
              : mode === "error"
                ? "The setup overview needs another try."
                : "Setup")}
        </Text>
        <Button
          size="1"
          variant="soft"
          disabled={pending}
          onClick={() => void send(mode === "resume" ? "resume" : "refresh")}
        >
          <ReloadIcon />
          {pending ? "Opening…" : mode === "resume" ? "Resume" : "Open setup"}
        </Button>
      </Flex>
      {error ? (
        <Text size="1" color="red" role="alert">
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
