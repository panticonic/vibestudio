import { createHash } from "crypto";
import { adapterFrameworks, getAdapter } from "./adapters/index.js";
import type { FrameworkAdapter } from "./adapters/types.js";
import { getPanelRuntimeHelperSet } from "../panelRuntimeHelpers.js";

export function generatePanelEntry(
  exposeEntryFile: string,
  entryFile: string,
  adapter: FrameworkAdapter,
  frameworkModule?: string
): string {
  return `${adapter.generateEntry(exposeEntryFile, entryFile, frameworkModule)}
globalThis.__vibestudioPanelMarkReady?.();
`;
}

const FIXTURE_EXPOSE = "./__protocol_expose__.js";
const FIXTURE_ENTRY = "./__protocol_entry__.js";
const FIXTURE_MODULE = "@workspace/__protocol_framework__";

/** Hashes actual wrapper generators over every adapter and default/override branch. */
export function panelEntryProtocolFingerprint(
  generate: typeof generatePanelEntry = generatePanelEntry
): string {
  const hash = createHash("sha256");
  hash.update(`runtime-helpers:${getPanelRuntimeHelperSet().version}\0`);
  for (const framework of adapterFrameworks()) {
    const adapter = getAdapter(framework);
    hash.update(`${framework}:default\0${generate(FIXTURE_EXPOSE, FIXTURE_ENTRY, adapter)}\0`);
    hash.update(
      `${framework}:explicit\0${generate(FIXTURE_EXPOSE, FIXTURE_ENTRY, adapter, FIXTURE_MODULE)}\0`
    );
  }
  return hash.digest("hex");
}
