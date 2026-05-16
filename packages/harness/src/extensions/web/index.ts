/**
 * NatStack Web Tools Extension
 *
 * Registers three Pi tools:
 *   - `web_search` — Discovery via DuckDuckGo (zero-config) or Tavily when
 *     `TAVILY_API_KEY` is set in the worker env.
 *   - `web_fetch` — Fetches a URL, extracts main content with Mozilla
 *     Readability, converts to markdown, stores the full result in the
 *     content-addressed blobstore, and returns `{ url, title, digest, size, head }`.
 *   - `web_read` — Reads a byte range of a previously-fetched blob by digest
 *     so the agent can drill into large pages without re-fetching.
 *
 * Designed for a "good basic experience" with zero API setup: DDG works from
 * any residential IP; the abstraction lets keyed providers auto-upgrade.
 */

import type { PiExtensionAPI, PiExtensionFactory } from "../../pi-extension-api.js";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchTavily } from "./tavily.js";
import { extractPage } from "./extract.js";
import { selectSearchProvider, type ProviderApiKeyGetter } from "./provider.js";

export type WebRpcCaller = <T = unknown>(
  target: string,
  method: string,
  ...args: unknown[]
) => Promise<T>;

export interface WebToolsDeps {
  /** RPC client for blobstore put/range reads. */
  rpc: { call: WebRpcCaller };
  /** Reads an API key from the worker env. Optional; defaults to "no keys". */
  getProviderApiKey?: ProviderApiKeyGetter;
  /** Override for the global fetch — used in tests. */
  fetcher?: typeof fetch;
  /** Length of the head excerpt included inline with `web_fetch` results. */
  headLength?: number;
}

const DEFAULT_HEAD_LENGTH = 5000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_LIMIT = 8000;
const MAX_READ_LIMIT = 32_000;

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    max_results: {
      type: "integer",
      description: `How many results to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}).`,
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
    },
  },
  required: ["query"],
};

const FETCH_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute URL (http:// or https://) to fetch." },
  },
  required: ["url"],
};

const READ_PARAMETERS = {
  type: "object",
  properties: {
    digest: {
      type: "string",
      description: "sha256 digest returned by an earlier web_fetch call.",
    },
    offset: {
      type: "integer",
      description: "Byte offset to start reading from (default 0).",
      minimum: 0,
    },
    limit: {
      type: "integer",
      description: `Maximum number of bytes to read (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`,
      minimum: 1,
      maximum: MAX_READ_LIMIT,
    },
  },
  required: ["digest"],
};

export function createWebToolsExtension(deps: WebToolsDeps): PiExtensionFactory {
  const fetcher = (deps.fetcher ?? fetch) as typeof fetch;
  const headLength = Math.max(500, deps.headLength ?? DEFAULT_HEAD_LENGTH);

  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the open web. Returns a list of { title, url, snippet }. Uses DuckDuckGo by default; auto-upgrades to Tavily if TAVILY_API_KEY is set.",
      parameters: SEARCH_PARAMETERS as never,
      execute: async (_toolCallId, params) => {
        const { query, max_results } = params as { query: string; max_results?: number };
        if (!query || typeof query !== "string") {
          throw new Error("web_search: 'query' is required");
        }
        const limit = clampInt(max_results, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
        const provider = await selectSearchProvider(deps.getProviderApiKey);

        const results =
          provider === "tavily"
            ? await searchTavily(
                query,
                limit,
                (await deps.getProviderApiKey?.("TAVILY_API_KEY")) ?? "",
                fetcher as never,
              )
            : await searchDuckDuckGo(query, limit, fetcher as never);

        const text = formatSearchResults(results, provider, query);
        return {
          content: [{ type: "text" as const, text }],
          details: { provider, query, count: results.length, results },
        };
      },
    });

    pi.registerTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch a URL, extract its main content as markdown, and cache the full result in the blobstore. Returns the cleaned title, a head excerpt, and a digest. Use web_read with the digest to read more of the cached page without re-fetching.",
      parameters: FETCH_PARAMETERS as never,
      execute: async (_toolCallId, params) => {
        const { url } = params as { url: string };
        if (!url || typeof url !== "string") {
          throw new Error("web_fetch: 'url' is required");
        }
        if (!/^https?:\/\//iu.test(url)) {
          throw new Error("web_fetch: 'url' must start with http:// or https://");
        }

        const page = await extractPage(url, fetcher as never);
        const stored = await deps.rpc.call<{ digest: string; size: number }>(
          "main",
          "blobstore.putText",
          page.markdown,
        );
        const head = page.markdown.slice(0, headLength);
        const truncated = page.markdown.length > head.length;

        const summary = [
          `# ${page.title}`,
          page.url,
          "",
          `Cached as digest ${stored.digest} (${stored.size} bytes).`,
          truncated
            ? `Showing the first ${head.length} of ${stored.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
            : "Full content shown below.",
          "",
          head,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            url: page.url,
            title: page.title,
            digest: stored.digest,
            size: stored.size,
            head_length: head.length,
            truncated,
          },
        };
      },
    });

    pi.registerTool({
      name: "web_read",
      label: "Web Read",
      description:
        "Read a byte range of a page previously cached by web_fetch. Identify the page by the digest returned from web_fetch.",
      parameters: READ_PARAMETERS as never,
      execute: async (_toolCallId, params) => {
        const { digest, offset, limit } = params as {
          digest: string;
          offset?: number;
          limit?: number;
        };
        if (!digest || typeof digest !== "string") {
          throw new Error("web_read: 'digest' is required");
        }
        const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
        const len = clampInt(limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);

        const slice = await deps.rpc.call<string | null>(
          "main",
          "blobstore.getRange",
          digest,
          off,
          len,
        );
        if (slice === null) {
          throw new Error(`web_read: no cached blob found for digest ${digest}`);
        }
        return {
          content: [{ type: "text" as const, text: slice }],
          details: { digest, offset: off, limit: len, bytes: slice.length },
        };
      },
    });
  };
}

function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const n = Math.trunc(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function formatSearchResults(
  results: Array<{ title: string; url: string; snippet: string }>,
  provider: string,
  query: string,
): string {
  if (results.length === 0) {
    return `No results for "${query}" (provider: ${provider}).`;
  }
  const lines: string[] = [`Web search results for "${query}" (provider: ${provider}):`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

export type { SearchResult, ProviderName } from "./types.js";
export type { ProviderApiKeyGetter } from "./provider.js";
