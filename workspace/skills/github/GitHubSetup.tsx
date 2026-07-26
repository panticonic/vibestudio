import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  Separator,
  Text,
} from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import {
  openGitHubTokenSettings,
  getGitHubOnboardingStatus,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
  type GitHubAccessLevel,
} from "./index.js";

interface GitHubSetupProps {
  props?: Record<string, never>;
  chat: {
    send(
      content: string,
      options?: { metadata?: Record<string, unknown> }
    ): Promise<unknown>;
  };
}

const ACCESS_CHOICES: Array<{
  value: GitHubAccessLevel;
  title: string;
  description: string;
  recommended?: boolean;
}> = [
  {
    value: "read-only",
    title: "Look around",
    description: "Read repositories, issues, pull requests, and Actions without changing them.",
  },
  {
    value: "collaborate",
    title: "Work with code",
    description: "Clone, pull, push, and collaborate on issues and pull requests.",
    recommended: true,
  },
  {
    value: "publish",
    title: "Publish repositories",
    description: "Create repositories, push code, and collaborate on issues and pull requests.",
  },
  {
    value: "code-workflows",
    title: "Edit Actions too",
    description: "Work with code and also change GitHub Actions workflow files.",
  },
  {
    value: "broad",
    title: "Full GitHub access",
    description: "Use the broadest supported repository permissions. Choose only when needed.",
  },
];

export default function GitHubSetup({
  chat,
}: GitHubSetupProps) {
  const [accessLevel, setAccessLevel] = useState<GitHubAccessLevel>("collaborate");
  const [busy, setBusy] = useState<"internal" | "external" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);

  useEffect(() => {
    void getGitHubOnboardingStatus({ verify: true }).then((status) => {
      if (status.verified) setConnectedAs(status.login ?? "GitHub account");
    });
  }, []);

  const run = async (
    action: "internal" | "external" | "save",
    operation: () => Promise<void>
  ) => {
    setBusy(action);
    setMessage(null);
    try {
      await operation();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
    } finally {
      setBusy(null);
    }
  };

  const openSettings = (browser: "internal" | "external") =>
    run(browser, async () => {
      await openGitHubTokenSettings({ accessLevel, browser });
      setMessage("GitHub’s token page is open. Create the token there, then return here to save it.");
    });

  const saveToken = () =>
    run("save", async () => {
      const stored = await requestGitHubTokenCredential({ accessLevel });
      const verification = await verifyGitHubCredential(stored.id);
      if (!verification.valid) {
        throw new Error(verification.error ?? "GitHub could not verify this token.");
      }
      setConnectedAs(verification.login ?? "GitHub account");
      setMessage("GitHub is connected and verified.");
    });

  const refreshOverview = () =>
    chat.send("Check the GitHub connection and refresh the setup overview.", {
      metadata: {
        interaction: {
          source: "onboarding-setup-hub",
          kind: "onboarding-capability",
          action: "check",
          targetId: "connection.github",
        },
      },
    });

  return (
    <Flex direction="column" gap="4" p="2" style={{ width: "100%", minWidth: 0 }}>
      <Box>
        <Heading size="4">Connect GitHub</Heading>
        <Text as="div" size="2" color="gray">
          Choose what Vibestudio should be able to do. We’ll configure GitHub’s recommended
          token type and keep the token in the trusted credential store.
        </Text>
      </Box>

      {connectedAs ? (
        <Box
          style={{
            border: "1px solid var(--green-6)",
            borderRadius: 8,
            padding: 12,
            background: "var(--green-2)",
          }}
        >
          <Text size="2" weight="bold">
            Connected as {connectedAs}
          </Text>
          <Text as="p" size="1" color="gray">
            The credential passed a live GitHub account check.
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text as="div" size="2" weight="bold">
          What do you want to do?
        </Text>
        <Grid
          gap="2"
          mt="2"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
          }}
        >
          {ACCESS_CHOICES.map((choice) => (
            <Button
              key={choice.value}
              variant={accessLevel === choice.value ? "solid" : "soft"}
              onClick={() => setAccessLevel(choice.value)}
              style={{ justifyContent: "flex-start", minHeight: 64, height: "auto" }}
            >
              <Flex direction="column" align="start" gap="1">
                <Text size="2" weight="bold">
                  {choice.title}
                  {choice.recommended ? " · Recommended" : ""}
                </Text>
                <Text size="1" style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {choice.description}
                </Text>
              </Flex>
            </Button>
          ))}
        </Grid>
      </Box>

      <Box>
        <Text as="div" size="2" weight="bold">
          Create the token on GitHub
        </Text>
        <Text as="div" size="1" color="gray">
          Open GitHub here for guided setup, or use your normal browser for saved sign-in,
          passkeys, and password managers.
        </Text>
        <Flex gap="2" wrap="wrap" mt="2">
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void openSettings("internal")}
          >
            <GlobeIcon />
            {busy === "internal" ? "Opening…" : "Open here"}
          </Button>
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void openSettings("external")}
          >
            <OpenInNewWindowIcon />
            {busy === "external" ? "Opening…" : "Open in my browser"}
          </Button>
        </Flex>
      </Box>

      {message ? (
        <Text size="1" color={message.startsWith("GitHub") ? "gray" : "red"}>
          {message}
        </Text>
      ) : null}

      <Separator size="4" />

      <Flex justify="end" gap="2" wrap="wrap">
        {connectedAs ? (
          <Button variant="soft" disabled={busy !== null} onClick={() => void refreshOverview()}>
            Refresh setup overview
          </Button>
        ) : null}
        <Button disabled={busy !== null} onClick={() => void saveToken()}>
          {busy === "save" ? "Opening trusted prompt…" : "I created the token — save it"}
        </Button>
      </Flex>
    </Flex>
  );
}
