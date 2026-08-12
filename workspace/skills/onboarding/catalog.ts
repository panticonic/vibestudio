export type OnboardingRole =
  | "connection"
  | "optional-configuration"
  | "migration"
  | "contextual-setup"
  | "ready-capability"
  | "ordinary-task";

export type SetupPresentationState =
  | "connected"
  | "connected-unverified"
  | "configured"
  | "using-defaults"
  | "not-configured"
  | "in-progress"
  | "needs-attention"
  | "unavailable"
  | "unknown";

export type OnboardingScope =
  | "user-workspace"
  | "workspace"
  | "server"
  | "device"
  | "channel"
  | "project";

export type OnboardingTier = "direct" | "host-topology";

export const setupActions = [
  "setup",
  "repair",
  "reconnect",
  "check",
  "inspect",
  "revoke",
  "change",
  "grants",
  "resume",
  "refresh",
  "explore",
] as const;

export type SetupAction = (typeof setupActions)[number];

export type ShellNavigationTarget = "connection-settings" | "workspace-chooser";

export type SetupActionTarget =
  | { via: "owner-skill" }
  | { via: "about-page"; page: "credentials" | "permissions" }
  | { via: "model-settings" }
  | { via: "panel"; path: "about/local-models" | "about/browser-import-inspector" }
  | { via: "shell-navigation"; target: ShellNavigationTarget }
  | { via: "conversation" };

export interface OnboardingCapabilityDefinition {
  id: string;
  title: string;
  summary: string;
  category: "connections" | "environment" | "access" | "personalization" | "ready-now";
  role: OnboardingRole;
  scope: OnboardingScope;
  tier: OnboardingTier;
  ownerSkillPath?: string;
  actions?: Partial<Record<SetupAction, SetupActionTarget>>;
  visibility: "primary" | "secondary" | "advanced" | "contextual";
  setup?: {
    statusAdapter?: string;
    observer?: CredentialConnectionObserver;
    successDescription: string;
  };
  examples?: readonly string[];
}

export interface CredentialConnectionObserver {
  kind: "credential-connection";
  providerId: string;
  clientConfigId?: string;
  verifyUrl?: string;
  identityField?: string;
}

export interface OnboardingSkillEntry {
  skillPath: string;
  onboarding?: unknown;
}

const connectionManagement = {
  inspect: { via: "about-page", page: "credentials" },
  revoke: { via: "about-page", page: "credentials" },
  grants: { via: "about-page", page: "permissions" },
} as const satisfies Partial<Record<SetupAction, SetupActionTarget>>;

