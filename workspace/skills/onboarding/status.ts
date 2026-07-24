import { browserData, createDurableObjectServiceClient, extensions } from "@workspace/runtime";
import {
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import {
  getGoogleOnboardingStatus,
  type GoogleOnboardingStatus,
} from "@workspace-skills/google-workspace";
import { getGitHubOnboardingStatus, type GitHubOnboardingStatus } from "@workspace-skills/github";
import { getActiveSearchProvider } from "@workspace-skills/web-research";
import type { ImportJobSnapshot } from "@vibestudio/browser-data";
import type { LocalModelEntry, LocalModelsStatus } from "../../extensions/local-models/types";
import type { SetupPresentationState } from "./catalog";

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

export interface OnboardingStatusDependencies {
  google(opts?: { verify?: boolean }): Promise<GoogleOnboardingStatus>;
  github(opts?: { verify?: boolean }): Promise<GitHubOnboardingStatus>;
  modelSettings(): Promise<ModelSettingsSnapshot>;
  localModelsStatus(): Promise<LocalModelsStatus>;
  localModelsList(): Promise<LocalModelEntry[]>;
  browserImportJobs(): Promise<ImportJobSnapshot[]>;
  activeSearchProvider(): Promise<"duckduckgo" | "tavily" | "brave" | "exa">;
}

export function createDefaultStatusDependencies(): OnboardingStatusDependencies {
  const modelSettings = createDurableObjectServiceClient(MODEL_SETTINGS_SERVICE_PROTOCOL);
  return {
    google: getGoogleOnboardingStatus,
    github: getGitHubOnboardingStatus,
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
    activeSearchProvider: getActiveSearchProvider,
  };
}

function unavailable(summary: string, rawStage: string): CapabilityOnboardingStatusResult {
  return {
    state: "unavailable",
    summary,
    attention: "none",
    rawStage,
  };
}

function googleResult(
  status: GoogleOnboardingStatus,
  verify: boolean
): CapabilityOnboardingStatusResult {
  if (status.stage === "error") {
    return unavailable("Google Workspace status is unavailable right now.", status.stage);
  }
  if (verify && status.verification && !status.verification.valid) {
    return {
      state: "needs-attention",
      verification: "failed",
      summary: "The current Google connection check failed.",
      attention: "blocking",
      rawStage: status.stage,
    };
  }
  if (status.stage === "verified") {
    return {
      state: "connected",
      verification: "verified",
      summary: status.email ? `Verified as ${status.email}.` : "Google Workspace verified.",
      attention: "none",
      rawStage: status.stage,
    };
  }
  if (status.connected) {
    return {
      state: "connected-unverified",
      verification: "unverified",
      summary: status.email
        ? `Connected as ${status.email}; not checked live.`
        : "Connected; not checked live.",
      attention: "none",
      rawStage: status.stage,
    };
  }
  return {
    state: "not-configured",
    summary:
      status.stage === "needs-setup"
        ? "Google OAuth needs setup before an account can connect."
        : "No Google Workspace account is connected.",
    attention: "optional",
    rawStage: status.stage,
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
    "google-workspace": async (opts) =>
      googleResult(await deps.google({ verify: opts?.verify === true }), opts?.verify === true),
    github: async (opts) =>
      githubResult(await deps.github({ verify: opts?.verify === true }), opts?.verify === true),
    "ai-provider": async () => aiProviderResult(await deps.modelSettings()),
    "agent-defaults": async () => agentDefaultsResult(await deps.modelSettings()),
    "local-models": async () =>
      localModelsResult(await deps.localModelsStatus(), await deps.localModelsList()),
    "browser-environment": async () => browserImportResult(await deps.browserImportJobs()),
    "web-search": async () => {
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
