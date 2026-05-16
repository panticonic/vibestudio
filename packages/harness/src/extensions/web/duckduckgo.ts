import { parseHTML } from "linkedom";
import type { SearchResult } from "./types.js";

const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface DuckDuckGoFetcher {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function searchDuckDuckGo(
  query: string,
  limit: number,
  fetcher: DuckDuckGoFetcher = fetch as unknown as DuckDuckGoFetcher,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query }).toString();
  const res = await fetcher(DDG_LITE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo lite returned HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseLiteResults(html, limit);
}

export function parseLiteResults(html: string, limit: number): SearchResult[] {
  // The lite.duckduckgo.com response is a table with one result per three rows:
  //   <tr><td>[1]&nbsp;</td><td><a class="result-link" href="URL">TITLE</a></td></tr>
  //   <tr><td colspan="2" class="result-snippet">SNIPPET</td></tr>
  //   <tr> (separator) </tr>
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];

  const anchors = document.querySelectorAll("a.result-link");
  for (let i = 0; i < anchors.length && out.length < limit; i++) {
    const anchor = anchors[i] as Element;
    const href = anchor.getAttribute("href") ?? "";
    const url = unwrapDdgRedirect(href);
    if (!url) continue;
    const title = (anchor.textContent ?? "").trim();
    if (!title) continue;

    // Find the snippet — the next `td.result-snippet` after this anchor.
    const titleRow = anchor.closest("tr");
    let snippet = "";
    let cursor: Element | null = titleRow?.nextElementSibling ?? null;
    while (cursor) {
      const snippetCell = cursor.querySelector("td.result-snippet");
      if (snippetCell) {
        snippet = (snippetCell.textContent ?? "").trim().replace(/\s+/gu, " ");
        break;
      }
      // Stop scanning if we hit the next result-link row.
      if (cursor.querySelector("a.result-link")) break;
      cursor = cursor.nextElementSibling;
    }

    out.push({ title, url, snippet });
  }

  return out;
}

function unwrapDdgRedirect(href: string): string | null {
  if (!href) return null;
  // DDG sometimes wraps result URLs as `//duckduckgo.com/l/?uddg=<encoded>&rut=...`.
  if (href.startsWith("//duckduckgo.com/l/") || href.includes("duckduckgo.com/l/")) {
    try {
      const url = new URL(href.startsWith("//") ? `https:${href}` : href);
      const target = url.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return null;
}
