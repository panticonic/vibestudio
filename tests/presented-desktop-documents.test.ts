import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { inspectPresentedDesktopDocuments } from "../scripts/lib/presented-desktop-documents.mjs";

class Button {
  disabled = false;
  clicks = 0;
  constructor(readonly textContent: string) {}
  getClientRects() {
    return [{}];
  }
  closest() {
    return null;
  }
  getAttribute() {
    return null;
  }
  click() {
    this.clicks++;
  }
}

class Contents extends EventEmitter {
  destroyed = false;
  loading = false;
  reads = 0;
  fail: (() => never) | undefined;
  constructor(
    readonly id: number,
    public url: string,
    readonly button = new Button("Use once"),
    readonly surface = "panel"
  ) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isLoadingMainFrame() {
    return this.loading;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.surface;
  }
  async executeJavaScript(script: string) {
    this.reads++;
    if (!this.url) return new Promise(() => {});
    this.fail?.();
    return runInNewContext(script, {
      HTMLButtonElement: Button,
      document: {
        body: { innerText: this.surface },
        querySelector: (selector: string) =>
          (this.surface === "bootstrap" && selector.includes("data-bootstrap-launch-gate")) ||
          (this.surface === "shell" && selector.includes("data-shell-top-chrome"))
            ? {}
            : null,
        querySelectorAll: () => [this.button],
      },
    });
  }
}

interface PresentedView {
  webContents: Contents | undefined;
  children: PresentedView[];
  getVisible(): boolean;
  getBounds(): { width: number; height: number };
}

function view(
  contents?: Contents,
  visible = true,
  width = 100,
  children: PresentedView[] = []
): PresentedView {
  return {
    webContents: contents,
    children,
    getVisible: () => visible,
    getBounds: () => ({ width, height: 100 }),
  };
}

function window(contents?: Contents, children: PresentedView[] = [], visible = true) {
  return {
    webContents: contents,
    contentView: { children },
    isDestroyed: () => false,
    isVisible: () => visible,
  };
}

function electron(windows: ReturnType<typeof window>[]) {
  return {
    BaseWindow: { getAllWindows: () => windows },
    BrowserWindow: { getAllWindows: () => windows.filter((item) => item.webContents) },
  };
}

it("never executes the blank window or hidden/prewarmed/unattached documents while clicking the presented overlay", async () => {
  const blank = new Contents(6, "");
  const hidden = new Contents(4, "https://hidden.invalid");
  const zero = new Contents(3, "https://prewarmed.invalid");
  const hiddenChild = new Contents(8, "https://hidden-child.invalid");
  const overlay = new Contents(7, "https://overlay.invalid");
  const windows = [
    window(blank),
    window(undefined, [
      view(hidden, false),
      view(zero, true, 0),
      view(undefined, false, 100, [view(hiddenChild)]),
      view(overlay),
    ]),
  ];
  expect(
    await inspectPresentedDesktopDocuments(electron(windows), {
      kind: "click",
      labelSource: "^Use once$",
    })
  ).toBe(true);
  expect([blank.reads, hidden.reads, zero.reads, hiddenChild.reads]).toEqual([0, 0, 0, 0]);
  expect(overlay.button.clicks).toBe(1);
  expect(overlay.listenerCount("did-start-navigation")).toBe(0);
});

it("includes real bootstrap BrowserWindow, shell, panel, and nested overlay exactly once in serializable snapshots", async () => {
  const bootstrap = new Contents(1, "data:text/html,bootstrap", new Button("Deny"), "bootstrap");
  const shell = new Contents(2, "https://shell.invalid", new Button("Menu"), "shell");
  const panel = new Contents(5, "https://panel.invalid");
  const overlay = new Contents(7, "https://overlay.invalid");
  const windows = [
    window(bootstrap),
    window(undefined, [view(shell), view(panel), view(undefined, true, 100, [view(overlay)])]),
  ];
  // Playwright serializes the callback without this module's lexical scope.
  const serialized = runInNewContext(`(${inspectPresentedDesktopDocuments.toString()})`);
  const result = await serialized(electron(windows), { kind: "snapshots" });
  expect(result.map((item: { id: number }) => item.id)).toEqual([1, 2, 5, 7]);
  expect(result[0].hasLaunchGateApproval).toBe(true);
  expect(result[1].hasHostedShellChrome).toBe(true);
  expect([bootstrap.reads, shell.reads, panel.reads, overlay.reads]).toEqual([1, 1, 1, 1]);
});

it("preserves bootstrap review priority and does not click the covered panel first", async () => {
  const panel = new Contents(5, "https://panel.invalid", new Button("Add to workspace"));
  const bootstrap = new Contents(
    1,
    "data:text/html,bootstrap",
    new Button("Add to workspace"),
    "bootstrap"
  );
  expect(
    await inspectPresentedDesktopDocuments(
      electron([window(undefined, [view(panel)]), window(bootstrap)]),
      { kind: "click", labelSource: "^Add to workspace$" }
    )
  ).toBe(true);
  expect(bootstrap.button.clicks).toBe(1);
  expect(panel.button.clicks).toBe(0);
});

it("propagates the original failure from a still-presented document and removes the observation listener", async () => {
  const contents = new Contents(7, "https://overlay.invalid");
  const original = new Error("Actual presented renderer failed");
  contents.fail = () => {
    throw original;
  };
  await expect(
    inspectPresentedDesktopDocuments(electron([window(undefined, [view(contents)])]), {
      kind: "click",
      labelSource: "Use once",
    })
  ).rejects.toBe(original);
  expect(contents.listenerCount("did-start-navigation")).toBe(0);
});

it("invalidates only actual destruction or main-document navigation, including a same-URL reload", async () => {
  const destroyed = new Contents(3, "https://destroyed.invalid");
  const navigated = new Contents(4, "https://reload.invalid");
  const live = new Contents(7, "https://overlay.invalid");
  destroyed.fail = () => {
    destroyed.destroyed = true;
    throw new Error("Destroyed document");
  };
  navigated.fail = () => {
    navigated.emit("did-start-navigation", {}, navigated.url, false, true);
    throw new Error("Navigation replaced context");
  };
  const windows = [window(undefined, [view(destroyed), view(navigated), view(live)])];
  expect(
    await inspectPresentedDesktopDocuments(electron(windows), {
      kind: "click",
      labelSource: "Use once",
    })
  ).toBe(true);
  expect(live.button.clicks).toBe(1);
  expect([
    destroyed.listenerCount("did-start-navigation"),
    navigated.listenerCount("did-start-navigation"),
  ]).toEqual([0, 0]);
});
