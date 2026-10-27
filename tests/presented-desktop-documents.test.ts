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
  reviewMode = "approval";
  reviewTitle = "Start this workspace?";
  reviewSummary = "Vibestudio needs to run 1 program on this computer";
  reviewHtml = '<article class="approval">checked source</article>';
  endpointId = "a".repeat(64);
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
        querySelector: (selector: string) => {
          if (
            this.surface === "bootstrap" &&
            this.reviewMode === "approval" &&
            selector.includes('main[data-bootstrap-mode="approval"]')
          )
            return {
              outerHTML: JSON.stringify({
                html: this.reviewHtml,
                title: this.reviewTitle,
                summary: this.reviewSummary,
                action: this.button.textContent,
                disabled: this.button.disabled,
              }),
              querySelector: (inner: string) => {
                if (inner === "#launch-gate-title") return { textContent: this.reviewTitle };
                if (inner === "#launch-gate-summary") return { textContent: this.reviewSummary };
                if (inner === "button.primary") return this.button;
                return null;
              },
            };
          return this.surface === "shell" && selector.includes("data-shell-top-chrome") ? {} : null;
        },
        querySelectorAll: (selector: string) => {
          if (selector === "button") return [this.button];
          if (
            this.surface === "pairing" &&
            this.reviewMode === "connection" &&
            selector.includes('main[data-bootstrap-mode="connection"]')
          )
            return [
              {
                outerHTML: this.reviewHtml,
                querySelector: (inner: string) => {
                  if (inner === ".title") return { textContent: this.reviewTitle };
                  if (inner === "code")
                    return { textContent: this.endpointId.match(/.{1,2}/g)?.join(":") };
                  if (inner === "button.primary") return this.button;
                  return null;
                },
              },
            ];
          return [];
        },
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
  const bootstrap = new Contents(1, "file:///owned/index.html", new Button("Start"), "bootstrap");
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

it.each([
  ["Start this workspace?", "Start"],
  ["Review code before starting", "Start workspace"],
  ["Create your workspace", "Create and launch"],
])(
  "accepts native launch review structure independently of presentation copy: %s",
  async (title, action) => {
    const bootstrap = new Contents(1, "file:///owned/index.html", new Button(action), "bootstrap");
    bootstrap.reviewTitle = title;
    const runtime = electron([window(bootstrap)]);
    const serialized = runInNewContext(`(${inspectPresentedDesktopDocuments.toString()})`);
    const [snapshot] = await serialized(runtime, { kind: "snapshots" });
    expect(snapshot.launchGateReview.actionable).toBe(true);
    expect(
      await serialized(runtime, {
        kind: "start-launch-gate",
        id: snapshot.id,
        url: snapshot.url,
        html: snapshot.launchGateReview.html,
      })
    ).toBe(true);
    expect(bootstrap.button.clicks).toBe(1);
  }
);

it.each(["reviewTitle", "reviewSummary"] as const)(
  "rejects native launch review with empty %s",
  async (field) => {
    const bootstrap = new Contents(
      1,
      "file:///owned/index.html",
      new Button("Start workspace"),
      "bootstrap"
    );
    bootstrap[field] = "  ";
    const snapshots = await inspectPresentedDesktopDocuments(electron([window(bootstrap)]), {
      kind: "snapshots",
    });
    if (!Array.isArray(snapshots)) throw new Error("Expected presented desktop snapshots");
    expect(snapshots[0].launchGateReview).toBeNull();
  }
);

it("starts only the same presented review card through the serialized current DOM action", async () => {
  const bootstrap = new Contents(1, "file:///owned/index.html", new Button("Start"), "bootstrap");
  const panel = new Contents(2, "https://panel.invalid", new Button("Start"));
  const runtime = electron([window(undefined, [view(panel)]), window(bootstrap)]);
  const serialized = runInNewContext(`(${inspectPresentedDesktopDocuments.toString()})`);
  const snapshots = await serialized(runtime, { kind: "snapshots" });
  const review = snapshots.find((item: { id: number }) => item.id === bootstrap.id);
  expect(review.launchGateReview.actionable).toBe(true);
  expect(
    await serialized(runtime, {
      kind: "start-launch-gate",
      id: review.id,
      url: review.url,
      html: review.launchGateReview.html,
    })
  ).toBe(true);
  expect(bootstrap.button.clicks).toBe(1);
  expect(panel.button.clicks).toBe(0);
  expect(bootstrap.listenerCount("did-start-navigation")).toBe(0);
});

