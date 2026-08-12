// @vitest-environment jsdom

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const chatContext = vi.hoisted(() => ({
  browserHandoffCaller: { id: "panel:chat", kind: "panel" },
  chat: {
    send: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    callMethod: vi.fn(async () => undefined),
    rpc: { call: vi.fn(async () => undefined) },
    contextId: "context:test",
    channelId: "channel:test",
  },
  scope: {},
  scopes: {
    save: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
  },
  scopeManager: {
    persist: vi.fn(async () => undefined),
    onChange: vi.fn(() => () => undefined),
  },
  selfId: "panel:chat",
}));

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));

import { InlineUiMessage } from "./InlineUiMessage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InlineUiMessage", () => {
  it("clears a component failure when the same stable id receives a new render revision", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function BrokenComponent(): React.ReactNode {
      throw new Error("broken renderer");
    }

    function RepairedComponent() {
      return <div>renderer recovered</div>;
    }

    const data = {
      id: "stable-card",
      source: { type: "code" as const, code: "export default function Card() {}" },
      props: { unchanged: true },
      renderedAt: "first-revision",
    };
    const view = render(<InlineUiMessage data={data} compiledComponent={BrokenComponent} />);

    await waitFor(() => expect(view.getAllByText(/broken renderer/).length).toBeGreaterThan(0));

    view.rerender(
      <InlineUiMessage
        data={{ ...data, renderedAt: "second-revision" }}
        compiledComponent={RepairedComponent}
      />
    );

    await waitFor(() => expect(view.getByText("renderer recovered")).toBeTruthy());
    expect(view.queryAllByText(/broken renderer/)).toHaveLength(0);
  });
});
