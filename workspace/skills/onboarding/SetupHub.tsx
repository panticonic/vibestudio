import { Badge, Box, Button, Callout, Card, Flex, Separator, Text } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { useState } from "react";
import {
  onboardingCatalog,
  type OnboardingCapabilityDefinition,
  type SetupAction,
} from "./catalog";
import type { SetupCapabilitySnapshot } from "./snapshot";

interface SetupHubProps {
  props: {
    snapshot?: SetupCapabilitySnapshot[];
  };
  chat: {
    send: (content: string, options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
  };
}

const statePresentation = {
  connected: { label: "Connected", color: "green" },
  "connected-unverified": { label: "Connected · not checked", color: "blue" },
  configured: { label: "Configured", color: "green" },
  "using-defaults": { label: "Using defaults", color: "gray" },
  "not-configured": { label: "Not configured", color: "gray" },
  "in-progress": { label: "In progress", color: "blue" },
  "needs-attention": { label: "Needs attention", color: "red" },
  unavailable: { label: "Unavailable", color: "orange" },
  unknown: { label: "Unknown", color: "gray" },
} as const;

const actionLabels: Record<SetupAction, string> = {
  setup: "Set up",
  repair: "Repair",
  reconnect: "Reconnect",
  check: "Check connection",
  inspect: "Inspect",
  revoke: "Revoke",
  change: "Change",
  grants: "Agent access",
  resume: "Resume",
  refresh: "Refresh",
  explore: "Explore",
};

const scopeLabels = {
  "user-workspace": "You in this workspace",
  workspace: "Workspace",
  server: "Server",
  device: "Device",
  channel: "Channel",
  project: "Project",
} as const;

function readableAction(definition: OnboardingCapabilityDefinition, action: SetupAction): string {
  return `${actionLabels[action]} ${definition.title}`;
}

function formatObservation(iso: string): { label: string; stale: boolean } {
  const observed = Date.parse(iso);
  if (!Number.isFinite(observed)) return { label: "Observation time unavailable", stale: true };
  const ageMs = Date.now() - observed;
  if (ageMs < 60_000) return { label: "Observed just now", stale: false };
  if (ageMs < 5 * 60_000) {
    return { label: `Observed ${Math.max(1, Math.floor(ageMs / 60_000))}m ago`, stale: false };
  }
  return {
    label: `As of ${new Date(observed).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`,
    stale: true,
  };
}

function SetupRow({
  definition,
  snapshot,
  pending,
  onAction,
}: {
  definition: OnboardingCapabilityDefinition;
  snapshot: SetupCapabilitySnapshot;
  pending: string | null;
  onAction: (definition: OnboardingCapabilityDefinition, action: SetupAction) => void;
}) {
  const presentation = statePresentation[snapshot.state];
  const observation = formatObservation(snapshot.observedAt);
  const managementActions = (["inspect", "revoke", "grants"] as const).filter(
    (action) => definition.actions?.[action]
  );
  return (
    <Card size="1">
      <Flex align="start" justify="between" gap="2" wrap="wrap">
        <details style={{ minWidth: 0, flex: "1 1 220px" }}>
          <summary
            aria-label={`${definition.title}: ${presentation.label}`}
            style={{ listStyle: "none", cursor: "pointer" }}
          >
            <Flex align="center" gap="2" style={{ minWidth: 0, flex: "1 1 180px" }}>
              <ChevronRightIcon aria-hidden />
              <Box style={{ minWidth: 0 }}>
                <Text as="div" size="2" weight="medium">
                  {definition.title}
                </Text>
                <Text as="div" size="1" color="gray">
                  {snapshot.summary}
                </Text>
              </Box>
            </Flex>
          </summary>
          <Separator size="4" my="2" />
          <Flex direction="column" gap="2" pl="4">
            <Text size="1">{definition.summary}</Text>
            <Flex align="center" gap="2" wrap="wrap">
              <Badge size="1" color="gray" variant="outline">
                {scopeLabels[snapshot.scope]}
              </Badge>
              <Badge size="1" color="gray" variant="outline">
                {snapshot.tier === "host-topology" ? "Host topology" : "Capability owner"}
              </Badge>
              <Badge size="1" color={observation.stale ? "orange" : "gray"} variant="outline">
                {observation.label}
              </Badge>
            </Flex>
            <Text size="1" color="gray">
              Ready when: {definition.setup?.successDescription}
            </Text>
            <Flex gap="1" wrap="wrap">
              {managementActions.map((action) => (
                <Button
                  key={action}
                  size="1"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => onAction(definition, action)}
                >
                  {actionLabels[action]}
                </Button>
              ))}
            </Flex>
          </Flex>
        </details>
        <Flex align="center" gap="2" wrap="wrap">
          <Badge size="1" color={presentation.color} variant="soft">
            {presentation.label}
          </Badge>
          {snapshot.nextAction && definition.actions?.[snapshot.nextAction] ? (
            <Button
              size="1"
              variant={snapshot.attention === "blocking" ? "solid" : "soft"}
              color={snapshot.attention === "blocking" ? "red" : undefined}
              disabled={pending !== null}
              onClick={() => onAction(definition, snapshot.nextAction!)}
            >
              {pending === `${definition.id}:${snapshot.nextAction}`
                ? "Sending…"
                : actionLabels[snapshot.nextAction]}
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}

export default function SetupHub({ props, chat }: SetupHubProps) {
  const snapshots = props.snapshot ?? [];
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const definitions = onboardingCatalog.filter((entry) => byId.has(entry.id));
  const ready = onboardingCatalog.filter((entry) => entry.role === "ready-capability");
  const blocker = snapshots.find((snapshot) => snapshot.attention === "blocking");

  async function sendInteraction(definition: OnboardingCapabilityDefinition, action: SetupAction) {
    const key = `${definition.id}:${action}`;
    setPending(key);
    setError(null);
    try {
      await chat.send(readableAction(definition, action), {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-capability",
            action,
            targetId: definition.id,
          },
        },
      });
    } catch {
      setError(`Couldn't send “${readableAction(definition, action)}”. Try again.`);
    } finally {
      setPending(null);
    }
  }

  async function refresh() {
    setPending("setup-overview:refresh");
    setError(null);
    try {
      await chat.send("Refresh the setup overview", {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-overview",
            action: "refresh",
            targetId: "setup-overview",
          },
        },
      });
    } catch {
      setError("Couldn't request a fresh overview. Try again.");
    } finally {
      setPending(null);
    }
  }

  if (snapshots.length === 0) {
    return (
      <Callout.Root color="orange" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>The setup snapshot was empty. Ask the agent to refresh it.</Callout.Text>
      </Callout.Root>
    );
  }

  const summary = snapshots
    .filter((snapshot) =>
      ["connected", "connected-unverified", "configured"].includes(snapshot.state)
    )
    .slice(0, 3)
    .map((snapshot) => {
      const definition = onboardingCatalog.find((entry) => entry.id === snapshot.id);
      return definition
        ? `${definition.title} ${snapshot.state === "configured" ? "ready" : "connected"}`
        : "";
    })
    .filter(Boolean)
    .join(" · ");

  const sections = [
    ["connections", "Connections"],
    ["environment", "Environment"],
    ["access", "Devices & access"],
    ["personalization", "Personalization"],
  ] as const;

  return (
    <Flex direction="column" gap="3" style={{ width: "100%", minWidth: 0 }}>
      <Flex align="start" justify="between" gap="2">
        <Box>
          <Text as="div" size="4" weight="bold">
            Your Vibestudio
          </Text>
          <Text as="div" size="1" color="gray">
            {summary || "Setup state observed from capability owners."}
          </Text>
        </Box>
        <Button
          size="1"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => void refresh()}
          aria-label="Refresh setup overview"
        >
          <ReloadIcon /> Refresh
        </Button>
      </Flex>

      {blocker ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="1" align="start">
              <Text size="1" weight="bold">
                Recommended
              </Text>
              <Text size="1">{blocker.summary}</Text>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Callout.Root color="green" size="1">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>No blocking setup issue was found. Optional setup can wait.</Callout.Text>
        </Callout.Root>
      )}

      {error ? (
        <Text size="1" color="red" role="alert">
          {error}
        </Text>
      ) : null}

      {sections.map(([category, title]) => {
        const entries = definitions.filter((entry) => entry.category === category);
        if (entries.length === 0) return null;
        const advancedOnly = entries.every((entry) => entry.visibility === "advanced");
        const content = (
          <Flex direction="column" gap="1">
            {entries.map((definition) => (
              <SetupRow
                key={definition.id}
                definition={definition}
                snapshot={byId.get(definition.id)!}
                pending={pending}
                onAction={(entry, action) => void sendInteraction(entry, action)}
              />
            ))}
          </Flex>
        );
        return advancedOnly ? (
          <details key={category}>
            <summary style={{ cursor: "pointer" }}>
              <Text size="2" weight="bold">
                {title} · optional
              </Text>
            </summary>
            <Box pt="2">{content}</Box>
          </details>
        ) : (
          <Flex key={category} direction="column" gap="1">
            <Text size="2" weight="bold">
              {title}
            </Text>
            {content}
          </Flex>
        );
      })}

      <Separator size="4" />
      <Box>
        <Text as="div" size="2" weight="bold" mb="1">
          Ready now
        </Text>
        <Flex gap="1" wrap="wrap">
          {ready.map((definition) => (
            <Button
              key={definition.id}
              size="1"
              variant="soft"
              disabled={pending !== null}
              onClick={() => void sendInteraction(definition, "explore")}
            >
              {definition.title}
            </Button>
          ))}
        </Flex>
        <Text as="div" size="1" color="gray" mt="1">
          These capabilities work on demand and are not unfinished setup.
        </Text>
      </Box>
    </Flex>
  );
}