export const onboardingCatalog: readonly OnboardingCapabilityDefinition[] = [
  {
    id: "connection.ai-provider",
    title: "AI model",
    summary: "The model and provider used by new agent turns.",
    category: "connections",
    role: "connection",
    scope: "workspace",
    tier: "direct",
    ownerSkillPath: "skills/api-integrations/SKILL.md",
    actions: {
      setup: { via: "model-settings" },
      repair: { via: "model-settings" },
      change: { via: "model-settings" },
      ...connectionManagement,
    },
    visibility: "primary",
    setup: {
      statusAdapter: "ai-provider",
      successDescription:
        "The selected model has a usable, audience-matched credential or is startable locally.",
    },
  },
  {
    id: "connection.github",
    title: "GitHub",
    summary: "Connect repository and GitHub API access for this user in the workspace.",
    category: "connections",
    role: "connection",
    scope: "user-workspace",
    tier: "direct",
    ownerSkillPath: "skills/github/SKILL.md",
    actions: {
      setup: { via: "owner-skill" },
      repair: { via: "owner-skill" },
      reconnect: { via: "owner-skill" },
      check: { via: "owner-skill" },
      ...connectionManagement,
    },
    visibility: "primary",
    setup: {
      statusAdapter: "github",
      successDescription: "A live GitHub /user check succeeds for the stored connection.",
    },
  },
  {
    id: "migration.browser-environment",
    title: "Browser import",
    summary: "Bring in selected bookmarks, history, cookies, passwords, or open tabs.",
    category: "environment",
    role: "migration",
    scope: "user-workspace",
    tier: "direct",
    ownerSkillPath: "extensions/browser-data/SKILL.md",
    actions: {
      setup: { via: "panel", path: "about/browser-import-inspector" },
      resume: { via: "panel", path: "about/browser-import-inspector" },
    },
    visibility: "primary",
    setup: {
      statusAdapter: "browser-environment",
      successDescription: "The selected import job reaches a successful terminal phase.",
    },
  },
  {
    id: "configuration.local-models",
    title: "Experimental local inference",
    summary: "Try private on-device models with limited reliability and hardware-dependent speed.",
    category: "environment",
    role: "optional-configuration",
    scope: "server",
    tier: "direct",
    actions: {
      setup: { via: "panel", path: "about/local-models" },
      change: { via: "panel", path: "about/local-models" },
    },
    visibility: "secondary",
    setup: {
      statusAdapter: "local-models",
      successDescription: "At least one local model is ready or can be loaded on demand.",
    },
  },
  {
    id: "configuration.agent-defaults",
    title: "Agent defaults",
    summary: "Choose durable model and behavior defaults for new agents.",
    category: "personalization",
    role: "optional-configuration",
    scope: "workspace",
    tier: "direct",
    actions: {
      change: { via: "model-settings" },
    },
    visibility: "secondary",
    setup: {
      statusAdapter: "agent-defaults",
      successDescription: "The chosen default agent configuration persists and reads back.",
    },
  },
  {
    id: "connection.device",
    title: "Devices",
    summary: "Install Vibestudio on a phone and pair it to this workspace.",
    category: "access",
    role: "connection",
    scope: "device",
    tier: "host-topology",
    ownerSkillPath: "skills/phone-setup/SKILL.md",
    actions: {
      setup: { via: "shell-navigation", target: "connection-settings" },
      change: { via: "shell-navigation", target: "connection-settings" },
    },
    visibility: "secondary",
    setup: {
      statusAdapter: "host-devices",
      successDescription:
        "The mobile app is installed and the hub reports its durable device identity.",
    },
  },
  {
    id: "connection.remote-server",
    title: "Remote server",
    summary: "Connect this client to a self-hosted or remote Vibestudio server.",
    category: "access",
    role: "connection",
    scope: "server",
    tier: "host-topology",
    actions: {
      setup: { via: "shell-navigation", target: "connection-settings" },
      change: { via: "shell-navigation", target: "connection-settings" },
    },
    visibility: "secondary",
    setup: {
      statusAdapter: "host-remote",
      successDescription: "This client is paired with and routable to the selected server.",
    },
  },
  {
    id: "configuration.web-search",
    title: "Enhanced web search",
    summary: "Optionally use Tavily, Brave, or Exa instead of the built-in search provider.",
    category: "personalization",
    role: "optional-configuration",
    scope: "user-workspace",
    tier: "direct",
    ownerSkillPath: "skills/web-research/SKILL.md",
    actions: {
      setup: { via: "owner-skill" },
      change: { via: "owner-skill" },
    },
    visibility: "advanced",
    setup: {
      statusAdapter: "web-search",
      successDescription:
        "An enhanced provider credential is active; DuckDuckGo remains usable without it.",
    },
  },
  {
    id: "contextual.slack",
    title: "Slack",
    summary: "Available when a dependable Slack owner workflow and status read are installed.",
    category: "connections",
    role: "contextual-setup",
    scope: "channel",
    tier: "direct",
    visibility: "contextual",
  },
  {
    id: "capability.pdf-ingestion",
    title: "Ingest PDFs",
    summary: "Read and work with PDF documents immediately.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
    examples: ["Summarize a PDF", "Extract tables"],
  },
  {
    id: "capability.browser-automation",
    title: "Automate browsers",
    summary: "Run browser workflows without general setup.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
  {
    id: "capability.automations",
    title: "Schedule recurring work",
    summary: "Run reviewed scripts or agent prompts on a schedule and supervise every run.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    ownerSkillPath: "skills/automations/SKILL.md",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
    examples: [
      "Run a reporting script every morning",
      "Ask a fresh agent to review project changes each week",
      "Revisit one ongoing agent conversation on a schedule",
    ],
  },
  {
    id: "capability.build",
    title: "Build apps",
    summary: "Create panels, workers, apps, extensions, and agents.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
  {
    id: "capability.files-terminal",
    title: "Use files and terminal",
    summary: "Work with workspace files and command-line tools now.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
  {
    id: "capability.runtime",
    title: "Use workers and databases",
    summary: "Build durable services and data-backed tools.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
  {
    id: "capability.web-search",
    title: "Search the web",
    summary: "Use the built-in provider immediately.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
  {
    id: "capability.testing",
    title: "Run tests",
    summary: "Test and diagnose workspace software.",
    category: "ready-now",
    role: "ready-capability",
    scope: "workspace",
    tier: "direct",
    actions: { explore: { via: "conversation" } },
    visibility: "primary",
  },
] as const;

const setupRoles = new Set<OnboardingRole>(["connection", "optional-configuration", "migration"]);

export function validateOnboardingCatalog(
  catalog: readonly OnboardingCapabilityDefinition[] = onboardingCatalog
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of catalog) {
    if (ids.has(entry.id)) errors.push(`Duplicate onboarding capability id: ${entry.id}`);
    ids.add(entry.id);

    if (setupRoles.has(entry.role)) {
      if (!entry.setup?.statusAdapter && !entry.setup?.observer) {
        errors.push(`${entry.id} requires a status observer`);
      }
      if (!entry.setup?.successDescription) errors.push(`${entry.id} requires a success condition`);
      if (!entry.actions || Object.keys(entry.actions).length === 0) {
        errors.push(`${entry.id} requires at least one dependable action`);
      }
    }
    if (
      (entry.role === "ready-capability" || entry.role === "ordinary-task") &&
      entry.setup !== undefined
    ) {
      errors.push(`${entry.id} cannot declare setup status`);
    }
    if (entry.role === "contextual-setup" && entry.actions && !entry.ownerSkillPath) {
      errors.push(`${entry.id} cannot offer contextual setup without an owner skill`);
    }
    for (const [action, target] of Object.entries(entry.actions ?? {}) as Array<
      [SetupAction, SetupActionTarget]
    >) {
      if (
        (action === "setup" ||
          action === "repair" ||
          action === "reconnect" ||
          action === "check") &&
        target.via === "owner-skill" &&
        !entry.ownerSkillPath
      ) {
        errors.push(`${entry.id}.${action} routes to an owner skill but has no ownerSkillPath`);
      }
      if (
        (action === "inspect" || action === "revoke") &&
        (target.via !== "about-page" || target.page !== "credentials")
      ) {
        errors.push(`${entry.id}.${action} must route to the credentials page`);
      }
      if (action === "grants" && (target.via !== "about-page" || target.page !== "permissions")) {
        errors.push(`${entry.id}.grants must route to the permissions page`);
      }
    }
  }
  return errors;
}

export function capabilityById(id: string): OnboardingCapabilityDefinition | undefined {
  return onboardingCatalog.find((entry) => entry.id === id);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${label} must be one of ${values.join(", ")}.`);
  }
  return value as T;
}

function parseActionTarget(value: unknown, label: string): SetupActionTarget {
  const source = object(value, label);
  const via = oneOf(
    source["via"],
    [
      "owner-skill",
      "about-page",
      "model-settings",
      "panel",
      "shell-navigation",
      "conversation",
    ] as const,
    `${label}.via`
  );
  if (via === "about-page") {
    return {
      via,
      page: oneOf(source["page"], ["credentials", "permissions"] as const, `${label}.page`),
    };
  }
  if (via === "panel") {
    return {
      via,
      path: oneOf(
        source["path"],
        ["about/local-models", "about/browser-import-inspector"] as const,
        `${label}.path`
      ),
    };
  }
  if (via === "shell-navigation") {
    return {
      via,
      target: oneOf(
        source["target"],
        ["connection-settings", "workspace-chooser"] as const,
        `${label}.target`
      ),
    };
  }
  return { via };
}

function parseDeclaredCapability(
  value: unknown,
  skillPath: string,
  index: number
): OnboardingCapabilityDefinition {
  const label = `${skillPath} onboarding.capabilities[${index}]`;
  const source = object(value, label);
  const actionsSource =
    source["actions"] === undefined ? undefined : object(source["actions"], `${label}.actions`);
  const actions: Partial<Record<SetupAction, SetupActionTarget>> = {};
  for (const [action, target] of Object.entries(actionsSource ?? {})) {
    const parsedAction = oneOf(action, setupActions, `${label}.actions key`);
    actions[parsedAction] = parseActionTarget(target, `${label}.actions.${action}`);
  }
  let setup: OnboardingCapabilityDefinition["setup"];
  if (source["setup"] !== undefined) {
    const setupSource = object(source["setup"], `${label}.setup`);
    const status = object(setupSource["status"], `${label}.setup.status`);
    const kind = oneOf(
      status["kind"],
      ["credential-connection"] as const,
      `${label}.setup.status.kind`
    );
    setup = {
      successDescription: string(
        setupSource["successDescription"],
        `${label}.setup.successDescription`
      ),
      observer: {
        kind,
        providerId: string(status["providerId"], `${label}.setup.status.providerId`),
        ...(status["clientConfigId"] !== undefined
          ? {
              clientConfigId: string(
                status["clientConfigId"],
                `${label}.setup.status.clientConfigId`
              ),
            }
          : {}),
        ...(status["verifyUrl"] !== undefined
          ? { verifyUrl: string(status["verifyUrl"], `${label}.setup.status.verifyUrl`) }
          : {}),
        ...(status["identityField"] !== undefined
          ? {
              identityField: string(status["identityField"], `${label}.setup.status.identityField`),
            }
          : {}),
      },
    };
  }
  return {
    id: string(source["id"], `${label}.id`),
    title: string(source["title"], `${label}.title`),
    summary: string(source["summary"], `${label}.summary`),
    category: oneOf(
      source["category"],
      ["connections", "environment", "access", "personalization", "ready-now"] as const,
      `${label}.category`
    ),
    role: oneOf(
      source["role"],
      [
        "connection",
        "optional-configuration",
        "migration",
        "contextual-setup",
        "ready-capability",
        "ordinary-task",
      ] as const,
      `${label}.role`
    ),
    scope: oneOf(
      source["scope"],
      ["user-workspace", "workspace", "server", "device", "channel", "project"] as const,
      `${label}.scope`
    ),
    tier: oneOf(source["tier"], ["direct", "host-topology"] as const, `${label}.tier`),
    ownerSkillPath: skillPath,
    ...(Object.keys(actions).length ? { actions } : {}),
    visibility: oneOf(
      source["visibility"],
      ["primary", "secondary", "advanced", "contextual"] as const,
      `${label}.visibility`
    ),
    ...(setup ? { setup } : {}),
  };
}

export function composeOnboardingCatalog(
  skills: readonly OnboardingSkillEntry[]
): readonly OnboardingCapabilityDefinition[] {
  const contributed = skills.flatMap((skill) => {
    if (skill.onboarding === undefined) return [];
    const declaration = object(skill.onboarding, `${skill.skillPath} onboarding`);
    const capabilities = declaration["capabilities"];
    if (!Array.isArray(capabilities)) {
      throw new Error(`${skill.skillPath} onboarding.capabilities must be an array.`);
    }
    return capabilities.map((entry, index) =>
      parseDeclaredCapability(entry, skill.skillPath, index)
    );
  });
  const catalog = [...onboardingCatalog, ...contributed];
  const errors = validateOnboardingCatalog(catalog);
  if (errors.length) throw new Error(`Invalid installed onboarding catalog: ${errors.join(" ")}`);
  return catalog;
}
