import { createGitHubClient } from "./github.js";
import type { CredentialClient } from "@vibestudio/credential-client";

export interface RemoteCreateRepoParams {
  name: string;
  private: boolean;
  description?: string;
}

export interface RemoteCreateRepoResult {
  cloneUrl: string;
  webUrl: string;
  owner: string;
}

export interface RemoteWebUrls {
  webUrl: string;
  ownerUrl: string;
  issuesUrl: string;
  pullRequestsUrl: string;
  actionsUrl: string;
}

export interface RemoteProvider {
  id: string;
  displayName: string;
  matches(idOrUrl: string): boolean;
  createRepo(
    credentials: CredentialClient,
    params: RemoteCreateRepoParams
  ): Promise<RemoteCreateRepoResult>;
  webUrls(remoteUrl: string): RemoteWebUrls | null;
}

interface ParsedGitHubRemote {
  owner: string;
  repo: string;
}

const providers = new Map<string, RemoteProvider>();

export function registerRemoteProvider(provider: RemoteProvider): RemoteProvider {
  const id = provider.id.trim().toLowerCase();
  if (!id) {
    throw new Error("Remote provider id is required");
  }
  providers.set(id, provider);
  return provider;
}

export function getRemoteProvider(idOrUrl: string): RemoteProvider | undefined {
  const input = idOrUrl.trim();
  const providerById = providers.get(input.toLowerCase());
  if (providerById) {
    return providerById;
  }

  for (const provider of providers.values()) {
    if (provider.matches(input)) {
      return provider;
    }
  }
  return undefined;
}

export const githubRemoteProvider: RemoteProvider = {
  id: "github",
  displayName: "GitHub",
  matches: (idOrUrl) => parseGitHubHttpsRemote(idOrUrl) !== null,
  createRepo: (credentials, params) => createGitHubClient(credentials).createRepo(params),
  webUrls(remoteUrl) {
    const parsed = parseGitHubHttpsRemote(remoteUrl);
    if (!parsed) {
      return null;
    }

    const owner = encodeURIComponent(parsed.owner);
    const repo = encodeURIComponent(parsed.repo);
    const webUrl = `https://github.com/${owner}/${repo}`;
    return {
      webUrl,
      ownerUrl: `https://github.com/${owner}`,
      issuesUrl: `${webUrl}/issues`,
      pullRequestsUrl: `${webUrl}/pulls`,
      actionsUrl: `${webUrl}/actions`,
    };
  },
};

registerRemoteProvider(githubRemoteProvider);

function parseGitHubHttpsRemote(remoteUrl: string): ParsedGitHubRemote | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = safeDecodeURIComponent(segments[0]!);
  const repo = stripGitSuffix(safeDecodeURIComponent(segments[1]!));
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
