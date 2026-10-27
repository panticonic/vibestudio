import { ipcRenderer } from "electron";
import {
  BrowserPrivacyResultSchema,
  BrowserPrivacySnapshotSchema,
  BrowserCookieProjectionDiagnosticsSchema,
  BrowserPrivacySectionSchema,
  type BrowserPrivacyRequest,
  type BrowserPrivacySection,
  type BrowserPrivacySnapshot,
  type BrowserCookieProjectionDiagnostics,
} from "../main/services/browserPrivacyProtocol.js";
import {
  addFormFillConfirmation,
  autofillFieldLabel,
  browserSessionStatus,
  createAddFormFillRequest,
  formFillCreatePresentation,
} from "../main/services/browserDataPresentation.js";

type Presentation = {
  section: BrowserPrivacySection;
  workspaceName?: string;
  dark?: boolean;
  focus?: "first" | "last";
};
let presentation: Presentation | null = null;
let present: ((value: Presentation) => void) | null = null;
let refresh: (() => void) | null = null;

ipcRenderer.on("vibestudio:browser-data:present", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const section = BrowserPrivacySectionSchema.safeParse(value["section"]);
  if (!section.success) return;
  presentation = {
    section: section.data,
    ...(typeof value["workspaceName"] === "string"
      ? { workspaceName: value["workspaceName"] }
      : {}),
    ...(typeof value["dark"] === "boolean" ? { dark: value["dark"] } : {}),
    ...(value["focus"] === "first" || value["focus"] === "last" ? { focus: value["focus"] } : {}),
  };
  present?.(presentation);
});
ipcRenderer.on("vibestudio:browser-data:changed", () => refresh?.());

