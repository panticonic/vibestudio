import { Badge, Box, Button, Callout, Card, Flex, Separator, Text } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { type OnboardingCapabilityDefinition, type SetupAction } from "./catalog";
import { composeOnboardingCapabilities, type SetupCapabilitySnapshot } from "./snapshot";
import { loadOptionalTemplateSnapshot, type OptionalTemplateSnapshot } from "./templates";

interface SetupHubProps {
  props: {
    /** Legacy seeds remain accepted for transcript compatibility. */
    snapshot?: SetupCapabilitySnapshot[];
    templates?: OptionalTemplateSnapshot[];
    catalog?: readonly OnboardingCapabilityDefinition[];
  };
  chat: {
    send: (content: string, options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
  };
  scope?: Record<string, unknown>;
  scopes?: { save?: () => Promise<unknown> };
  inlineUi?: { id: string; renderedAt?: string };
}

interface SetupHubCache {
  catalog: readonly OnboardingCapabilityDefinition[];
  snapshot: SetupCapabilitySnapshot[];
  templates?: OptionalTemplateSnapshot[];
  templatesLoaded?: boolean;
}

const CACHE_KEY = "onboardingSetupOverview";

function readCache(scope: Record<string, unknown> | undefined): SetupHubCache | undefined {
  const value = scope?.[CACHE_KEY];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SetupHubCache>;
  if (!Array.isArray(candidate.catalog) || !Array.isArray(candidate.snapshot)) return undefined;
  if (candidate.templates !== undefined && !Array.isArray(candidate.templates)) return undefined;
  return candidate as SetupHubCache;
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

function BusyReloadIcon({ busy }: { busy: boolean }) {
  return (
    <ReloadIcon
      aria-hidden
      style={
        busy
          ? {
              animation: "spin 0.8s linear infinite",
              transformOrigin: "center",
            }
          : undefined
      }
    />
  );
}

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
                  {pending === `${definition.id}:${action}` ? (
                    <>
                      <BusyReloadIcon busy /> Sending…
                    </>
                  ) : (
                    actionLabels[action]
                  )}
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
              {pending === `${definition.id}:${snapshot.nextAction}` ? (
                <>
                  <BusyReloadIcon busy />
                  {snapshot.nextAction === "check" ? "Checking…" : "Sending…"}
                </>
              ) : (
                actionLabels[snapshot.nextAction]
              )}
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}

export default function SetupHub({ props = {}, chat, scope, scopes, inlineUi }: SetupHubProps) {
  const cached = readCache(scope);
  const [snapshots, setSnapshots] = useState<SetupCapabilitySnapshot[]>(
    props.snapshot ?? cached?.snapshot ?? []
  );
  const [templateSnapshots, setTemplateSnapshots] = useState<OptionalTemplateSnapshot[]>(
    props.templates ?? cached?.templates ?? []
  );
  const [catalog, setCatalog] = useState<readonly OnboardingCapabilityDefinition[]>(
    props.catalog ?? cached?.catalog ?? []
  );
  const [templatesLoaded, setTemplatesLoaded] = useState(
    props.templates !== undefined || cached?.templatesLoaded === true
  );
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capabilityRequest = useRef(0);
  const templateRequest = useRef(0);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const definitions = catalog.filter((entry) => byId.has(entry.id));
  const ready = catalog.filter((entry) => entry.role === "ready-capability");
  const blocker = snapshots.find((snapshot) => snapshot.attention === "blocking");

  const saveCache = useCallback(
    async (update: Partial<SetupHubCache>) => {
      if (!scope) return;
      try {
        const current = readCache(scope) ?? { catalog: [], snapshot: [] };
        scope[CACHE_KEY] = { ...current, ...update } satisfies SetupHubCache;
        await scopes?.save?.();
      } catch {
        // Live owner data remains useful when browser-local cache persistence
        // is temporarily unavailable.
      }
    },
    [scope, scopes]
  );

  const refreshCapabilities = useCallback(
    async (verifyCapabilityId?: string) => {
      const request = ++capabilityRequest.current;
      setLoadingCapabilities(true);
      setError(null);
      try {
        const overview = await composeOnboardingCapabilities(
          verifyCapabilityId ? { verifyCapabilityId } : {}
        );
        if (request !== capabilityRequest.current) return;
        setCatalog(overview.catalog);
        setSnapshots(overview.snapshot);
        await saveCache({ catalog: overview.catalog, snapshot: overview.snapshot });
      } catch {
        if (request === capabilityRequest.current) {
          setError("Couldn't refresh setup status. Try again.");
        }
      } finally {
        if (request === capabilityRequest.current) setLoadingCapabilities(false);
      }
    },
    [saveCache]
  );

  const loadTemplates = useCallback(async () => {
    const request = ++templateRequest.current;
    setLoadingTemplates(true);
    setError(null);
    try {
      const templates = await loadOptionalTemplateSnapshot();
      if (request !== templateRequest.current) return;
      setTemplateSnapshots(templates);
      setTemplatesLoaded(true);
      await saveCache({ templates, templatesLoaded: true });
    } catch {
      if (request === templateRequest.current) {
        setError("Couldn't load optional templates. Try again.");
      }
    } finally {
      if (request === templateRequest.current) setLoadingTemplates(false);
    }
  }, [saveCache]);

  // Mounting always refreshes owner state. Re-rendering the stable inline UI
  // changes renderedAt, which is the agent's explicit external refresh signal.
  useEffect(() => {
    void refreshCapabilities();
  }, [inlineUi?.renderedAt, refreshCapabilities]);

  async function sendInteraction(definition: OnboardingCapabilityDefinition, action: SetupAction) {
    if (action === "check") {
      setPending(`${definition.id}:${action}`);
      try {
        await refreshCapabilities(definition.id);
      } finally {
        setPending(null);
      }
      return;
    }
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

  async function sendTemplateInteraction(definition: OptionalTemplateSnapshot) {
    const key = `${definition.id}:add`;
    setPending(key);
    setError(null);
    try {
      await chat.send(`Review and add ${definition.title}`, {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-template",
            action: "add",
            targetId: definition.id,
            ...definition.selection,
          },
        },
      });
    } catch {
      setError(`Couldn't request ${definition.title}. Try again.`);
    } finally {
      setPending(null);
    }
  }

