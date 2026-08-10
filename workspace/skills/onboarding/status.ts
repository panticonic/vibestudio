import {
  browserData,
  callMain,
  createDurableObjectServiceClient,
  credentials,
  extensions,
  type StoredCredentialSummary,
} from "@workspace/runtime";
import {
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import type { LocalModelEntry, LocalModelsStatus } from "@workspace/model-catalog/localModels";
import type { ImportJobSnapshot } from "@vibestudio/browser-data";
import type { CredentialConnectionObserver, SetupPresentationState } from "./catalog";

export interface CapabilityOnboardingStatusResult {
  state: SetupPresentationState;
  verification?: "unverified" | "checking" | "verified" | "failed";
  summary: string;
  attention: "none" | "optional" | "blocking";
  rawStage?: string;
}

export type CapabilityOnboardingStatusAdapter = (opts?: {
  verify?: boolean;
}) => Promise<CapabilityOnboardingStatusResult>;

export interface GitHubOnboardingStatus {
  stage: "needs-token" | "connected" | "verified" | "error";
  connected: boolean;
  verified: boolean;
  login?: string;
  verification?: { valid: boolean };
}

export interface OnboardingStatusDependencies {
  github(opts?: { verify?: boolean }): Promise<GitHubOnboardingStatus>;
  modelSettings(): Promise<ModelSettingsSnapshot>;
  localModelsStatus(): Promise<LocalModelsStatus>;
  localModelsList(): Promise<LocalModelEntry[]>;
  browserImportJobs(): Promise<ImportJobSnapshot[]>;
  activeSearchProvider(): Promise<"duckduckgo" | "tavily" | "brave" | "exa">;
  hasSkill(skillPath: string): Promise<boolean>;
}

interface SkillCatalogEntry {
  skillPath: string;
}

function activeCredentials(
  all: readonly StoredCredentialSummary[],
  providerIds: readonly string[]
): StoredCredentialSummary[] {
  return all.filter(
    (credential) =>
      !credential.revokedAt &&
      typeof credential.metadata?.["providerId"] === "string" &&
      providerIds.includes(credential.metadata["providerId"])
  );
}

async function githubStatus(opts: { verify?: boolean } = {}): Promise<GitHubOnboardingStatus> {
  const primary = activeCredentials(await credentials.listStoredCredentials(), ["github"])[0];
  if (!primary) {
    return { stage: "needs-token", connected: false, verified: false };
  }
  if (!opts.verify) {
    return {
      stage: "connected",
      connected: true,
      verified: false,
      ...(primary.accountIdentity?.username ? { login: primary.accountIdentity.username } : {}),
    };
  }
  const response = await credentials.fetch(
    "https://api.github.com/user",
    { method: "GET", headers: { accept: "application/vnd.github+json" } },
    { credentialId: primary.id }
  );
  if (!response.ok) {
    return {
      stage: "connected",
      connected: true,
      verified: false,
      verification: { valid: false },
    };
  }
  const profile = (await response.json()) as { login?: unknown };
  return {
    stage: "verified",
    connected: true,
    verified: true,
    verification: { valid: true },
    ...(typeof profile.login === "string" ? { login: profile.login } : {}),
  };
}

async function activeSearchProvider(): Promise<"duckduckgo" | "tavily" | "brave" | "exa"> {
  const providers = new Set(
    activeCredentials(await credentials.listStoredCredentials(), ["tavily", "brave", "exa"]).map(
      (credential) => credential.metadata?.["providerId"]
    )
  );
  if (providers.has("tavily")) return "tavily";
  if (providers.has("brave")) return "brave";
  if (providers.has("exa")) return "exa";
  return "duckduckgo";
}

export function createDefaultStatusDependencies(): OnboardingStatusDependencies {
  const modelSettings = createDurableObjectServiceClient(MODEL_SETTINGS_SERVICE_PROTOCOL);
  let installedSkills: Promise<ReadonlySet<string>> | undefined;
  const skills = () =>
    (installedSkills ??= callMain<SkillCatalogEntry[]>("workspace.listSkills").then(
      (entries) => new Set(entries.map((entry) => entry.skillPath))
    ));
  return {
    github: githubStatus,
    modelSettings: () => modelSettings.call<ModelSettingsSnapshot>("getSettings"),
    localModelsStatus: () =>
      extensions.invoke(
        "@workspace-extensions/local-models",
        "status",
        []
      ) as Promise<LocalModelsStatus>,
    localModelsList: () =>
      extensions.invoke("@workspace-extensions/local-models", "listModels", []) as Promise<
        LocalModelEntry[]
      >,
    browserImportJobs: () => browserData.listImportJobs(),
    activeSearchProvider,
    hasSkill: async (skillPath) => (await skills()).has(skillPath),
  };
}

function unavailable(summary: string, rawStage: string): CapabilityOnboardingStatusResult {
  return {
    state: "unavailable",
    summary,
    attention: "blocking",
    rawStage,
  };
}

export function createCredentialConnectionStatusAdapter(
  observer: CredentialConnectionObserver,
  title: string
): CapabilityOnboardingStatusAdapter {
  return async (opts = {}) => {
    const [config, all] = await Promise.all([
      observer.clientConfigId
        ? credentials.getClientConfigStatus({ configId: observer.clientConfigId })
        : Promise.resolve({ configured: true }),
      credentials.listStoredCredentials(),
    ]);
    const primary = activeCredentials(all, [observer.providerId])[0];
    if (!primary) {
      return {
        state: "not-configured",
        summary: config.configured
          ? `No ${title} account is connected.`
          : `${title} needs provider setup before an account can connect.`,
        attention: "optional",
        rawStage: config.configured ? "ready-to-connect" : "needs-setup",
      };
    }
    const identity =
      primary.accountIdentity?.email ?? primary.accountIdentity?.username ?? undefined;
    if (!opts.verify || !observer.verifyUrl) {
      return {
        state: "connected-unverified",
        verification: "unverified",
        summary: identity
          ? `Connected as ${identity}; not checked live.`
          : "Connected; not checked live.",
        attention: "none",
        rawStage: "connected",
      };
    }
    const response = await credentials.fetch(
      observer.verifyUrl,
      { method: "GET" },
      { credentialId: primary.id }
    );
    if (!response.ok) {
      return {
        state: "needs-attention",
        verification: "failed",
        summary: `The current ${title} connection check failed.`,
        attention: "blocking",
        rawStage: "verification-failed",
      };
    }
    let verifiedIdentity = identity;
    if (observer.identityField) {
      const profile = (await response.json()) as Record<string, unknown>;
      const candidate = profile[observer.identityField];
      if (typeof candidate === "string") verifiedIdentity = candidate;
    }
    return {
      state: "connected",
      verification: "verified",
      summary: verifiedIdentity ? `Verified as ${verifiedIdentity}.` : `${title} verified.`,
      attention: "none",
      rawStage: "verified",
    };
  };
}

function githubResult(
  status: GitHubOnboardingStatus,
  verify: boolean
): CapabilityOnboardingStatusResult {
  if (status.stage === "error") {
    return unavailable("GitHub status is unavailable right now.", status.stage);
  }
  if (verify && status.verification && !status.verification.valid) {
    return {
      state: "needs-attention",
      verification: "failed",
      summary: "The current GitHub connection check failed.",
      attention: "blocking",
      rawStage: status.stage,
    };
  }
  if (status.verified) {
    return {
      state: "connected",
      verification: "verified",
      summary: status.login ? `Verified as ${status.login}.` : "GitHub verified.",
      attention: "none",
      rawStage: status.stage,
    };
  }
  if (status.connected) {
    return {
      state: "connected-unverified",
      verification: "unverified",
      summary: status.login
        ? `Connected as ${status.login}; not checked live.`
        : "Connected; not checked live.",
      attention: "none",
      rawStage: status.stage,
    };
  }
  return {
    state: "not-configured",
    summary: "No GitHub account is connected.",
    attention: "optional",
    rawStage: status.stage,
  };
}

function aiProviderResult(settings: ModelSettingsSnapshot): CapabilityOnboardingStatusResult {
  const selected = settings.catalog.models.find((model) => model.ref === settings.defaultModel);
  if (!selected) {
    return {
      state: "unknown",
      summary: "The selected model is missing from the current catalog.",
      attention: "blocking",
      rawStage: "missing-model",
    };
  }
  const availability = selected.availability.state;
  if (availability === "ready" || availability === "startable") {
    return {
      state: "configured",
      summary: `${selected.name} is ${availability === "ready" ? "ready" : "ready on first use"}.`,
      attention: "none",
      rawStage: availability,
    };
  }
  if (availability === "starting" || availability === "downloading") {
    return {
      state: "in-progress",
      summary: `${selected.name} is ${availability}.`,
      attention: "none",
      rawStage: availability,
    };
  }
  if (availability === "needs-setup") {
    return {
      state: "needs-attention",
      summary: `${selected.name} needs a usable provider connection.`,
      attention: "blocking",
      rawStage: selected.availability.detail,
    };
  }
  return {
    state: "unknown",
    summary: `${selected.name} is not currently available.`,
    attention: "blocking",
    rawStage: availability,
  };
}

function agentDefaultsResult(settings: ModelSettingsSnapshot): CapabilityOnboardingStatusResult {
  if (settings.defaultModelSource === "workspace") {
    return {
      state: "configured",
      summary: `Workspace defaults use ${settings.defaultModel}.`,
      attention: "none",
      rawStage: "workspace",
    };
  }
  return {
    state: "using-defaults",
    summary: `Using the available default, ${settings.defaultModel}.`,
    attention: "none",
    rawStage: "fallback",
  };
}

function localModelsResult(
  status: LocalModelsStatus,
  models: LocalModelEntry[]
): CapabilityOnboardingStatusResult {
  const ready = models.filter((model) => model.state === "ready" || model.state === "startable");
  if (ready.length > 0 || status.fallback.ready) {
    return {
      state: "configured",
      summary: `${Math.max(ready.length, 1)} local model${Math.max(ready.length, 1) === 1 ? "" : "s"} available.`,
      attention: "none",
      rawStage: status.fallback.warm ? "warm" : "ready",
    };
  }
  if (models.some((model) => model.state === "downloading") || status.downloads.length > 0) {
    return {
      state: "in-progress",
      summary: "A local model is downloading.",
      attention: "none",
      rawStage: "downloading",
    };
  }
  if (models.length > 0 && models.every((model) => model.state === "error")) {
    return {
      state: "needs-attention",
      summary: "The configured local models need attention.",
      attention: "optional",
      rawStage: "error",
    };
  }
  return {
    state: "using-defaults",
    summary: "Cloud models remain available; no local model is installed.",
    attention: "none",
    rawStage: "not-installed",
  };
}

const activeImportPhases = new Set([
  "queued",
  "discovering",
  "copying",
  "reading",
  "decrypting",
  "normalizing",
  "storing",
  "reconciling",
]);

function browserImportResult(jobs: ImportJobSnapshot[]): CapabilityOnboardingStatusResult {
  if (jobs.length === 0) {
    return {
      state: "not-configured",
      summary: "Ready without import; bring browser data in only if useful.",
      attention: "none",
      rawStage: "no-imports",
    };
  }
  const latest = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
  if (activeImportPhases.has(latest.phase)) {
    return {
      state: "in-progress",
      summary: "A browser import is in progress.",
      attention: "none",
      rawStage: latest.phase,
    };
  }
  if (latest.phase === "complete") {
    const completed = jobs.filter((job) => job.phase === "complete").length;
    return {
      state: "configured",
      summary: `${completed} browser import${completed === 1 ? "" : "s"} completed.`,
      attention: "none",
      rawStage: latest.phase,
    };
  }
  return {
    state: "needs-attention",
    summary: latest.resumable
      ? "The latest browser import can be resumed."
      : "The latest browser import did not complete.",
    attention: "optional",
    rawStage: latest.phase,
  };
}

export function createStatusAdapters(
  deps: OnboardingStatusDependencies = createDefaultStatusDependencies()
): Readonly<Record<string, CapabilityOnboardingStatusAdapter>> {
  return {
    github: async (opts) =>
      (await deps.hasSkill("skills/github/SKILL.md"))
        ? githubResult(await deps.github({ verify: opts?.verify === true }), opts?.verify === true)
        : unavailable(
            "GitHub setup is unavailable because its base capability owner could not be loaded.",
            "owner-unavailable"
          ),
    "ai-provider": async () => aiProviderResult(await deps.modelSettings()),
    "agent-defaults": async () => agentDefaultsResult(await deps.modelSettings()),
    "local-models": async () =>
      localModelsResult(await deps.localModelsStatus(), await deps.localModelsList()),
    "browser-environment": async () => browserImportResult(await deps.browserImportJobs()),
    "web-search": async () => {
      if (!(await deps.hasSkill("skills/web-research/SKILL.md"))) {
        return unavailable(
          "Enhanced web search is unavailable because its base capability owner could not be loaded.",
          "owner-unavailable"
        );
      }
      const provider = await deps.activeSearchProvider();
      return provider === "duckduckgo"
        ? {
            state: "using-defaults",
            summary: "Built-in DuckDuckGo search is active.",
            attention: "none",
            rawStage: provider,
          }
        : {
            state: "configured",
            summary: `${provider[0]!.toUpperCase()}${provider.slice(1)} search is active.`,
            attention: "none",
            rawStage: provider,
          };
    },
  };
}
