import { describe, expect, it, vi } from "vitest";
import {
  guardOutsideContentCall,
  guardOutsideContentStream,
  outsideContentSource,
} from "./outsideContent.js";

describe("outsideContentSource", () => {
  const cases: Array<[string, string, unknown[], string | null]> = [
    // HTTP egress that returns a remote body
    [
      "main",
      "credentials.proxyFetch",
      [{ url: "https://news.example.com/a?x=1", method: "GET" }],
      "web:news.example.com",
    ],
    [
      "main",
      "credentials.publishFetch",
      [{ url: "https://pages.example.org/up", method: "PUT" }, {}],
      "web:pages.example.org",
    ],
    [
      "main",
      "credentials.proxyGitHttp",
      [{ url: "https://github.com/o/r.git/info/refs" }],
      "web:github.com",
    ],
    [
      "main",
      "credentials.openWebSocketScope",
      [{ url: "wss://stream.example.net/feed", credentialId: "c" }],
      "web:stream.example.net",
    ],
    ["main", "chromiumFetch.openPublic", ["https://example.com/page"], "web:example.com"],
    [
      "main",
      "chromiumFetch.openBrowser",
      ["https://private.example.com/inbox"],
      "web:private.example.com",
    ],
    // remote Git
    [
      "main",
      "gitInterop.importProject",
      [{ path: "projects/x", remote: { url: "u" } }],
      "git:importProject:projects/x",
    ],
    ["main", "gitInterop.cloneRepo", [{ repoPath: "projects/y" }], "git:cloneRepo:projects/y"],
    [
      "main",
      "gitInterop.pullUpstream",
      ["projects/z", { dryRun: true }],
      "git:pullUpstream:projects/z",
    ],
    [
      "main",
      "gitInterop.remoteDefaultBranch",
      [{ url: "https://git.example.com/r.git" }],
      "git:remoteDefaultBranch:git.example.com",
    ],
    // live browser pages
    ["main", "panelCdp.getCdpEndpoint", ["panel:tree/a"], "cdp:panel:tree/a"],
    ["main", "panelCdp.evaluate", ["panel:tree/a", "document.title"], "cdp:panel:tree/a"],
    ["main", "panelCdp.screenshot", ["panel:tree/a"], "cdp:panel:tree/a"],
    ["main", "panelCdp.consoleHistory", ["panel:tree/a"], "cdp:panel:tree/a"],
    [
      "main",
      "panelCdp.browserOperation",
      ["panel:tree/a", { operation: "listDownloads" }],
      "cdp:panel:tree/a",
    ],
    // not outside content
    ["main", "credentials.resolveCredential", [{ url: "https://example.com/" }], null],
    ["main", "blobstore.getRangeBytes", ["a".repeat(64), 0, 10], null],
    ["main", "fs.readText", ["/a"], null],
    ["do:agent", "credentials.proxyFetch", [{ url: "https://example.com/" }], null],
  ];
  it.each(cases)("%s %s", (target, method, args, expected) => {
    expect(outsideContentSource(target, method, args)).toBe(expected);
  });

  it("names an unparseable destination rather than skipping it", () => {
    expect(outsideContentSource("main", "credentials.proxyFetch", [{ url: "nonsense" }])).toBe(
      "web:unknown-host"
    );
    expect(outsideContentSource("main", "credentials.proxyFetch", [])).toBe("web:unknown-host");
  });
});

describe("outside content guards", () => {
  it("record a unary call after it succeeds and before the result is returned", async () => {
    const order: string[] = [];
    const call = vi.fn(async (_t: string, method: string) => {
      order.push(`call ${method}`);
      return "body";
    });
    const guarded = guardOutsideContentCall(call, async ({ key }) => {
      order.push(`record ${key}`);
    });
    await expect(
      guarded("main", "credentials.proxyFetch", [{ url: "https://example.com/" }])
    ).resolves.toBe("body");
    expect(order).toEqual(["call credentials.proxyFetch", "record web:example.com"]);
    await guarded("main", "fs.readText", ["/a"]);
    expect(order).toHaveLength(3);
  });

  it("do not record a failed call, and fail a call the owner cannot record", async () => {
    const record = vi.fn(async () => undefined);
    const failing = guardOutsideContentCall(async () => {
      throw new Error("denied");
    }, record);
    await expect(
      failing("main", "chromiumFetch.openBrowser", ["https://x.example/"])
    ).rejects.toThrow("denied");
    expect(record).not.toHaveBeenCalled();

    const unrecordable = guardOutsideContentCall(
      async () => "body",
      async () => {
        throw new Error("owner refused");
      }
    );
    await expect(
      unrecordable("main", "chromiumFetch.openPublic", ["https://x.example/"])
    ).rejects.toThrow("owner refused");
  });

  it("record a stream before it opens, so no byte reaches the task first", async () => {
    const order: string[] = [];
    const open = vi.fn(async () => {
      order.push("open");
      return "stream";
    });
    const guarded = guardOutsideContentStream(open, async ({ key }) => {
      order.push(`record ${key}`);
    });
    await guarded("main", "credentials.proxyGitHttp", [{ url: "https://github.com/o/r.git" }]);
    expect(order).toEqual(["record web:github.com", "open"]);

    const refused = guardOutsideContentStream(open, async () => {
      throw new Error("owner refused");
    });
    await expect(
      refused("main", "credentials.proxyGitHttp", [{ url: "https://github.com/o/r.git" }])
    ).rejects.toThrow("owner refused");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("are the original function when no agent owns the eval", () => {
    const call = async () => "x";
    expect(guardOutsideContentCall(call, undefined)).toBe(call);
    expect(guardOutsideContentStream(call, undefined)).toBe(call);
  });
});
