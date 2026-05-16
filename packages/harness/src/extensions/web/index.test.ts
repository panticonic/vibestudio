import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { createWebToolsExtension } from "./index.js";
import { parseLiteResults } from "./duckduckgo.js";
import { htmlToReadableMarkdown } from "./extract.js";
import { selectSearchProvider } from "./provider.js";

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

function createMockApi() {
  const registered = new Map<string, MockTool>();
  return {
    on: vi.fn(),
    registerTool: vi.fn((tool: MockTool) => {
      registered.set(tool.name, tool);
    }),
    setActiveTools: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    getRegistered: () => registered,
  };
}

function mockResponse(
  body: string,
  init?: { ok?: boolean; status?: number; contentType?: string; url?: string },
) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    url: init?.url,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") {
          return init?.contentType ?? "text/html; charset=utf-8";
        }
        return null;
      },
    },
    text: async () => body,
  };
}

function makeBlobstore() {
  const store = new Map<string, string>();
  const call = vi.fn(
    <T>(target: string, method: string, ...args: unknown[]): Promise<T> => {
      if (target !== "main") {
        return Promise.reject(new Error(`unexpected rpc target ${target}`));
      }
      if (method === "blobstore.putText") {
        const text = args[0] as string;
        const digest = createHash("sha256").update(text, "utf8").digest("hex");
        store.set(digest, text);
        return Promise.resolve({ digest, size: Buffer.byteLength(text, "utf8") } as T);
      }
      if (method === "blobstore.getRange") {
        const digest = args[0] as string;
        const offset = args[1] as number;
        const limit = args[2] as number;
        const text = store.get(digest);
        if (text === undefined) return Promise.resolve(null as T);
        const buf = Buffer.from(text, "utf8");
        if (offset >= buf.length) return Promise.resolve("" as T);
        return Promise.resolve(
          buf.subarray(offset, Math.min(buf.length, offset + limit)).toString("utf8") as T,
        );
      }
      return Promise.reject(new Error(`unexpected rpc method ${method}`));
    },
  );
  return { rpc: { call }, store };
}

