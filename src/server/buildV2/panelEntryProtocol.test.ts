import { describe, expect, it, vi } from "vitest";
import { adapterFrameworks } from "./adapters/index.js";
import { generatePanelEntry, panelEntryProtocolFingerprint } from "./panelEntryProtocol.js";

describe("panelEntryProtocolFingerprint", () => {
  it("is deterministic over the real generators", () => {
    expect(panelEntryProtocolFingerprint()).toBe(panelEntryProtocolFingerprint());
  });

  it("exercises the default and explicit framework-module branch of every adapter", () => {
    const generate = vi.fn(generatePanelEntry);
    panelEntryProtocolFingerprint(generate);
    expect(generate).toHaveBeenCalledTimes(adapterFrameworks().length * 2);
    const moduleArgs = generate.mock.calls.map((call) => call[3]);
    // One default-branch call (module absent) and one explicit call per adapter:
    // React and Svelte substitute their default framework-module constants only
    // on the absent branch, which is what ordinary panels get.
    expect(moduleArgs.filter((value) => value === undefined)).toHaveLength(
      adapterFrameworks().length
    );
    expect(moduleArgs.filter((value) => typeof value === "string")).toHaveLength(
      adapterFrameworks().length
    );
  });

  it("changes when any generated wrapper output changes", () => {
    const baseline = panelEntryProtocolFingerprint();
    const mutated = panelEntryProtocolFingerprint((expose, entry, adapter, frameworkModule) =>
      `${generatePanelEntry(expose, entry, adapter, frameworkModule)}/* protocol drift */`
    );
    expect(mutated).not.toBe(baseline);
  });

  it("changes when only the default-module branch drifts", () => {
    // Guards the branch a module-passing fixture would miss: a change to a
    // default framework-module constant alters ordinary panels' wrappers only
    // when the module argument is absent.
    const baseline = panelEntryProtocolFingerprint();
    const mutated = panelEntryProtocolFingerprint((expose, entry, adapter, frameworkModule) =>
      frameworkModule === undefined
        ? `${generatePanelEntry(expose, entry, adapter)}/* default drift */`
        : generatePanelEntry(expose, entry, adapter, frameworkModule)
    );
    expect(mutated).not.toBe(baseline);
  });

  it("includes the generated readiness publication in every hashed variant", () => {
    const generate = vi.fn(generatePanelEntry);
    panelEntryProtocolFingerprint(generate);
    for (const result of generate.mock.results) {
      expect(result.value).toContain("globalThis.__vibestudioPanelMarkReady?.()");
    }
  });
});
