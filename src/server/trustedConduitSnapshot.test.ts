import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  trustedConduitTemplate,
  resolveTrustedConduits,
  unblessedLiveConduits,
} from "./trustedConduitSnapshot.js";
import { PRODUCT_CONDUIT_UNITS } from "./productConduitPolicy.js";

const pin = (name: string): WorkspaceTemplatePin => ({
  url: `https://example.com/${name}.git`,
  ref: "refs/heads/main",
  commit: name.charCodeAt(0).toString(16).repeat(20),
});
const defaults = { base: pin("base"), personal: pin("personal"), system: pin("system") };

describe("trusted distribution conduit seeds", () => {
  it("never trusts app content or a mutable revision at a first-party URL", () => {
    expect(trustedConduitTemplate(pin("app"), defaults)).toEqual(defaults.base);
    expect(
      trustedConduitTemplate({ ...defaults.system, commit: "f".repeat(40) }, defaults)
    ).toEqual(defaults.base);
    expect(trustedConduitTemplate(defaults.system, defaults)).toEqual(defaults.system);
    expect(trustedConduitTemplate(defaults.personal, defaults)).toEqual(defaults.personal);
  });

  it("accepts a minimal trusted distribution without importing personal or System harnesses", async () => {
    const state = `state:${"a".repeat(64)}`;
    const resolve = vi.fn(async (paths: readonly string[]) =>
      paths.map((unitPath) =>
        unitPath === "workers/agent-worker"
          ? {
              unitPath,
              unitName: "@workspace-workers/agent-worker",
              kind: "worker" as const,
              stateHash: state,
              effectiveVersion: "b".repeat(64),
            }
          : null
      )
    );
    expect(await resolveTrustedConduits(state, resolve)).toEqual([
      { repoPath: "workers/agent-worker", effectiveVersion: "b".repeat(64) },
    ]);
    expect(resolve).toHaveBeenCalledWith(PRODUCT_CONDUIT_UNITS, state);
  });
});

describe("live conduit blessing coverage", () => {
  const blessed = new Map([["workers/system-test-runner", "a".repeat(64)]]);
  const isBlessed = (identity: { repoPath: string; effectiveVersion: string }): boolean =>
    blessed.get(identity.repoPath) === identity.effectiveVersion;

  it("names a conduit whose live version the blessing does not cover", () => {
    expect(
      unblessedLiveConduits({
        units: ["workers/system-test-runner"],
        liveVersion: () => "b".repeat(64),
        isBlessed,
      })
    ).toEqual([{ repoPath: "workers/system-test-runner", effectiveVersion: "b".repeat(64) }]);
  });

  it("stays quiet when the live version is the blessed one", () => {
    expect(
      unblessedLiveConduits({
        units: ["workers/system-test-runner"],
        liveVersion: () => "a".repeat(64),
        isBlessed,
      })
    ).toEqual([]);
  });

  it("does not treat a unit this distribution never shipped as a mismatch", () => {
    // The product policy is an allowlist, not a manifest every root fulfils.
    expect(
      unblessedLiveConduits({
        units: [...PRODUCT_CONDUIT_UNITS],
        liveVersion: (repoPath) =>
          repoPath === "workers/system-test-runner" ? "a".repeat(64) : null,
        isBlessed,
      })
    ).toEqual([]);
  });
});
