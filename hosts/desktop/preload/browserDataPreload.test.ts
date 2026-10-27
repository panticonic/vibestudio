// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { BrowserCookieProjectionDiagnostics } from "../main/services/browserPrivacyProtocol.js";

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  invoke: vi.fn(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipc.listeners.set(channel, listener),
    invoke: ipc.invoke,
    send: ipc.send,
  },
}));

it("embeds task sections, keeps edits on geometry updates, and offers recovery only while synchronization failed", async () => {
  const html = readFileSync(path.resolve(__dirname, "../main/browserData.html"), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const snapshot = {
    passwords: [{ id: 1, origin_url: "https://example.com", username: "alice" }],
    neverSave: ["https://excluded.example"],
    formFill: [{ id: 2, fieldName: "email", type: "email", value: "saved@example.com" }],
    cookieOrigins: { revision: 4, origins: ["https://example.com"] },
  };
  const diagnostics: BrowserCookieProjectionDiagnostics = {
    revision: 4,
    hostId: "host",
    converged: false,
    mismatchCount: 0,
    outboxDepth: 1,
  };
  ipc.invoke.mockImplementation(async (_channel: string, request: { action: string }) => ({
    ok: true,
    value:
      request.action === "snapshot"
        ? snapshot
        : request.action === "diagnostics"
          ? diagnostics
          : null,
  }));
  await import("./browserDataPreload.js");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  expect(ipc.send).toHaveBeenCalledWith("vibestudio:browser-data:ready");
  const present = (section: string) =>
    ipc.listeners.get("vibestudio:browser-data:present")!(
      {},
      { section, workspaceName: "Personal", dark: true }
    );
  const changed = () => ipc.listeners.get("vibestudio:browser-data:changed")!({});
  const text = () => document.body.textContent!;
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((value) => value.textContent === label);

  present("passwords");
  await vi.waitFor(() => expect(text()).toContain("alice"));
  expect(text()).toContain("Browser data in Personal");
  expect(button("Export passwords…")).toBeDefined();
  expect(button("Apply saved cookies")).toBeUndefined();
  expect(document.querySelector("nav")).toBeNull();

  present("autofill");
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Email"]')?.value).toBe(
      "saved@example.com"
    )
  );
  const editing = document.querySelector<HTMLInputElement>('input[aria-label="Email"]')!;
  editing.value = "unsaved@example.com";
  present("autofill");
  changed();
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Email"]')?.value).toBe(
    "unsaved@example.com"
  );

  present("siteData");
  await vi.waitFor(() => expect(text()).toContain("Synchronizing"));
  expect(button("Retry synchronization")).toBeUndefined();
  const clearSite = (origin: string) =>
    [...document.querySelectorAll<HTMLElement>(".row")]
      .find((row) => row.querySelector(".row-label")?.textContent === origin)
      ?.querySelector<HTMLButtonElement>("button");
  const exportFormat = () =>
    document.querySelector<HTMLSelectElement>('select[aria-label="Cookie export format"]')!;
  exportFormat().value = "netscape-txt";
  const selectedSite = clearSite("https://example.com")!;
  selectedSite.focus();
  expect(document.activeElement).toBe(selectedSite);
  snapshot.cookieOrigins.origins = ["https://new.example", "https://example.com"];
  changed();
  await vi.waitFor(() => expect(clearSite("https://example.com")).not.toBe(selectedSite));
  expect(document.activeElement).toBe(clearSite("https://example.com"));
  expect(document.activeElement).not.toBe(clearSite("https://new.example"));
  expect(exportFormat().value).toBe("netscape-txt");
  // The selected site disappears and another row occupies its previous index.
  snapshot.cookieOrigins.origins = ["https://new.example", "https://different.example"];
  changed();
  await vi.waitFor(() => expect(clearSite("https://different.example")).toBeDefined());
  expect(document.activeElement).toBe(document.querySelector("details summary"));
  expect(document.activeElement).not.toBe(clearSite("https://different.example"));
  expect(exportFormat().value).toBe("netscape-txt");

  // Capture keyboard state when the reply commits, so interaction while a read
  // is pending wins over the state that existed when that read began.
  let replied!: (value: unknown) => void;
  ipc.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        replied = resolve;
      })
  );
  changed();
  exportFormat().value = "json";
  const focusedDuringRead = clearSite("https://new.example")!;
  focusedDuringRead.focus();
  replied({ ok: true, value: snapshot });
  await vi.waitFor(() => expect(clearSite("https://new.example")).not.toBe(focusedDuringRead));
  expect(document.activeElement).toBe(clearSite("https://new.example"));
  expect(exportFormat().value).toBe("json");

  diagnostics.lastError = "Vault unavailable";
  changed();
  await vi.waitFor(() => expect(button("Retry synchronization")).toBeDefined());
  expect(text()).toContain("Vault unavailable");
  diagnostics.converged = true;
  diagnostics.outboxDepth = 0;
  delete diagnostics.lastError;
  changed();
  await vi.waitFor(() => expect(text()).toContain("Up to date"));
  expect(button("Retry synchronization")).toBeUndefined();
  expect(document.querySelector("details summary")?.textContent).toBe("Synchronization details");

  let vaultUnavailable = true;
  let vaultFailed!: () => void;
  diagnostics.converged = false;
  diagnostics.lastError = "Browser cookie storage could not be attached";
  ipc.invoke.mockImplementation(async (_channel: string, request: { action: string }) => {
    if (request.action === "snapshot")
      return vaultUnavailable
        ? new Promise((resolve) => {
            vaultFailed = () =>
              resolve({ ok: false, error: "The saved browser data is unavailable" });
          })
        : { ok: true, value: snapshot };
    if (request.action === "diagnostics") return { ok: true, value: diagnostics };
    if (request.action === "applyCookies") {
      vaultUnavailable = false;
      diagnostics.converged = true;
      delete diagnostics.lastError;
      return { ok: true, value: { revision: 4 } };
    }
    return { ok: true, value: null };
  });
  changed();
  await vi.waitFor(() => expect(button("Retry synchronization")).toBeDefined());
  expect(text()).toContain("Loading saved site data…");
  vaultFailed();
  await vi.waitFor(() => expect(text()).toContain("Saved site data could not be loaded"));
  expect(text()).toContain("Browser cookie storage could not be attached");
  expect(button("Retry synchronization")).toBeDefined();
  expect(button("Clear cookies for all sites…")).toBeUndefined();
  expect(text()).not.toContain("No site cookies saved yet.");
  button("Retry synchronization")!.click();
  await vi.waitFor(() => expect(text()).toContain("Up to date"));
  expect(clearSite("https://new.example")).toBeDefined();
  expect(button("Retry synchronization")).toBeUndefined();
  expect(text()).not.toContain("Saved site data could not be loaded");
  expect(ipc.invoke).toHaveBeenCalledWith("vibestudio:browser-data:call", {
    action: "applyCookies",
  });

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(ipc.send).toHaveBeenCalledWith("vibestudio:browser-data:close");
  expect(
    ipc.invoke.mock.calls.every(([channel]) => channel === "vibestudio:browser-data:call")
  ).toBe(true);
  vi.unstubAllGlobals();
});
