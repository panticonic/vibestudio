import { describe, expect, it, vi } from "vitest";
import { sha256Integrity } from "@vibestudio/client-host-core";
import { MemoryStore, bytesOf } from "../../core/src/testing.js";
import {
  CLIENT_DOCUMENT_CSP,
  ClientBuildCatalog,
  buildRelativePath,
  clientEntryUrl,
  createVerifiedClientResponder,
  type DeliveredBuild,
} from "./clientDelivery.js";

const PAGE = "<!doctype html><title>x</title>";
const SCRIPT = "console.log('client')";

async function fixture() {
  const store = new MemoryStore();
  const artifacts = [];
  for (const [path, role, contentType, text] of [
    ["index.html", "primary", "text/html; charset=utf-8", PAGE],
    ["bundle.js", "asset", "text/javascript", SCRIPT],
  ] as const) {
    const integrity = await sha256Integrity(bytesOf(text));
    await store.writeVerified(integrity, bytesOf(text), path);
    artifacts.push({ path, role, contentType, integrity });
  }
  const build: DeliveredBuild = { clientId: "browser", buildKey: "bk1", artifacts };
  const catalog = new ClientBuildCatalog();
  catalog.register(build);
  const failures: string[] = [];
  const respond = createVerifiedClientResponder(catalog, store, (message) =>
    failures.push(message)
  );
  return { store, build, catalog, respond, failures };
}

const get = (url: string) => ({ url, method: "GET" });

describe("verified client delivery", () => {
  it("serves a verified artifact from the cache, with the page confined by its CSP", async () => {
    const { respond, build } = await fixture();
    const page = await respond(get(clientEntryUrl(build)));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get("content-security-policy")).toBe(CLIENT_DOCUMENT_CSP);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const script = await respond(get("vs-client://browser/bk1/bundle.js"));
    expect(await script.text()).toBe(SCRIPT);
    expect(script.headers.get("content-security-policy")).toBeNull();
  });

  it("never serves bytes that no longer match their declared integrity", async () => {
    const { respond, store, build, failures } = await fixture();
    const script = build.artifacts[1]!;
    // The cached bytes change on disk after they were verified.
    store.files.set(script.integrity, { bytes: bytesOf("steal(credentials)"), name: "bundle.js" });
    const response = await respond(get("vs-client://browser/bk1/bundle.js"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("steal");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("bundle.js");
    // Untouched artifacts keep being served.
    expect((await respond(get(clientEntryUrl(build)))).status).toBe(200);
  });

  it("serves only paths of a registered build of the named client", async () => {
    const { respond, catalog } = await fixture();
    for (const url of [
      "vs-client://browser/bk2/index.html",
      "vs-client://other/bk1/index.html",
      "vs-client://browser/bk1/missing.js",
      "vs-client://browser/bk1/../bk1/index.html/..",
      "vs-client://browser/bk1/%2e%2e/index.html",
      "https://browser/bk1/index.html",
      "not a url",
    ]) {
      expect((await respond(get(url))).status, url).toBe(404);
    }
    catalog.retire("browser", "bk1");
    expect((await respond(get("vs-client://browser/bk1/index.html"))).status).toBe(404);
  });

  it("answers 404 for an artifact that left the cache and refuses writes", async () => {
    const { respond, store, build } = await fixture();
    await store.remove(build.artifacts[1]!.integrity);
    expect((await respond(get("vs-client://browser/bk1/bundle.js"))).status).toBe(404);
    expect((await respond({ url: clientEntryUrl(build), method: "POST" })).status).toBe(405);
  });

  it("does not read the store for an unknown path", async () => {
    const { catalog } = await fixture();
    const store = { has: vi.fn(), read: vi.fn() };
    const response = await createVerifiedClientResponder(
      catalog,
      store
    )(get("vs-client://browser/bk1/nope.js"));
    expect(response.status).toBe(404);
    expect(store.has).not.toHaveBeenCalled();
  });

  it("rejects paths that could name anything but a build-relative file", () => {
    expect(buildRelativePath("assets/chunk-1.js")).toBe("assets/chunk-1.js");
    for (const bad of ["", "/abs.js", "../x.js", "a//b.js", "a/./b.js"]) {
      expect(() => buildRelativePath(bad)).toThrow(/Invalid client artifact path/);
    }
  });

  it("requires exactly one primary HTML page to run a client", async () => {
    const { build } = await fixture();
    expect(() => clientEntryUrl({ ...build, artifacts: [build.artifacts[1]!] })).toThrow(
      /exactly one primary HTML page/
    );
  });
});
