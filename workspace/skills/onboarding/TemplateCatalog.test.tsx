// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintRendererSource } from "@workspace/agentic-core";
import TemplateCatalog from "./TemplateCatalog.js";

const catalog = {
  version: 1 as const,
  revision: "2026-07-29.3",
  systemEpoch: 57,
  coordinates: {
    url: "git+https://github.com/vibestudio/template-registry.git",
    ref: "refs/heads/promoted",
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    snapshot: `v1-sha256:${"b".repeat(64)}`,
  },
  source: "verified" as const,
  stale: false,
  verifiedAt: "2026-07-29T12:00:00.000Z",
  entries: [
    {
      id: "news",
      name: "News workspace",
      description: "Read and discuss news.",
      tags: ["news"],
      recommended: true,
      url: "git+https://github.com/vibestudio/template-news.git",
      promoted: {
        ref: "refs/tags/v1",
        commit: "0123456789abcdef0123456789abcdef01234567",
        snapshot: `v1-sha256:${"a".repeat(64)}`,
      },
    },
  ],
};

describe("TemplateCatalog", () => {
  it("uses renderer-safe imports", () => {
    expect(lintRendererSource(readFileSync(resolve(__dirname, "TemplateCatalog.tsx"), "utf8"))).toEqual([]);
  });

  it("renders the public catalog and sends typed URL interactions", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <TemplateCatalog props={{ catalog }} chat={{ send }} />
      </Theme>
    );
    expect(view.getByText("News workspace template")).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: "Add" })[0]!);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Add the News workspace template", {
        metadata: {
          interaction: {
            source: "onboarding-template-catalog",
            kind: "template-add",
            targetId: "news",
            catalogId: "news",
            registryCommit: "fedcba9876543210fedcba9876543210fedcba98",
            registrySnapshot: `v1-sha256:${"b".repeat(64)}`,
          },
        },
      })
    );

    fireEvent.change(view.getByLabelText("Template address"), {
      target: { value: "https://example.test/team/template.git" },
    });
    fireEvent.click(view.getAllByRole("button", { name: "Add" }).at(-1)!);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Add a template from this address", {
        metadata: {
          interaction: {
            source: "onboarding-template-catalog",
            kind: "template-add",
            targetId: "url",
            url: "https://example.test/team/template.git",
          },
        },
      })
    );
  });
});
