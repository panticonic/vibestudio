import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTemplateState } from "@vibestudio/workspace-contracts/types";
import {
  baseTemplatePullForRelease,
  readBaseTemplateRelease,
  startBaseTemplateReleasePullCoordinator,
} from "./baseTemplateRelease.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const currentPin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
const releasePin = {
  ...currentPin,
  commit: "c".repeat(40),
  snapshot: `v1-sha256:${"d".repeat(64)}` as const,
};

function state(pin = currentPin): WorkspaceTemplateState {
  return {
    version: 1,
    roots: [{ url: pin.url }],
    overrides: {},
    nodes: [
      {
        nodeId: "t-base",
        alias: "base-stable",
        pin,
        parents: [],
        suggestions: {},
      },
    ],
    repositories: {},
  };
}

describe("host base-template release", () => {
  it("reads the checked host resource rather than workspace content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-"));
    created.push(root);
    fs.mkdirSync(path.join(root, "build-resources"));
    fs.writeFileSync(
      path.join(root, "build-resources", "base-template-release.json"),
      `${JSON.stringify({ version: 1, baseTemplate: releasePin, systemNotes: [] })}\n`
    );
    expect(readBaseTemplateRelease(root)?.baseTemplate).toEqual(releasePin);
  });

  it("opens one deterministic ordinary pull when the shipped pin differs", () => {
    const release = {
      version: 1 as const,
      baseTemplate: releasePin,
      systemNotes: [],
      parsedSystemNotes: [],
    };
    const first = baseTemplatePullForRelease(release, state());
    const second = baseTemplatePullForRelease(release, state());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ alias: "base-stable", pin: releasePin });
    expect(first?.commandId).toMatch(/^host-base-template-release:[0-9a-f]{32}$/u);
  });

  it("does nothing when the workspace already has the host release pin", () => {
    expect(
      baseTemplatePullForRelease(
        {
          version: 1,
          baseTemplate: releasePin,
          systemNotes: [],
          parsedSystemNotes: [],
        },
        state(releasePin)
      )
    ).toBeNull();
  });
});

describe("base-template release pull coordinator", () => {
  it("reports and retries initiation failures until the durable operation opens", async () => {
    const callbacks: Array<() => void> = [];
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Composer is starting"))
      .mockResolvedValueOnce(undefined);
    const reportFailure = vi.fn();
    const reportReady = vi.fn();
    const coordinator = startBaseTemplateReleasePullCoordinator({
      attempt,
      reportFailure,
      reportReady,
      retryDelaysMs: [10],
      schedule: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
    });

    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith(expect.any(Error), 10));
    callbacks.shift()?.();
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledTimes(1));
    expect(attempt).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("cancels a scheduled retry during shutdown", async () => {
    const cancel = vi.fn();
    const reportFailure = vi.fn();
    const coordinator = startBaseTemplateReleasePullCoordinator({
      attempt: async () => {
        throw new Error("offline");
      },
      reportFailure,
      reportReady: vi.fn(),
      retryDelaysMs: [10],
      schedule: () => cancel,
    });
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledTimes(1));
    coordinator.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
