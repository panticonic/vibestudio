// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { TemplateAddClient } from "./TemplateAddButton";
import { TemplateAddButton } from "./TemplateAddButton";

describe("TemplateAddButton", () => {
  it("starts one install transaction without a separate preparation call", async () => {
    const add = vi.fn(async () => ({
      operationId: "add-github",
      state: "applied" as const,
      affectedParts: ["extensions/github"],
    }));
    const onCompleted = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <TemplateAddButton
          client={{ add } satisfies TemplateAddClient}
          request={{ catalogId: "github", refreshCatalog: true }}
          triggerLabel="Add GitHub"
          onCompleted={onCompleted}
        />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Add GitHub" }));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledWith({
      commandId: expect.any(String),
      source: { catalogId: "github", refreshCatalog: true },
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("keeps a failed install retryable", async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce({
        operationId: "add-news",
        state: "applied" as const,
        affectedParts: ["panels/news"],
      });
    const view = render(
      <Theme>
        <TemplateAddButton
          client={{ add } satisfies TemplateAddClient}
          request={{ catalogId: "news" }}
          triggerLabel="Add News"
        />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Add News" }));
    expect((await view.findByRole("alert")).textContent).toContain("registry unavailable");

    fireEvent.click(view.getByRole("button", { name: "Add News" }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls[1]?.[0].commandId).toBe(add.mock.calls[0]?.[0].commandId);
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });
});
