import { describe, expect, it } from "vitest";
import { appArtifactRoute, appArtifactUrl, resolveGatewayRouteUrl } from "./appArtifacts.js";

describe("app artifact routes", () => {
  it("builds encoded gateway routes for artifacts", () => {
    expect(appArtifactRoute("build key", "chunks/app bundle.js")).toBe(
      "/_a/build%20key/chunks/app%20bundle.js"
    );
  });

  it("resolves artifact routes against gateway URLs with workspace base paths", () => {
    expect(
      resolveGatewayRouteUrl("https://host.tailnet.ts.net/_workspace/dev", "/_a/app/index.html")
    ).toBe("https://host.tailnet.ts.net/_workspace/dev/_a/app/index.html");
    expect(appArtifactUrl("http://127.0.0.1:39479", "app", "index.html")).toBe(
      "http://127.0.0.1:39479/_a/app/index.html"
    );
  });
});
