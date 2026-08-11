// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TemplateStatusRow } from "@vibestudio/service-schemas/templates";
import {
  useTemplateManagementController,
  type TemplateLifecycleClient,
  type TemplatePendingOperation,
} from "./useTemplateManagementController.js";

const operationId = "pull-github";
const deferredRow = {
  nodeId: "node-github",
  alias: "github",
  url: "git+https://example.test/github.git",
  ref: "refs/tags/v1",
  commit: "1".repeat(40),
  direct: true,
  state: "reviewing",
  contributedParts: 1,
  pendingReviews: 1,
  review: {
    operationId,
    contextId: "ctx:pull",
    approvalGranted: true,
    items: [{ repoPath: "extensions/github", sourceDeltaId: "delta:github" }],
  },
  suggestions: [],
} satisfies TemplateStatusRow;

const attachedOperation = {
  operationId,
  kind: "pull",
  contextId: "ctx:pull",
  initiator: "user",
  state: "reviewing",
  fingerprint: `v1-sha256:${"a".repeat(64)}`,
  review: deferredRow.review,
} satisfies TemplatePendingOperation;

function client(overrides: Partial<TemplateLifecycleClient> = {}): TemplateLifecycleClient {
  return {
    status: vi.fn(async () => []),
    operations: vi.fn(async () => []),
    catalog: vi.fn<TemplateLifecycleClient["catalog"]>(async () => ({
      version: 1 as const,
      revision: "registry-v1",
      systemEpoch: 1,
      entries: [],
      coordinates: {
        url: "git+https://example.test/registry.git",
        ref: "refs/heads/main",
        commit: "2".repeat(40),
        snapshot: `v1-sha256:${"2".repeat(64)}`,
      },
      source: "verified",
      stale: false,
      verifiedAt: "2026-08-05T00:00:00.000Z",
    })),
    check: vi.fn(async () => []),
    ...overrides,
  };
}

describe("useTemplateManagementController", () => {
  it("treats an empty verified-registry cache as a neutral first-run state", async () => {
    const source = client({ catalog: vi.fn(async () => null) });
    const view = renderHook(() => useTemplateManagementController(source));

    await act(async () => void (await view.result.current.refresh()));

    expect(view.result.current.catalog).toBeNull();
    expect(view.result.current.error).toBeNull();
  });

  it("renders the post-check observation and projects attached operations only on their row", async () => {
    const status = vi
      .fn<TemplateLifecycleClient["status"]>()
      .mockResolvedValueOnce([deferredRow])
      .mockResolvedValueOnce([deferredRow]);
    const unattached = {
      ...attachedOperation,
      operationId: "add-news",
      kind: "add" as const,
      contextId: "ctx:add",
      review: undefined,
      state: "pending" as const,
    };
    const source = client({
      status,
      operations: vi.fn(async () => [attachedOperation, unattached]),
      check: vi.fn(async () => [{ alias: "github" }]),
    });
    const view = renderHook(() => useTemplateManagementController(source));

    await act(async () => void (await view.result.current.refresh()));

    expect(status).toHaveBeenCalledTimes(2);
    expect(view.result.current.rows[0]?.state).toBe("reviewing");
    expect(view.result.current.operations.map((operation) => operation.operationId)).toEqual([
      "add-news",
    ]);
  });

  it("excludes duplicate commands by key and preserves a successful outcome when refresh fails", async () => {
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<{ state: "done" }>((resolve) => {
          release = () => resolve({ state: "done" });
        })
    );
    const source = client({ status: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const view = renderHook(() => useTemplateManagementController(source));

    let first!: Promise<{ state: "done" } | null>;
    let duplicate!: Promise<{ state: "done" } | null>;
    act(() => {
      first = view.result.current.execute({
        key: "operation:one",
        task,
        success: () => "Operation complete.",
        failure: () => "Operation failed.",
      });
      duplicate = view.result.current.execute({
        key: "operation:one",
        task,
        success: () => "Wrong duplicate.",
        failure: () => "Wrong duplicate failure.",
      });
    });
    expect(await duplicate).toBeNull();
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await first;
    });
    await waitFor(() => expect(view.result.current.notice).toBe("Operation complete."));
    expect(view.result.current.error).toContain("operation succeeded");
  });
});
