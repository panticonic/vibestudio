import { parseHostConfig } from "./panelUrls";

describe("panelUrls", () => {
  it("parses origin-only server URLs", () => {
    expect(parseHostConfig("https://server.example")).toEqual({
      protocol: "https",
      host: "server.example",
      port: "",
    });
    expect(parseHostConfig("http://127.0.0.1:3030")).toEqual({
      protocol: "http",
      host: "127.0.0.1",
      port: "3030",
    });
  });

  it("rejects server URLs with credentials, paths, query, or fragments", () => {
    expect(() => parseHostConfig("https://user@server.example")).toThrow(/Invalid server URL/);
    expect(() => parseHostConfig("https://server.example/base")).toThrow(/Invalid server URL/);
    expect(() => parseHostConfig("https://server.example?x=1")).toThrow(/Invalid server URL/);
    expect(() => parseHostConfig("https://server.example#frag")).toThrow(/Invalid server URL/);
  });
});
