// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shellClient = vi.hoisted(() => ({
  on: vi.fn(() => () => {}),
  show: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  hide: vi.fn(() => Promise.resolve()),
}));

vi.mock("./client", () => ({
  contentOverlay: { on: shellClient.on },
  view: {
    showContentOverlay: shellClient.show,
    updateContentOverlay: shellClient.update,
    hideContentOverlay: shellClient.hide,
  },
}));

import { useShellContentOverlay, type ShellContentOverlayOptions } from "./useShellContentOverlay";

const baseOptions: ShellContentOverlayOptions = {
  surface: "approval-card",
  open: true,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  props: { revision: 1 },
  theme: { appearance: "light" },
  focusRequest: "approval-1",
};

function Probe({ options }: { options: ShellContentOverlayOptions | null }) {
  useShellContentOverlay(options);
  return null;
}

describe("useShellContentOverlay", () => {
  beforeEach(() => {
    shellClient.on.mockClear();
    shellClient.show.mockClear();
    shellClient.update.mockClear();
    shellClient.hide.mockClear();
  });

  it("turns a stable focus request into one focus pulse across prop refreshes", async () => {
    const rendered = render(<Probe options={baseOptions} />);

    await waitFor(() =>
      expect(shellClient.show).toHaveBeenCalledWith(expect.objectContaining({ focus: true }))
    );

    rendered.rerender(<Probe options={{ ...baseOptions, props: { revision: 2 } }} />);
    await waitFor(() =>
      expect(shellClient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ props: { revision: 2 }, focus: false })
      )
    );

    rendered.rerender(
      <Probe
        options={{ ...baseOptions, props: { revision: 3 }, focusRequest: "approval-1:refocus" }}
      />
    );
    await waitFor(() =>
      expect(shellClient.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ props: { revision: 3 }, focus: true })
      )
    );
  });
});
