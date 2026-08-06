// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { TemplateReviewPanel } from "./templateReview.js";

const target = { kind: "event", eventId: "event:workspace" } as const;
const item = { repoPath: "panels/news", deltaId: "delta:news" };

describe("TemplateReviewPanel", () => {
  it("records an ordinary VCS integration decision instead of discarding the comparison", async () => {
    const compare = vi
      .fn()
      .mockResolvedValueOnce({
        target,
        sourceDeltaId: item.deltaId,
        resolution: { complete: false, remainingChangeCount: 1 },
        counts: {
          shared: 0,
          alreadySatisfied: 0,
          actionable: 1,
          conflicting: 0,
          blocked: 0,
          accounted: 0,
          historical: 0,
        },
        changes: [
          {
            changeId: "change:news",
            workUnitId: "work:news",
            kind: "file-create",
            summary: "Add the News panel",
            disposition: { status: "actionable", applicability: "applicable" },
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        target,
        sourceDeltaId: item.deltaId,
        resolution: { complete: true, remainingChangeCount: 0 },
        counts: {
          shared: 0,
          alreadySatisfied: 0,
          actionable: 0,
          conflicting: 0,
          blocked: 0,
          accounted: 1,
          historical: 0,
        },
        changes: [],
        nextCursor: null,
      });
    const integrate = vi.fn(async () => undefined);
    const onCompleted = vi.fn();

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={compare}
          integrate={integrate}
          onCompleted={onCompleted}
        />
      </Theme>
    );

    const useChange = await screen.findByRole("button", { name: "Use this change" });
    fireEvent.click(useChange);

    await waitFor(() =>
      expect(integrate).toHaveBeenCalledWith({
        item,
        expectedWorkingHead: target,
        decision: { kind: "adopted", sourceChangeIds: ["change:news"] },
      })
    );
    const finish = await screen.findByRole("button", { name: "Finish template operation" });
    expect(onCompleted).not.toHaveBeenCalled();
    fireEvent.click(finish);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("can finish a review that was already complete when the surface reopened", async () => {
    const compare = vi.fn(async () => ({
      target,
      sourceDeltaId: item.deltaId,
      resolution: { complete: true, remainingChangeCount: 0 },
      counts: {
        shared: 0,
        alreadySatisfied: 0,
        actionable: 0,
        conflicting: 0,
        blocked: 0,
        accounted: 1,
        historical: 0,
      },
      changes: [],
      nextCursor: null,
    }));
    const onCompleted = vi.fn();

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={compare}
          integrate={vi.fn()}
          onCompleted={onCompleted}
        />
      </Theme>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Finish template operation" }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });
});