const call = async (request: BrowserPrivacyRequest): Promise<unknown> => {
  const result = BrowserPrivacyResultSchema.parse(
    await ipcRenderer.invoke("vibestudio:browser-data:call", request)
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

window.addEventListener("DOMContentLoaded", () => {
  let section: BrowserPrivacySection | null = null;
  let generation = 0;
  let busy = false;
  let pendingFocus: Presentation["focus"];
  let siteDataState: SiteDataState | null = null;
  const content = required("content");
  const status = required("status");
  const confirm = required("confirm") as HTMLDialogElement;
  const confirmMessage = required("confirm-message");
  const render = async () => {
    if (!section) return;
    const selected = section;
    const current = ++generation;
    content.setAttribute("aria-busy", "true");
    try {
      if (selected === "siteData") {
        await renderSiteData(current);
        return;
      }
      const next = sectionView(
        selected,
        BrowserPrivacySnapshotSchema.parse(await call({ action: "snapshot" })),
        action
      );
      if (generation !== current) return;
      replaceContent(next);
    } catch (error) {
      if (generation === current)
        replaceContent(message(error instanceof Error ? error.message : String(error), true));
    } finally {
      if (generation === current) {
        content.setAttribute("aria-busy", "false");
        applyFocus();
      }
    }
  };
  const action = async (
    request: BrowserPrivacyRequest,
    confirmation?: string
  ): Promise<boolean> => {
    if (busy || confirm.open) return false;
    if (confirmation && !(await confirmed(confirmation, confirm, confirmMessage))) return false;
    busy = true;
    setStatus("Working…");
    setControlsDisabled(true);
    try {
      const result = await call(request);
      const isExport = request.action === "exportCookies" || request.action === "exportPasswords";
      setStatus(
        isExport
          ? result === null
            ? "Export canceled."
            : "Export saved."
          : request.action === "applyCookies"
            ? "Sessions synchronized. Reload open pages when you are ready to use the saved sessions."
            : "Saved."
      );
      await render();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      return false;
    } finally {
      busy = false;
      setControlsDisabled(false);
    }
  };
  async function renderSiteData(current: number) {
    const state: SiteDataState = {
      ...(siteDataState ?? { origins: null, diagnostics: null }),
      dataLoading: true,
    };
    const commit = () => {
      if (generation !== current) return;
      siteDataState = state;
      replaceContent(siteDataView(state, action));
      // The status and its recovery action are usable even while rows load.
      content.setAttribute("aria-busy", "false");
      applyFocus();
    };
    commit();
    const reads = await Promise.allSettled([
      call({ action: "snapshot" })
        .then((value) => BrowserPrivacySnapshotSchema.parse(value))
        .then(
          (snapshot) => {
            state.origins = snapshot.cookieOrigins.origins;
            state.dataError = undefined;
            state.dataLoading = false;
            commit();
          },
          (error: unknown) => {
            state.origins = null;
            state.dataError = errorMessage(error);
            state.dataLoading = false;
            commit();
          }
        ),
      call({ action: "diagnostics" })
        .then((value) => BrowserCookieProjectionDiagnosticsSchema.nullable().parse(value))
        .then(
          (diagnostics) => {
            state.diagnostics = diagnostics;
            state.diagnosticsError = undefined;
            commit();
          },
          (error: unknown) => {
            state.diagnostics = null;
            state.diagnosticsError = errorMessage(error);
            commit();
          }
        ),
    ]);
    const failures = reads.filter(
      (read): read is PromiseRejectedResult => read.status === "rejected"
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((read) => read.reason),
        "Browser data could not be rendered"
      );
  }
  present = (value) => {
    document.documentElement.dataset["dark"] = String(
      value.dark ?? matchMedia("(prefers-color-scheme: dark)").matches
    );
    const scope = required("workspace");
    scope.textContent = value.workspaceName
      ? `Browser data in ${value.workspaceName}`
      : "Browser data";
    if (value.focus) pendingFocus = value.focus;
    if (section === value.section) {
      applyFocus();
      return;
    }
    section = value.section;
    siteDataState = null;
    if (confirm.open) confirm.close("cancel");
    setStatus("");
    content.replaceChildren(message("Loading browser data…"));
    void render();
  };
  refresh = () => {
    // Synchronization updates must not replace an autofill edit in progress.
    if (!busy && section === "siteData" && !confirm.open) void render();
  };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !confirm.open) {
      event.preventDefault();
      ipcRenderer.send("vibestudio:browser-data:close");
    } else if (event.key === "Tab" && !confirm.open) {
      const focusable = focusableControls();
      const edge = event.shiftKey ? focusable[0] : focusable.at(-1);
      if (edge === document.activeElement || (!edge && document.activeElement === document.body)) {
        event.preventDefault();
        ipcRenderer.send("vibestudio:browser-data:focus", { backward: event.shiftKey });
      }
    }
  });
  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.className = error ? "error" : "muted";
  }
  function replaceContent(next: HTMLElement) {
    // Capture interaction state when committing the response, not when starting
    // its read: users can move focus or change a format while the vault replies.
    const active = document.activeElement;
    const hadFocus =
      document.hasFocus() && active instanceof HTMLElement && content.contains(active);
    const focusedKey = hadFocus ? active.dataset["focusKey"] : undefined;
    const detailsOpen = content.querySelector("details")?.open ?? false;
    const formats = new Map(
      [...content.querySelectorAll<HTMLSelectElement>("select[data-focus-key]")].map((select) => [
        select.dataset["focusKey"],
        select.value,
      ])
    );
    content.replaceChildren(next);
    const details = content.querySelector("details");
    if (details) details.open = detailsOpen;
    for (const select of content.querySelectorAll<HTMLSelectElement>("select[data-focus-key]")) {
      const value = formats.get(select.dataset["focusKey"]);
      if (value !== undefined && [...select.options].some((option) => option.value === value))
        select.value = value;
    }
    if (!hadFocus || pendingFocus) return;
    const target = focusedKey
      ? [...content.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
          (element) => element.dataset["focusKey"] === focusedKey
        )
      : undefined;
    if (target) target.focus({ preventScroll: true });
    else {
      // A removed site's action must never transfer to the row now at its old
      // position. Use a stable, non-destructive destination instead.
      const fallback = content.querySelector<HTMLElement>('[data-focus-key="site-data-details"]');
      if (fallback) fallback.focus();
      else {
        next.tabIndex = -1;
        next.focus();
      }
    }
  }
  function setControlsDisabled(disabled: boolean) {
    content
      .querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement
      >("button,input,select")
      .forEach((element) => {
        element.disabled = disabled;
      });
  }
  function focusableControls() {
    return [
      ...content.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]'
      ),
    ].filter((element) => element.getClientRects().length > 0);
  }
  function applyFocus() {
    if (!pendingFocus || content.getAttribute("aria-busy") === "true") return;
    const controls = focusableControls();
    const target = pendingFocus === "last" ? controls.at(-1) : controls[0];
    if (target) target.focus();
    else ipcRenderer.send("vibestudio:browser-data:focus", { backward: pendingFocus === "last" });
    pendingFocus = undefined;
  }
  if (presentation) present(presentation);
  ipcRenderer.send("vibestudio:browser-data:ready");
});

