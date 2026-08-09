// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { TemplateAddPreparation } from "@vibestudio/service-schemas/templates";
import type { TemplateAddClient } from "./TemplateAddDialog";
import { TemplateAddDialog } from "./TemplateAddDialog";

function preparation(name: string, marker: string): TemplateAddPreparation {
  return {
    name,
    inspection: {
      pin: {
        url: `git+https://example.test/${name.toLowerCase()}.git`,
        ref: "refs/tags/v1",
        commit: marker.repeat(40),
        snapshot: `v1-sha256:${marker.repeat(64)}`,
      },
      fingerprint: `v1-sha256:${marker.repeat(64)}`,
      roots: [],
      templates: [],
      affectedParts: [`extensions/${name.toLowerCase()}`],
      excludedSuggestions: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TemplateAddDialog", () => {
  it("prepares immediately, shows concrete parts, and waits for explicit add", async () => {
    const prepareAdd = vi.fn(
      async (): Promise<TemplateAddPreparation> => ({
        name: "GitHub",
        description: "Repository and API integration",
        inspection: {
          pin: {
            url: "git+https://example.test/github.git",
            ref: "refs/tags/v1",
            commit: "1".repeat(40),
            snapshot: `v1-sha256:${"a".repeat(64)}`,
          },
          fingerprint: `v1-sha256:${"b".repeat(64)}`,
          roots: [],
          templates: [],
          affectedParts: ["extensions/github", "skills/github"],
          excludedSuggestions: [],
        },
      })
    );
    const add = vi.fn(async () => ({
      operationId: "add-github",
      state: "applied" as const,
      affectedParts: ["extensions/github", "skills/github"],
    }));
    const client = { prepareAdd, add } satisfies TemplateAddClient;
    const view = render(
      <Theme>
        <TemplateAddDialog
          client={client}
          request={{ catalogId: "github", refreshCatalog: true }}
          triggerLabel="Add GitHub"
        />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Add GitHub" }));
    expect(view.getByText("Fetching and verifying the template…")).toBeTruthy();
    expect(await view.findByText("extensions/github, skills/github")).toBeTruthy();
    expect(prepareAdd).toHaveBeenCalledWith({ catalogId: "github", refreshCatalog: true });
    expect(add).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Add template" }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(view.getByText("The template is connected.")).toBeTruthy();
  });

  it("ignores a preparation that finishes after the dialog is reused for another address", async () => {
    const first = deferred<ReturnType<typeof preparation>>();
    const second = deferred<ReturnType<typeof preparation>>();
    const prepareAdd = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const add = vi.fn(async () => ({
      operationId: "add-second",
      state: "applied" as const,
      affectedParts: ["extensions/second"],
    }));
    const client = { prepareAdd, add } satisfies TemplateAddClient;
    const view = render(
      <Theme>
        <TemplateAddDialog
          client={client}
          request={{ url: "https://example.test/first.git" }}
          triggerLabel="Add address"
        />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Add address" }));
    fireEvent.click(view.getByRole("button", { name: "Not now" }));
    view.rerender(
      <Theme>
        <TemplateAddDialog
          client={client}
          request={{ url: "https://example.test/second.git" }}
          triggerLabel="Add address"
        />
      </Theme>
    );
    fireEvent.click(view.getByRole("button", { name: "Add address" }));

    await act(async () => second.resolve(preparation("Second", "2")));
    expect(await view.findByText("extensions/second")).toBeTruthy();
    await act(async () => first.resolve(preparation("First", "1")));
    expect(view.queryByText("extensions/first")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Add template" }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ pin: preparation("Second", "2").inspection.pin })
      )
    );
  });

  it("keeps a successful operation truthful when completion refresh fails", async () => {
    const client = {
      prepareAdd: vi.fn(async () => preparation("GitHub", "1")),
      add: vi.fn(async () => ({
        operationId: "add-github",
        state: "applied" as const,
        affectedParts: ["extensions/github"],
      })),
    } satisfies TemplateAddClient;
    const view = render(
      <Theme>
        <TemplateAddDialog
          client={client}
          request={{ catalogId: "github" }}
          triggerLabel="Add GitHub"
          onCompleted={async () => {
            throw new Error("refresh unavailable");
          }}
        />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Add GitHub" }));
    await view.findByText("extensions/github");
    fireEvent.click(view.getByRole("button", { name: "Add template" }));

    expect(await view.findByText("The template is connected.")).toBeTruthy();
    expect(
      view.getByText(
        "The template operation succeeded, but this view couldn't refresh. refresh unavailable"
      )
    ).toBeTruthy();
    expect(view.queryByText(/Nothing was changed/)).toBeNull();
  });
});
