import { expect, test } from "@playwright/test";
import { launchTestApp, createPanel } from "../../setup/electronSetup";
import { waitHostedShellReady } from "../support/commandOverlay";
import { inspectPresentedDesktopDocuments } from "../../../scripts/lib/presented-desktop-documents.mjs";

test("collapsed workspace rail keeps controls and descendants available", async () => {
  test.setTimeout(300_000);
  const owner = await launchTestApp({ launchTimeout: 240_000 });
  try {
    await waitHostedShellReady(owner);
    let shellId = 0;
    await expect
      .poll(async () => {
        const documents = await owner.app.evaluate(inspectPresentedDesktopDocuments, {
          kind: "documents",
        });
        if (!Array.isArray(documents)) throw new Error("Expected presented native documents");
        return owner.app
          .evaluate(async ({ webContents }, documents) => {
            for (const document of documents) {
              if (
                !document.url.startsWith("vs-client:") ||
                document.url.includes("overlaySurface=")
              )
                continue;
              const contents = webContents.fromId(document.id);
              if (!contents || contents.isDestroyed()) continue;
              const ready = await contents.executeJavaScript(
                `(() => {
            const reports = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Keep automatic reports off');
            if (reports) { reports.click(); return false; }
            return Boolean(document.querySelector('[role="toolbar"][aria-label="App controls"]'));
          })()`,
                true
              );
              if (ready) return document.id;
            }
            return 0;
          }, documents)
          .then((id) => {
            shellId = id;
            return id > 0;
          });
      })
      .toBe(true);
    // The shell is a native WebContentsView, which Electron's BrowserWindow
    // Page list does not reliably expose. Address its actual presented document.
    const read = async <Input, Result>(
      fn: (input: Input) => Result,
      input: Input
    ): Promise<Result> =>
      owner.app.evaluate(
        async ({ webContents }, request) => {
          const contents = webContents.fromId(request.id);
          if (!contents || contents.isDestroyed())
            throw new Error("The native shell was destroyed");
          return contents.executeJavaScript(
            `(${request.source})(${JSON.stringify(request.input)})`,
            true
          );
        },
        { id: shellId, source: fn.toString(), input }
      );
    const parentId = await read(
      () => document.querySelector<HTMLElement>('[data-panel-tree-row="true"]')?.dataset["panelId"],
      null
    );
    expect(parentId).toBeTruthy();
    const child = await test.step("Create the nested panel fixture", () =>
      createPanel(owner, parentId!, "about/new", { focus: false }));
    await expect
      .poll(() =>
        read(
          (id) =>
            document
              .querySelector(`[data-panel-tree-row][data-panel-id="${id}"]`)
              ?.getAttribute("aria-expanded"),
          parentId
        )
      )
      .toMatch(/true|false/);
    await read((id) => {
      const row = document.querySelector(`[data-panel-tree-row][data-panel-id="${id}"]`);
      row?.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')?.click();
    }, parentId);
    await expect
      .poll(() =>
        read(
          (id) => Boolean(document.querySelector(`[data-panel-tree-row][data-panel-id="${id}"]`)),
          child.id
        )
      )
      .toBe(false);
    await read(
      () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')?.click(),
      null
    );
    await expect
      .poll(() =>
        read(() => {
          const nav = document.querySelector('[aria-label="Workspace navigation"]');
          return nav?.getAttribute("data-collapsed");
        }, null)
      )
      .toBe("true");
    const controls = await read(() => {
      const nav = document.querySelector('[aria-label="Workspace navigation"]');
      return ["App menu", "Expand sidebar", "New panel", "Open Personal", "Open System"].every(
        (label) => {
          const button = nav?.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
          return button && button.getClientRects().length > 0;
        }
      );
    }, null);
    expect(controls).toBe(true);
    await expect
      .poll(() =>
        read((id) => {
          const icon = document.querySelector<HTMLElement>(
            `.panel-tree-rail-item[data-panel-id="${id}"]`
          );
          return Boolean(icon?.getClientRects().length);
        }, child.id)
      )
      .toBe(true);
    await read(
      (id) =>
        document
          .querySelector<HTMLButtonElement>(`.panel-tree-rail-item[data-panel-id="${id}"]`)
          ?.click(),
      child.id
    );
    await expect
      .poll(() =>
        read(
          (id) =>
            document
              .querySelector(`.panel-tree-rail-item[data-panel-id="${id}"]`)
              ?.getAttribute("aria-selected"),
          child.id
        )
      )
      .toBe("true");
    const png = await owner.app.evaluate(async ({ webContents }, id) => {
      const image = await webContents.fromId(id)!.capturePage();
      return image.toPNG().toString("base64");
    }, shellId);
    await test
      .info()
      .attach("workspace-control-rail.png", {
        body: Buffer.from(png, "base64"),
        contentType: "image/png",
      });
    await read(
      () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]')?.click(),
      null
    );
    await expect
      .poll(() =>
        read(
          () =>
            Boolean(document.querySelector('[aria-label="Find panels"]')?.getClientRects().length),
          null
        )
      )
      .toBe(true);
  } finally {
    await owner.cleanup();
  }
});