type Action = (request: BrowserPrivacyRequest, confirmation?: string) => Promise<boolean>;
function sectionView(
  section: Exclude<BrowserPrivacySection, "siteData">,
  data: BrowserPrivacySnapshot,
  action: Action
): HTMLElement {
  const root = document.createElement("div");
  if (section === "passwords") {
    root.append(
      heading("Passwords"),
      message("Manage saved logins and choose which sites may save passwords.")
    );
    if (data.passwords.length === 0) root.append(message("No passwords saved yet."));
    for (const row of data.passwords) {
      root.append(
        rowWithAction(`${row.origin_url} · ${row.username || "No username"}`, "Delete", () =>
          action(
            { action: "deletePassword", id: row.id },
            `Delete the saved password for ${row.origin_url}?`
          )
        )
      );
    }
    if (data.passwords.length > 0) root.append(exportControl("passwords", action));
    root.append(subheading("Sites excluded from password saving"));
    if (data.neverSave.length === 0)
      root.append(message("Password saving is allowed on all sites."));
    for (const origin of data.neverSave)
      root.append(
        rowWithAction(
          origin,
          "Allow saving",
          () =>
            action({ action: "removeNeverSave", origin }, `Allow password saving for ${origin}?`),
          false
        )
      );
  } else if (section === "autofill") {
    root.append(
      heading("Autofill"),
      message("Save personal information to fill in forms more quickly.")
    );
    const create = document.createElement("form");
    create.className = "form";
    create.setAttribute("aria-label", formFillCreatePresentation.ariaLabel);
    const type = document.createElement("select");
    for (const key of formFillCreatePresentation.typeOptions) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = autofillFieldLabel(key);
      type.append(option);
    }
    type.value = formFillCreatePresentation.defaultType;
    const label = document.createElement("input");
    label.placeholder = "For example, Work email";
    const value = document.createElement("input");
    value.required = true;
    const add = button(formFillCreatePresentation.submitLabel, () => create.requestSubmit());
    add.className = "primary";
    const controls = document.createElement("div");
    controls.className = "toolbar";
    controls.append(add);
    create.append(
      labeled(formFillCreatePresentation.typeLabel, type),
      labeled("Label (optional)", label),
      labeled(formFillCreatePresentation.valueLabel, value),
      controls
    );
    create.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!value.value.trim()) {
        value.setCustomValidity("Enter a value to save.");
        value.reportValidity();
        return;
      }
      value.setCustomValidity("");
      void action(
        createAddFormFillRequest({
          type: type.value,
          value: value.value,
          displayLabel: label.value,
        }),
        addFormFillConfirmation(type.value)
      );
    });
    value.addEventListener("input", () => value.setCustomValidity(""));
    root.append(create, subheading("Saved information"));
    if (data.formFill.length === 0) root.append(message("No autofill information saved yet."));
    for (const row of data.formFill) {
      const field = autofillFieldLabel(row.type || row.fieldName);
      const input = document.createElement("input");
      input.value = row.value;
      input.setAttribute("aria-label", field);
      const item = document.createElement("div");
      item.className = "row";
      const title = document.createElement("span");
      title.textContent =
        typeof row["displayLabel"] === "string" ? `${row["displayLabel"]} · ${field}` : field;
      title.className = "row-label";
      item.append(
        title,
        input,
        button("Save", () => action({ action: "updateFormFill", id: row.id, value: input.value })),
        button(
          "Delete",
          () =>
            action(
              { action: "deleteFormFill", id: row.id },
              `Delete this ${field.toLowerCase()} from autofill?`
            ),
          true
        )
      );
      root.append(item);
    }
    if (data.formFill.length > 0)
      root.append(
        button(
          "Delete all autofill information…",
          () =>
            action(
              { action: "clearFormFill" },
              "Delete all saved autofill information? This cannot be undone."
            ),
          true
        )
      );
  }
  return root;
}

interface SiteDataState {
  origins: string[] | null;
  dataLoading: boolean;
  dataError?: string;
  diagnostics: BrowserCookieProjectionDiagnostics | null;
  diagnosticsError?: string;
}