it("distinguishes an actionable review, its in-flight decision, and bootstrap without review", async () => {
  const bootstrap = new Contents(1, "file:///owned/index.html", new Button("Start"), "bootstrap");
  const runtime = electron([window(bootstrap)]);
  const snapshot = async () => {
    const snapshots = await inspectPresentedDesktopDocuments(runtime, { kind: "snapshots" });
    if (!Array.isArray(snapshots)) throw new Error("Expected presented desktop snapshots");
    return snapshots[0];
  };
  expect((await snapshot()).launchGateReview?.actionable).toBe(true);
  bootstrap.button.disabled = true;
  Object.defineProperty(bootstrap.button, "textContent", { value: "Starting..." });
  expect((await snapshot()).hasLaunchGateApproval).toBe(true);
  expect((await snapshot()).launchGateReview?.actionable).toBe(false);
  bootstrap.reviewMode = "connection";
  expect((await snapshot()).hasLaunchGateApproval).toBe(false);
});

it.each([
  "matching invite",
  "other endpoint",
  "changed card",
  "changed URL",
  "disabled",
  "approval mode",
  "wrong title",
])("pairs only the owned current server confirmation: %s", async (change) => {
  const pairing = new Contents(
    1,
    "file:///owned/index.html",
    new Button("Trust and connect"),
    "pairing"
  );
  pairing.reviewMode = "connection";
  pairing.reviewTitle = "Connect to this server?";
  const panel = new Contents(2, "https://panel.invalid", new Button("Trust and connect"));
  const runtime = electron([window(pairing), window(undefined, [view(panel)])]);
  const serialized = runInNewContext(`(${inspectPresentedDesktopDocuments.toString()})`);
  const snapshot = (await serialized(runtime, { kind: "snapshots" }))[0];
  expect(snapshot.hasLaunchGateApproval).toBe(false);
  expect(snapshot.pairingReview.endpointId).toBe(pairing.endpointId);
  const request = {
    kind: "confirm-pairing",
    id: pairing.id,
    url: pairing.url,
    html: snapshot.pairingReview.html,
    endpointId: pairing.endpointId,
  };
  if (change === "other endpoint") request.endpointId = "b".repeat(64);
  if (change === "changed card") pairing.reviewHtml = "changed server";
  if (change === "changed URL") pairing.url = "file:///other/index.html";
  if (change === "disabled") pairing.button.disabled = true;
  if (change === "approval mode") pairing.reviewMode = "approval";
  if (change === "wrong title") pairing.reviewTitle = "Unrelated consent";
  expect(await serialized(runtime, request)).toBe(change === "matching invite");
  expect(pairing.button.clicks).toBe(change === "matching invite" ? 1 : 0);
  expect(panel.button.clicks).toBe(0);
  expect(pairing.listenerCount("did-start-navigation")).toBe(0);
});

it.each([
  "changed card",
  "changed URL",
  "disabled",
  "starting",
  "wrong title",
  "missing summary",
  "connection",
  "unpresented",
])("never falls through to another Start button for a %s review", async (change) => {
  const bootstrap = new Contents(1, "file:///owned/index.html", new Button("Start"), "bootstrap");
  const panel = new Contents(2, "https://panel.invalid", new Button("Start"));
  const bootstrapWindow = window(bootstrap);
  const runtime = electron([window(undefined, [view(panel)]), bootstrapWindow]);
  const snapshots = await inspectPresentedDesktopDocuments(runtime, { kind: "snapshots" });
  if (!Array.isArray(snapshots)) throw new Error("Expected presented desktop snapshots");
  const snapshot = snapshots.find((entry: { id: number }) => entry.id === bootstrap.id);
  if (!snapshot?.launchGateReview) throw new Error("Expected the presented native launch review");
  const request = {
    kind: "start-launch-gate",
    id: bootstrap.id,
    url: bootstrap.url,
    html: snapshot.launchGateReview.html,
  };
  if (change === "changed card") bootstrap.reviewHtml = "different source";
  if (change === "changed URL") bootstrap.url = "file:///other/index.html";
  if (change === "disabled") bootstrap.button.disabled = true;
  if (change === "starting")
    Object.defineProperty(bootstrap.button, "textContent", { value: "Starting..." });
  if (change === "wrong title") bootstrap.reviewTitle = "Unrelated approval";
  if (change === "missing summary") bootstrap.reviewSummary = "";
  if (change === "connection") bootstrap.reviewMode = "connection";
  if (change === "unpresented") bootstrapWindow.isVisible = () => false;
  expect(await inspectPresentedDesktopDocuments(runtime, request)).toBe(false);
  expect(bootstrap.button.clicks).toBe(0);
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
