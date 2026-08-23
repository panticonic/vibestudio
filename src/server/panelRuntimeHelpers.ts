/** Exact identity for the host-owned panel loader + browser transport set. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PANEL_BOOTSTRAP_SCRIPT } from "./panelBootstrapScript.js";
import { resolveRequiredAppRoot } from "./appRoot.js";

function loadBrowserTransport(): string {
  const transportPath = path.join(resolveRequiredAppRoot(), "dist", "browserTransport.js");
  try {
    return fs.readFileSync(transportPath, "utf-8");
  } catch (error) {
    throw new Error(
      `Browser transport is unavailable at the exact host artifact path ${transportPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export interface PanelRuntimeHelperSet {
  readonly browserTransportJs: string;
  readonly helpers: readonly {
    readonly path: "__loader.js" | "__transport.js";
    readonly contentType: string;
    readonly body: Buffer;
    readonly integrity: string;
  }[];
  readonly version: string;
}

let runtimeHelperSet: PanelRuntimeHelperSet | undefined;

/**
 * Acquire the immutable runtime-helper snapshot for this host process.
 *
 * Loading the built browser transport requires the explicit application root,
 * so it belongs at server/build activation rather than module evaluation.
 * Keeping imports inert lets documentation and schema tooling inspect build
 * definitions without accidentally invoking the server startup contract.
 */
export function getPanelRuntimeHelperSet(): PanelRuntimeHelperSet {
  if (runtimeHelperSet) return runtimeHelperSet;
  const browserTransportJs = loadBrowserTransport();
  const helpers = [
    {
      path: "__loader.js" as const,
      contentType: "application/javascript; charset=utf-8",
      body: Buffer.from(PANEL_BOOTSTRAP_SCRIPT),
    },
    {
      path: "__transport.js" as const,
      contentType: "application/javascript; charset=utf-8",
      body: Buffer.from(browserTransportJs),
    },
  ].map((helper) => ({
    ...helper,
    integrity: createHash("sha256").update(helper.body).digest("hex"),
  }));
  runtimeHelperSet = {
    browserTransportJs,
    helpers,
    version: createHash("sha256")
      .update(PANEL_BOOTSTRAP_SCRIPT)
      .update("\0")
      .update(browserTransportJs)
      .digest("hex"),
  };
  return runtimeHelperSet;
}

export function panelRuntimeHelperHref(name: "__loader.js" | "__transport.js"): string {
  return `./${name}?v=${getPanelRuntimeHelperSet().version}`;
}
