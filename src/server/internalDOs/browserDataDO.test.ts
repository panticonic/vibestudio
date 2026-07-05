import { describe, expect, it } from "vitest";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import { isBrowserDataDirectCaller } from "./browserDataDO.js";

/**
 * Layer-A receiver policy for BrowserDataDO (holds user
 * credentials/passwords/cookies/history). Direct callers are shell + shell-side
 * server services, PLUS the manifest-declared browser-data broker extension
 * (meta/vibestudio.yml `providers.browserData.extension`, injected as the
 * `BROWSER_DATA_BROKER_ID` env binding) — the designated mediator panels/agents
 * go through. Every other caller kind, and every OTHER extension, must be
 * refused so the open relay cannot read secrets by addressing the DO directly.
 * (The DO itself needs an FTS5 schema sql.js can't build, so we test the
 * extracted policy predicate directly.)
 */
const caller = (callerKind: string, callerId = "x"): AuthenticatedCaller =>
  ({ callerId, callerKind }) as AuthenticatedCaller;

const BROKER = "@workspace-extensions/browser-data";

describe("BrowserDataDO direct-caller policy", () => {
  it("allows shell and server", () => {
    expect(isBrowserDataDirectCaller(caller("shell", "shell"), BROKER)).toBe(true);
    expect(isBrowserDataDirectCaller(caller("server", "main"), BROKER)).toBe(true);
    // Shell/server access does not depend on a declared broker.
    expect(isBrowserDataDirectCaller(caller("shell", "shell"), null)).toBe(true);
    expect(isBrowserDataDirectCaller(caller("server", "main"), null)).toBe(true);
  });

  it("allows ONLY the manifest-declared broker extension", () => {
    expect(isBrowserDataDirectCaller(caller("extension", BROKER), BROKER)).toBe(true);
    // Any other extension is refused — it would otherwise leak user credentials.
    expect(
      isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/evil"), BROKER)
    ).toBe(false);
    expect(
      isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/news"), BROKER)
    ).toBe(false);
    // A renamed broker declaration moves trust with it.
    expect(
      isBrowserDataDirectCaller(
        caller("extension", "@workspace-extensions/my-browser-broker"),
        "@workspace-extensions/my-browser-broker"
      )
    ).toBe(true);
  });

  it("refuses ALL extensions when no broker is declared in the manifest", () => {
    expect(isBrowserDataDirectCaller(caller("extension", BROKER), null)).toBe(false);
    expect(isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/evil"), null)).toBe(
      false
    );
  });

  it("refuses panel, agent (do), worker, and null callers", () => {
    expect(isBrowserDataDirectCaller(caller("panel", "panel:1"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(caller("do", "do:agent"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(caller("worker", "worker:1"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(null, BROKER)).toBe(false);
  });
});