describe("createWebToolsExtension", () => {
  it("registers web_search, web_fetch, and web_read", () => {
    const { rpc } = makeBlobstore();
    const factory = createWebToolsExtension({ rpc: rpc as never });
    const api = createMockApi();
    factory(api as never);

    expect(api.getRegistered().has("web_search")).toBe(true);
    expect(api.getRegistered().has("web_fetch")).toBe(true);
    expect(api.getRegistered().has("web_read")).toBe(true);
  });

  it("uses DuckDuckGo when no API key is available", async () => {
    const { rpc } = makeBlobstore();
    const fetcher = vi.fn(async () =>
      mockResponse(DDG_LITE_FIXTURE, { contentType: "text/html" }),
    ) as unknown as typeof fetch;
    const factory = createWebToolsExtension({ rpc: rpc as never, fetcher });
    const api = createMockApi();
    factory(api as never);

    const tool = api.getRegistered().get("web_search")!;
    const result = await tool.execute("call-1", { query: "tc39 stage 3" }, undefined);
    const details = result.details as { provider: string; results: unknown[] };
    expect(details.provider).toBe("duckduckgo");
    expect(details.results.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("auto-upgrades to Tavily when TAVILY_API_KEY is set", async () => {
    const { rpc } = makeBlobstore();
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("tavily.com");
      return mockResponse(
        JSON.stringify({
          results: [
            { title: "Example", url: "https://example.com", content: "snippet" },
          ],
        }),
        { contentType: "application/json" },
      );
    }) as unknown as typeof fetch;
    const factory = createWebToolsExtension({
      rpc: rpc as never,
      fetcher,
      getProviderApiKey: (name) => (name === "TAVILY_API_KEY" ? "key-123" : undefined),
    });
    const api = createMockApi();
    factory(api as never);

    const tool = api.getRegistered().get("web_search")!;
    const result = await tool.execute("call-1", { query: "anything" }, undefined);
    const details = result.details as { provider: string; results: Array<{ url: string }> };
    expect(details.provider).toBe("tavily");
    expect(details.results[0]!.url).toBe("https://example.com");
  });

  it("web_fetch caches markdown in the blobstore and returns digest + head", async () => {
    const { rpc, store } = makeBlobstore();
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    // headLength of 600 means a page that produces ~700+ bytes of markdown will truncate.
    const factory = createWebToolsExtension({ rpc: rpc as never, fetcher, headLength: 600 });
    const api = createMockApi();
    factory(api as never);

    const tool = api.getRegistered().get("web_fetch")!;
    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/spec" },
      undefined,
    );
    const details = result.details as {
      digest: string;
      size: number;
      truncated: boolean;
      head_length: number;
    };

    expect(details.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(details.size).toBeGreaterThan(0);
    expect(details.head_length).toBeLessThanOrEqual(600);
    expect(details.head_length).toBeLessThanOrEqual(details.size);
    expect(store.has(details.digest)).toBe(true);
    expect(store.get(details.digest)).toContain("Section");
  });

  it("web_read returns a slice of the cached page", async () => {
    const { rpc } = makeBlobstore();
    // Pre-populate the store via web_fetch.
    const fetcher = vi.fn(async () =>
      mockResponse(SAMPLE_PAGE_HTML, {
        contentType: "text/html",
        url: "https://example.com/spec",
      }),
    ) as unknown as typeof fetch;
    const factory = createWebToolsExtension({ rpc: rpc as never, fetcher });
    const api = createMockApi();
    factory(api as never);

    const fetchTool = api.getRegistered().get("web_fetch")!;
    const fetchResult = await fetchTool.execute(
      "call-1",
      { url: "https://example.com/spec" },
      undefined,
    );
    const { digest, size } = fetchResult.details as { digest: string; size: number };

    const readTool = api.getRegistered().get("web_read")!;
    const result = await readTool.execute(
      "call-2",
      { digest, offset: 0, limit: 20 },
      undefined,
    );
    const details = result.details as { digest: string; bytes: number };
    expect(details.digest).toBe(digest);
    expect(details.bytes).toBeLessThanOrEqual(20);
    expect(details.bytes).toBeLessThanOrEqual(size);
  });

  it("web_read throws when the digest is unknown", async () => {
    const { rpc } = makeBlobstore();
    const factory = createWebToolsExtension({ rpc: rpc as never });
    const api = createMockApi();
    factory(api as never);
    const readTool = api.getRegistered().get("web_read")!;
    await expect(
      readTool.execute("call-1", { digest: "0".repeat(64) }, undefined),
    ).rejects.toThrow(/no cached blob/);
  });

  it("web_fetch rejects non-http URLs", async () => {
    const { rpc } = makeBlobstore();
    const factory = createWebToolsExtension({ rpc: rpc as never });
    const api = createMockApi();
    factory(api as never);
    const tool = api.getRegistered().get("web_fetch")!;
    await expect(
      tool.execute("call-1", { url: "ftp://example.com/x" }, undefined),
    ).rejects.toThrow(/must start with http/);
  });
});

describe("parseLiteResults", () => {
  it("parses DuckDuckGo lite result tables", () => {
    const results = parseLiteResults(DDG_LITE_FIXTURE, 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toMatchObject({
      title: "Example Domain",
      url: "https://example.com/",
    });
    expect(results[0]!.snippet).toContain("illustrative");
    expect(results[1]!.url).toBe("https://nodejs.org/");
  });

  it("respects the limit", () => {
    const results = parseLiteResults(DDG_LITE_FIXTURE, 1);
    expect(results.length).toBe(1);
  });
});

describe("htmlToReadableMarkdown", () => {
  it("extracts readable content as markdown", () => {
    const out = htmlToReadableMarkdown(SAMPLE_PAGE_HTML, "https://example.com/spec");
    expect(out.title).toBeTruthy();
    expect(out.markdown).toContain("Section 7");
    expect(out.markdown).toContain("This is a paragraph");
  });
});

describe("selectSearchProvider", () => {
  it("defaults to duckduckgo when no getter is provided", async () => {
    await expect(selectSearchProvider(undefined)).resolves.toBe("duckduckgo");
  });
  it("returns tavily when the getter returns a non-empty key", async () => {
    await expect(
      selectSearchProvider((name) => (name === "TAVILY_API_KEY" ? "x" : undefined)),
    ).resolves.toBe("tavily");
  });
  it("returns duckduckgo when the getter returns empty", async () => {
    await expect(selectSearchProvider(() => "  ")).resolves.toBe("duckduckgo");
  });
});

const DDG_LITE_FIXTURE = `
<html><body>
<table>
  <tr>
    <td>1.&nbsp;</td>
    <td><a class="result-link" href="https://example.com/">Example Domain</a></td>
  </tr>
  <tr>
    <td colspan="2" class="result-snippet">Example Domain. This domain is for use in illustrative examples in documents.</td>
  </tr>
  <tr><td>&nbsp;</td></tr>
  <tr>
    <td>2.&nbsp;</td>
    <td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F&rut=abc">Node.js</a></td>
  </tr>
  <tr>
    <td colspan="2" class="result-snippet">Node.js is a JavaScript runtime.</td>
  </tr>
</table>
</body></html>
`;

const SAMPLE_PAGE_HTML = `
<!doctype html>
<html>
<head><title>Sample Spec</title></head>
<body>
  <nav>Site navigation, ignore me</nav>
  <article>
    <h1>Sample Spec</h1>
    <p>This is a paragraph of <strong>important</strong> content that Readability should preserve.</p>
    <h2>Section 7</h2>
    <p>Some more detail about <a href="https://example.com/details">the topic</a>.</p>
    <ul>
      <li>First bullet</li>
      <li>Second bullet</li>
    </ul>
    <p>And a closing line, this is a paragraph of regular text to give Readability enough to chew on so it does not bail out due to the charThreshold.</p>
    <p>Adding another paragraph here so the total text length is comfortably above the threshold and Readability is happy to extract the main content. The more text, the better the heuristics work.</p>
  </article>
  <footer>Site footer, ignore</footer>
</body>
</html>
`;
