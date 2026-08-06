// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { TemplateReviewPanel } from "./templateReview.js";

const target = { kind: "event", eventId: "event:workspace" } as const;
const item = { repoPath: "panels/news", deltaId: "delta:news" };

describe("TemplateReviewPanel", () => {
  it("records an ordinary VCS merge decision instead of discarding the comparison", async () => {
    const compare = vi
      .fn()
      .mockResolvedValueOnce({
        target,
        source: { kind: "external-delta", deltaId: item.deltaId },
        base: target,
        resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
        counts: { adopt: 1, convergent: 0, composed: 0, conflict: 0, resolved: 0 },
        intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 1 },
        coordinates: [
          {
            coordinate: { kind: "file", id: "file:news", paths: { theirs: "panels/news/index.ts" } },
            status: "adopt",
            aspects: [{ aspect: "presence", base: "absent", ours: "absent", theirs: "present", status: "adopt" }],
            attribution: { ours: [], theirs: [{ changeId: "change:news", workUnitId: "work:news" }] },
            resolutions: ["theirs", "ours", "current"],
            summary: "Add the News panel",
          },
        ],
        intents: [],
        intentsTruncated: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        target,
        source: { kind: "external-delta", deltaId: item.deltaId },
        base: target,
        resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
        counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
        intentCounts: { merged: 1, settled: 0, split: 0, contested: 0, pending: 0 },
        coordinates: [], intents: [], intentsTruncated: false,
        nextCursor: null,
      });
    const merge = vi.fn(async () => undefined);
    const onCompleted = vi.fn();

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={compare}
          merge={merge}
          onCompleted={onCompleted}
        />
      </Theme>
    );

    const useChange = await screen.findByRole("button", { name: "Use source result" });
    fireEvent.click(useChange);

    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith({
        item,
        expectedWorkingHead: target,
        coordinates: [{ kind: "file", id: "file:news" }],
        resolutions: [
          { coordinate: { kind: "file", id: "file:news" }, resolution: "theirs" },
        ],
      })
    );
    const finish = await screen.findByRole("button", { name: "Finish template operation" });
    expect(onCompleted).not.toHaveBeenCalled();
    fireEvent.click(finish);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("accepts a composed result and includes its complete structural group", async () => {
    const comparison = {
      target,
      source: { kind: "external-delta" as const, deltaId: item.deltaId },
      base: target,
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: { adopt: 1, convergent: 0, composed: 1, conflict: 0, resolved: 0 },
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 2 },
      coordinates: [
        {
          coordinate: {
            kind: "repository" as const,
            id: "repository:news",
            paths: { theirs: "panels/news" },
          },
          status: "adopt" as const,
          aspects: [
            {
              aspect: "presence" as const,
              base: "absent",
              ours: "absent",
              theirs: "present",
              status: "adopt" as const,
            },
          ],
          attribution: { ours: [], theirs: [] },
          group: "group:news",
          resolutions: ["theirs" as const, "ours" as const, "current" as const],
          summary: "Add the News repository",
        },
        {
          coordinate: {
            kind: "file" as const,
            id: "file:news",
            paths: { ours: "index.ts", theirs: "index.ts" },
          },
          status: "composed" as const,
          aspects: [
            {
              aspect: "content" as const,
              base: {},
              ours: {},
              theirs: {},
              status: "composed" as const,
            },
          ],
          attribution: { ours: [], theirs: [] },
          group: "group:news",
          resolutions: [
            "composed" as const,
            "theirs" as const,
            "ours" as const,
            "current" as const,
          ],
          summary: "Combine the News entry point",
        },
      ],
      intents: [],
      intentsTruncated: false,
      nextCursor: null,
    };
    const merge = vi.fn(async () => undefined);

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={vi.fn(async () => comparison)}
          merge={merge}
        />
      </Theme>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use combined result" }));
    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith({
        item,
        expectedWorkingHead: target,
        coordinates: [
          { kind: "repository", id: "repository:news" },
          { kind: "file", id: "file:news" },
        ],
        resolutions: [
          {
            coordinate: { kind: "repository", id: "repository:news" },
            resolution: "theirs",
          },
          { coordinate: { kind: "file", id: "file:news" }, resolution: "composed" },
        ],
      })
    );
  });

  it("can finish a review that was already complete when the surface reopened", async () => {
    const compare = vi.fn(async () => ({
      target,
      source: { kind: "external-delta" as const, deltaId: item.deltaId },
      base: target,
      resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
      counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
      intentCounts: { merged: 1, settled: 0, split: 0, contested: 0, pending: 0 },
      coordinates: [], intents: [], intentsTruncated: false,
      nextCursor: null,
    }));
    const onCompleted = vi.fn();

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={compare}
          merge={vi.fn()}
          onCompleted={onCompleted}
        />
      </Theme>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Finish template operation" }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("renders coordinates from every comparison page", async () => {
    const base = {
      target,
      source: { kind: "external-delta" as const, deltaId: item.deltaId },
      base: target,
      resolution: { complete: false, remainingCoordinateCount: 2, concluded: false },
      counts: { adopt: 2, convergent: 0, composed: 0, conflict: 0, resolved: 0 },
      intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 2 },
      intents: [],
      intentsTruncated: false,
    };
    const coordinate = (id: string, summary: string) => ({
      coordinate: { kind: "file" as const, id, paths: { theirs: `panels/news/${id}.ts` } },
      status: "adopt" as const,
      aspects: [
        {
          aspect: "presence" as const,
          base: "absent",
          ours: "absent",
          theirs: "present",
          status: "adopt" as const,
        },
      ],
      attribution: {
        ours: [],
        theirs: [{ changeId: `change:${id}`, workUnitId: `work:${id}` }],
      },
      resolutions: ["theirs" as const, "ours" as const, "current" as const],
      summary,
    });
    const compare = vi.fn(async (_item: typeof item, cursor?: string) => ({
      ...base,
      coordinates: [
        cursor
          ? coordinate("second", "Second-page template change")
          : coordinate("first", "First-page template change"),
      ],
      nextCursor: cursor ? null : "page:2",
    }));

    render(
      <Theme>
        <TemplateReviewPanel
          review={{ contextId: "ctx:templates", items: [item] }}
          compare={compare}
          merge={vi.fn()}
        />
      </Theme>
    );

    expect(await screen.findByText("First-page template change")).toBeTruthy();
    expect(await screen.findByText("Second-page template change")).toBeTruthy();
    expect(compare).toHaveBeenNthCalledWith(2, item, "page:2");
  });
});
