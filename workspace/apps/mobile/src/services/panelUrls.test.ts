import { parseHostConfig, parsePanelUrl } from "./panelUrls";

describe("panelUrls", () => {
  it("parses origin-only server URLs", () => {
    expect(parseHostConfig("https://server.example")).toEqual({
      protocol: "https",
      host: "server.example",
      port: "",
      basePath: "",
    });
    expect(parseHostConfig("http://127.0.0.1:3030")).toEqual({
      protocol: "http",
      host: "127.0.0.1",
      port: "3030",
      basePath: "",
    });
  });

  it("preserves selected workspace path prefixes", () => {
    expect(parseHostConfig("https://server.example/_workspace/dev")).toEqual({
      protocol: "https",
      host: "server.example",
      port: "",
      basePath: "/_workspace/dev",
    });
  });

  it("parses managed panel URLs under a selected workspace prefix", () => {
    const parsed = parsePanelUrl(
      "https://server.example/_workspace/dev/panels/chat/?contextId=ctx-1",
      "server.example",
      "/_workspace/dev"
    );

    expect(parsed).toMatchObject({
      source: "panels/chat",
      contextId: "ctx-1",
    });
  });

  it("does not parse panel URLs outside the selected workspace prefix", () => {
    expect(
      parsePanelUrl("https://server.example/panels/chat/?contextId=ctx-1", "server.example", "/_workspace/dev")
    ).toBeNull();
  });

  it("rejects server URLs with credentials, query, or fragments", () => {
    expect(() => parseHostConfig("https://user@server.example")).toThrow(/Invalid server URL/);
    expect(() => parseHostConfig("https://server.example?x=1")).toThrow(/Invalid server URL/);
    expect(() => parseHostConfig("https://server.example#frag")).toThrow(/Invalid server URL/);
  });
});
