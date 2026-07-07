import { bindingAudience, githubCredential } from "./providers.js";
import type { CredentialClient, UrlCredentialHandle } from "@vibestudio/credential-client";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";

export const manifest = {
  scopes: {
    github: ["repo", "read_user"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/user", methods: ["GET"] },
      { url: "https://api.github.com/user/repos", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*/issues/*", methods: ["GET", "PATCH"] },
      { url: "https://api.github.com/repos/*/pulls", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/pulls/*", methods: ["GET"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onIssue" },
      { event: "pull_request", deliver: "onPullRequest" },
    ],
  },
} as const;

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  type: string;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: GitHubUser;
  html_url: string;
  clone_url?: string;
  description?: string | null;
  default_branch?: string;
  [key: string]: unknown;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  body?: string | null;
  user?: GitHubUser;
  assignees?: GitHubUser[];
  labels?: Array<GitHubLabel | string>;
  repository_url?: string;
  /** Present on issue payloads that are actually pull requests. */
  pull_request?: unknown;
  [key: string]: unknown;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  state: string;
  html_url: string;
  title: string;
  body?: string | null;
  user?: GitHubUser;
  [key: string]: unknown;
}

export interface ListReposOptions {
  visibility?: "all" | "public" | "private";
  affiliation?: string;
  type?: "all" | "owner" | "member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  per_page?: number;
  page?: number;
}

export interface ListIssuesOptions {
  milestone?: string;
  state?: "open" | "closed" | "all";
  assignee?: string;
  creator?: string;
  mentioned?: string;
  labels?: string | string[];
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  since?: string;
  per_page?: number;
  page?: number;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  assignees?: string[];
  milestone?: number;
  labels?: string[];
}

export interface CreateRepoParams {
  name: string;
  private: boolean;
  description?: string;
}

export interface CreateRepoResult {
  cloneUrl: string;
  webUrl: string;
  owner: string;
}

interface GitHubCreatedRepo extends GitHubRepo {
  clone_url: string;
  html_url: string;
  owner: GitHubUser;
}

export interface GitHubIssueWebhookEvent {
  action?: string;
  issue?: GitHubIssue;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

export interface GitHubPullRequestWebhookEvent {
  action?: string;
  number?: number;
  pull_request?: GitHubPullRequest;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

function toQueryParams(params?: object): string {
  if (!params) {
    return "";
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Per-context GitHub API client. Build one with `createGitHubClient`
 * (see below) from a `CredentialClient` — the constructor resolves
 * URL-bound credentials lazily, then methods call the handles'
 * `fetch` directly. No per-method `auth` parameter.
 */
export interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface GitHubClient {
  /** The underlying URL-credential handle (exposed for `credentialId` access in push correlation). */
  handle(): Promise<UrlCredentialHandle>;
  getUser(): Promise<GitHubUser>;
  listRepos(opts?: ListReposOptions): Promise<GitHubRepo[]>;
  createRepo(params: CreateRepoParams): Promise<CreateRepoResult>;
  getRepo(owner: string, repo: string): Promise<GitHubRepo>;
  listIssues(owner: string, repo: string, opts?: ListIssuesOptions): Promise<GitHubIssue[]>;
  createIssue(owner: string, repo: string, params: CreateIssueParams): Promise<GitHubIssue>;
  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>;
  updateIssue(
    owner: string,
    repo: string,
    number: number,
    params: UpdateIssueParams
  ): Promise<GitHubIssue>;
}

/**
 * Build a GitHub client bound to the given `CredentialClient`. The
 * credential handles are resolved on first use and memoized — methods
 * don't repeat audience lookup. The harness never sees the
 * underlying token; auth is injected by the credentialed fetcher.
 */
export function createGitHubClient(credentials: CredentialClient): GitHubClient {
  const memoizeHandle = (
    resolveDescriptor: () => Parameters<CredentialClient["forAudience"]>[0]
  ) => {
    let handlePromise: Promise<UrlCredentialHandle> | null = null;
    return (): Promise<UrlCredentialHandle> => {
      if (!handlePromise) {
        const p = credentials.forAudience(resolveDescriptor());
        // Cache resolved success; clear the cache on rejection so a
        // later call can retry after the user (e.g.) registers a
        // credential mid-session.
        p.catch(() => {
          if (handlePromise === p) handlePromise = null;
        });
        handlePromise = p;
      }
      return handlePromise;
    };
  };
  const handle = memoizeHandle(() => ({
    ...githubCredential,
    label: githubCredential.displayName,
  }));
  const userHandle = memoizeHandle(() => bindingAudience(githubCredential, "github-user"));

  const apiFetch = async <T>(
    path: string,
    init?: RequestInit,
    credentialHandle: () => Promise<UrlCredentialHandle> = handle
  ): Promise<T> => {
    const auth = await credentialHandle();
    const headers = new Headers(init?.headers);
    headers.set("Accept", GITHUB_ACCEPT_HEADER);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await auth.fetch(`${GITHUB_API_BASE}${path}`, { ...init, headers });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`
      );
    }
    return (await response.json()) as T;
  };

  const enc = encodeURIComponent;

  return {
    handle,
    getUser: () => apiFetch<GitHubUser>("/user", undefined, userHandle),
    listRepos: (opts) =>
      apiFetch<GitHubRepo[]>(`/user/repos${toQueryParams(opts)}`, undefined, userHandle),
    getRepo: (owner, repo) => apiFetch<GitHubRepo>(`/repos/${enc(owner)}/${enc(repo)}`),
    listIssues: (owner, repo, opts) => {
      const labels = Array.isArray(opts?.labels) ? opts.labels.join(",") : opts?.labels;
      return apiFetch<GitHubIssue[]>(
        `/repos/${enc(owner)}/${enc(repo)}/issues${toQueryParams({ ...opts, labels })}`
      );
    },
    createIssue: (owner, repo, params) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues`, {
        method: "POST",
        body: JSON.stringify(params),
      }),
    createRepo: async (params) => {
      const repo = await apiFetch<GitHubCreatedRepo>(
        "/user/repos",
        {
          method: "POST",
          body: JSON.stringify(params),
        },
        userHandle
      );
      return {
        cloneUrl: repo.clone_url,
        webUrl: repo.html_url,
        owner: repo.owner.login,
      };
    },
    getIssue: (owner, repo, number) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}`),
    updateIssue: (owner, repo, number, params) =>
      apiFetch<GitHubIssue>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify(params),
      }),
  };
}

export function onIssue(event: GitHubIssueWebhookEvent) {
  return {
    type: "issues" as const,
    action: event.action ?? null,
    issue: event.issue ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}

export function onPullRequest(event: GitHubPullRequestWebhookEvent) {
  return {
    type: "pull_request" as const,
    action: event.action ?? null,
    number: event.number ?? event.pull_request?.number ?? null,
    pullRequest: event.pull_request ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}