  if (snapshots.length === 0) {
    return (
      <Flex direction="column" gap="2" style={{ width: "100%", minWidth: 0 }}>
        <Flex align="center" gap="2">
          {loadingCapabilities ? <BusyReloadIcon busy /> : null}
          <Text size="2" weight="medium">
            {loadingCapabilities ? "Loading your setup…" : "Setup status is unavailable."}
          </Text>
        </Flex>
        {!loadingCapabilities ? (
          <Button size="1" variant="soft" onClick={() => void refreshCapabilities()}>
            <ReloadIcon /> Try again
          </Button>
        ) : null}
        {error ? (
          <Text size="1" color="red">
            {error}
          </Text>
        ) : null}
      </Flex>
    );
  }

  const summary = snapshots
    .filter((snapshot) =>
      ["connected", "connected-unverified", "configured"].includes(snapshot.state)
    )
    .slice(0, 3)
    .map((snapshot) => {
      const definition = catalog.find((entry) => entry.id === snapshot.id);
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
      <Flex align="start" justify="between" gap="2" wrap="wrap">
        <Box style={{ flex: "1 1 14rem", minWidth: 0 }}>
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
          disabled={pending !== null || loadingCapabilities}
          onClick={() => void refreshCapabilities()}
          aria-label="Refresh setup overview"
        >
          <BusyReloadIcon busy={loadingCapabilities} />
          {loadingCapabilities ? "Refreshing…" : "Refresh"}
        </Button>
      </Flex>

      {blocker ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            <Text as="span" size="1" weight="bold">
              Recommended
            </Text>
            <br />
            <Text as="span" size="1">
              {blocker.summary}
            </Text>
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

      <Flex direction="column" gap="1">
        <Text size="2" weight="bold">
          Optional templates
        </Text>
        <Text size="1" color="gray">
          Templates are reviewed bundles of panels, skills, and other workspace additions for a
          particular outcome. Loading them contacts Vibestudio's verified template registry; nothing
          is installed until you review and approve a selection.
        </Text>
        <Box>
          <Button
            size="1"
            variant="soft"
            disabled={loadingTemplates || pending !== null}
            onClick={() => void loadTemplates()}
          >
            <BusyReloadIcon busy={loadingTemplates} />
            {loadingTemplates
              ? "Loading templates…"
              : templatesLoaded
                ? "Refresh optional templates"
                : "Load optional templates"}
          </Button>
        </Box>
        {templatesLoaded && templateSnapshots.length === 0 ? (
          <Text size="1" color="gray">
            No optional templates are available right now.
          </Text>
        ) : null}
        {templateSnapshots.map((definition) => {
          return (
            <Card key={definition.id} size="1">
              <Flex align="center" justify="between" gap="2" wrap="wrap">
                <Box style={{ minWidth: 0, flex: "1 1 220px" }}>
                  <Text as="div" size="2" weight="medium">
                    {definition.title}
                  </Text>
                  <Text as="div" size="1" color="gray">
                    {definition.description}
                  </Text>
                </Box>
                <Flex align="center" gap="2">
                  <Badge
                    size="1"
                    color={
                      definition.state === "installed"
                        ? "green"
                        : definition.state === "unknown"
                          ? "orange"
                          : "gray"
                    }
                    variant="soft"
                  >
                    {definition.state === "installed"
                      ? "Installed"
                      : definition.state === "unknown"
                        ? "Unknown"
                        : "Available"}
                  </Badge>
                  {definition.state === "available" ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={pending !== null}
                      onClick={() => void sendTemplateInteraction(definition)}
                    >
                      {pending === `${definition.id}:add` ? (
                        <>
                          <BusyReloadIcon busy /> Sending…
                        </>
                      ) : (
                        "Review & add"
                      )}
                    </Button>
                  ) : null}
                </Flex>
              </Flex>
            </Card>
          );
        })}
      </Flex>

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