function siteDataView(data: SiteDataState, action: Action): HTMLElement {
  const root = document.createElement("div");
  root.append(
    heading("Site data"),
    message("Cookies keep you signed in and remember your preferences on websites.")
  );
  const sync = browserSessionStatus(data.diagnostics, data.diagnosticsError);
  const card = document.createElement("div");
  card.className = "status-card";
  const title = document.createElement("strong");
  title.textContent = sync.title;
  card.append(title, message(sync.description, sync.error));
  if (sync.canRetry)
    card.append(
      keyed(
        "site-data-retry",
        button("Retry synchronization", () => action({ action: "applyCookies" }))
      )
    );
  root.append(card, subheading("Sites with saved cookies"));
  if (data.dataLoading) root.append(message("Loading saved site data…"));
  else if (data.dataError)
    root.append(message(`Saved site data could not be loaded: ${data.dataError}`, true));
  else if (data.origins?.length === 0) root.append(message("No site cookies saved yet."));
  for (const origin of data.origins ?? [])
    root.append(
      rowWithAction(
        origin,
        "Clear data…",
        () =>
          action(
            { action: "clearOrigin", origin },
            `Delete cookies for ${origin}? This may sign you out of the site.`
          ),
        true,
        `site-data-clear:${origin}`
      )
    );
  if (data.origins?.length) {
    root.append(exportControl("cookies", action));
    const clear = document.createElement("div");
    clear.className = "toolbar";
    clear.append(
      keyed(
        "site-data-clear-all",
        button(
          "Clear cookies for all sites…",
          () =>
            action(
              { action: "clearAllCookies" },
              "Delete cookies for every site? This may sign you out of websites. This cannot be undone."
            ),
          true
        )
      )
    );
    root.append(clear);
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  keyed("site-data-details", summary);
  summary.textContent = "Synchronization details";
  details.append(
    summary,
    pre(
      data.diagnostics ?? { status: data.diagnosticsError ?? "Waiting for the browser environment" }
    )
  );
  root.append(details);
  return root;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exportControl(kind: "passwords" | "cookies", action: Action): HTMLElement {
  const root = document.createElement("div");
  root.className = "toolbar";
  const format = document.createElement("select");
  keyed(`${kind}-export-format`, format);
  format.setAttribute(
    "aria-label",
    `${kind === "passwords" ? "Password" : "Cookie"} export format`
  );
  const options =
    kind === "passwords"
      ? [
          ["csv-chrome", "CSV (Chrome)"],
          ["csv-firefox", "CSV (Firefox)"],
          ["json", "JSON"],
        ]
      : [
          ["json", "JSON"],
          ["netscape-txt", "Netscape cookie file"],
        ];
  for (const [key, label] of options) {
    const option = document.createElement("option");
    option.value = key!;
    option.textContent = label!;
    format.append(option);
  }
  root.append(
    format,
    keyed(
      `${kind}-export`,
      button(`Export ${kind}…`, () =>
        action(
          kind === "passwords"
            ? {
                action: "exportPasswords",
                format: format.value as "csv-chrome" | "csv-firefox" | "json",
              }
            : { action: "exportCookies", format: format.value as "json" | "netscape-txt" }
        )
      )
    )
  );
  return root;
}
function labeled(text: string, field: HTMLElement) {
  const label = document.createElement("label");
  label.append(document.createTextNode(text), field);
  return label;
}
function rowWithAction(
  text: string,
  label: string,
  onClick: () => unknown,
  danger = true,
  focusKey?: string
) {
  const item = document.createElement("div");
  item.className = "row";
  const title = document.createElement("span");
  title.textContent = text;
  title.className = "row-label";
  const control = button(label, onClick, danger);
  if (focusKey) keyed(focusKey, control);
  item.append(title, control);
  return item;
}
function keyed<T extends HTMLElement>(key: string, element: T): T {
  element.dataset["focusKey"] = key;
  return element;
}
function button(label: string, onClick: () => unknown, danger = false) {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = label;
  if (danger) result.className = "danger";
  result.addEventListener("click", () => void onClick());
  return result;
}
function heading(text: string) {
  const result = document.createElement("h2");
  result.textContent = text;
  return result;
}
function subheading(text: string) {
  const result = document.createElement("h3");
  result.textContent = text;
  return result;
}
function message(text: string, error = false) {
  const result = document.createElement("p");
  result.textContent = text;
  result.className = error ? "error" : "muted";
  return result;
}
function pre(value: unknown) {
  const result = document.createElement("pre");
  result.textContent = JSON.stringify(value, null, 2);
  return result;
}
function required(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing browser data element ${id}`);
  return element;
}
async function confirmed(text: string, dialog: HTMLDialogElement, messageElement: HTMLElement) {
  messageElement.textContent = text;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise<boolean>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    })
  );
}
