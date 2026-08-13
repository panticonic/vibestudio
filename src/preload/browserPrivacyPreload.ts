import { contextBridge, ipcRenderer } from "electron";
import {
  BrowserPrivacyResultSchema,
  BrowserPrivacySnapshotSchema,
  BrowserPrivacySectionSchema,
  type BrowserPrivacyRequest,
  type BrowserPrivacySection,
} from "../main/services/browserPrivacyProtocol.js";
import {
  addFormFillConfirmation,
  createAddFormFillRequest,
  formFillCreatePresentation,
} from "../main/services/browserPrivacyPresentation.js";

const call = async (request: BrowserPrivacyRequest): Promise<unknown> => {
  const result = BrowserPrivacyResultSchema.parse(
    await ipcRenderer.invoke("vibestudio:browser-privacy:call", request)
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

contextBridge.exposeInMainWorld("__vibestudio_browser_privacy", { call });

window.addEventListener("DOMContentLoaded", () => {
  let section: BrowserPrivacySection = BrowserPrivacySectionSchema.catch("credentials").parse(
    new URLSearchParams(location.search).get("section")
  );
  let origin = "";
  const content = required("content");
  const status = required("status");
  const confirm = required("confirm") as HTMLDialogElement;
  const confirmMessage = required("confirm-message");
  const action = async (
    request: BrowserPrivacyRequest,
    confirmation?: string
  ): Promise<boolean> => {
    if (confirmation && !(await confirmed(confirmation, confirm, confirmMessage))) return false;
    setStatus("Working…");
    try {
      await call(request);
      setStatus("Done.");
      await render();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      return false;
    }
  };
  const render = async () => {
    content.setAttribute("aria-busy", "true");
    content.replaceChildren(message("Loading protected browser data…"));
    try {
      const snapshot = BrowserPrivacySnapshotSchema.parse(
        await call({ action: "snapshot", origin })
      );
      content.replaceChildren(
        sectionView(section, snapshot, action, (next) => {
          origin = next;
          void render();
        })
      );
    } catch (error) {
      content.replaceChildren(
        message(error instanceof Error ? error.message : String(error), true)
      );
    } finally {
      content.setAttribute("aria-busy", "false");
    }
  };
  document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      section = BrowserPrivacySectionSchema.parse(button.dataset["section"]);
      void render();
    });
  });
  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.className = error ? "error" : "muted";
  }
  void render();
});

function sectionView(
  section: BrowserPrivacySection,
  data: import("../main/services/browserPrivacyProtocol.js").BrowserPrivacySnapshot,
  action: (request: BrowserPrivacyRequest, confirmation?: string) => Promise<boolean>,
  inspect: (origin: string) => void
): HTMLElement {
  const root = document.createElement("div");
  root.append(
    heading(section === "formFill" ? "Form fill" : section[0]!.toUpperCase() + section.slice(1))
  );
  if (section === "credentials") {
    appendRows(
      root,
      data.passwords,
      (row) => `${row.origin_url} · ${row.username || "(no username)"}`,
      (row) =>
        action(
          { action: "deletePassword", id: row.id },
          `Delete the saved password for ${row.origin_url}?`
        )
    );
    root.append(heading("Never save"));
    appendRows(root, data.neverSave, String, (value) =>
      action(
        { action: "removeNeverSave", origin: value },
        `Allow password saving for ${value} again?`
      )
    );
  } else if (section === "formFill") {
    const type = document.createElement("select");
    type.setAttribute("aria-label", formFillCreatePresentation.typeLabel);
    for (const value of formFillCreatePresentation.typeOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      type.append(option);
    }
    type.value = formFillCreatePresentation.defaultType;
    const label = document.createElement("input");
    label.placeholder = "Label (optional)";
    label.setAttribute("aria-label", formFillCreatePresentation.labelLabel);
    const value = document.createElement("input");
    value.placeholder = "Value";
    value.setAttribute("aria-label", formFillCreatePresentation.valueLabel);
    const add = button(formFillCreatePresentation.submitLabel, async () => {
      const normalized = value.value.trim();
      if (!normalized) {
        value.setCustomValidity("Enter a value to save.");
        value.reportValidity();
        return;
      }
      value.setCustomValidity("");
      const saved = await action(
        createAddFormFillRequest({
          type: type.value,
          value: normalized,
          displayLabel: label.value,
        }),
        addFormFillConfirmation(type.value)
      );
      if (saved) {
        value.value = "";
        label.value = "";
      }
    });
    const create = document.createElement("div");
    create.className = "row";
    create.setAttribute("aria-label", formFillCreatePresentation.ariaLabel);
    create.append(type, label, value, add);
    root.append(create);
    root.append(
      button(
        "Clear all",
        () => action({ action: "clearFormFill" }, "Delete every saved form-fill value?"),
        true
      )
    );
    for (const row of data.formFill) {
      const input = document.createElement("input");
      input.value = row.value;
      input.setAttribute("aria-label", row.type || row.fieldName);
      const item = document.createElement("div");
      item.className = "row";
      item.append(
        input,
        button("Save", () => action({ action: "updateFormFill", id: row.id, value: input.value })),
        button(
          "Delete",
          () =>
            action(
              { action: "deleteFormFill", id: row.id },
              `Delete ${row.type || row.fieldName}?`
            ),
          true
        )
      );
      root.append(item);
    }
  } else if (section === "inspect") {
    const input = document.createElement("input");
    input.placeholder = "https://example.com";
    input.value = data.inspect.origin ?? "";
    const bar = document.createElement("div");
    bar.className = "toolbar";
    bar.append(
      input,
      button("Inspect", () => inspect(input.value))
    );
    root.append(bar, pre(data.inspect));
    const inspectedOrigin = data.inspect.origin;
    if (inspectedOrigin)
      root.append(
        button(
          "Clear site cookies",
          () =>
            action(
              { action: "clearOrigin", origin: inspectedOrigin },
              `Clear all cookies for ${inspectedOrigin}?`
            ),
          true
        )
      );
  } else if (section === "debug") {
    root.append(
      pre(data.diagnostics ?? { unavailable: true }),
      button(
        "End browser session",
        () => action({ action: "endSession" }, "Delete all session cookies?"),
        true
      ),
      button(
        "Clear all cookies",
        () => action({ action: "clearAllCookies" }, "Delete every browser cookie?"),
        true
      )
    );
  } else {
    for (const format of ["csv-chrome", "csv-firefox", "json"] as const)
      root.append(
        button(`Export passwords · ${format}`, () => action({ action: "exportPasswords", format }))
      );
    root.append(document.createElement("br"));
    for (const format of ["json", "netscape-txt"] as const)
      root.append(
        button(`Export cookies · ${format}`, () => action({ action: "exportCookies", format }))
      );
  }
  if (root.children.length === 1) root.append(message("Nothing stored yet."));
  return root;
}
function appendRows<T>(
  root: HTMLElement,
  rows: T[],
  label: (row: T) => string,
  remove: (row: T) => Promise<unknown>
) {
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "row";
    item.append(
      message(label(row)),
      button("Remove", () => remove(row), true)
    );
    root.append(item);
  }
}
function button(label: string, onClick: () => unknown, danger = false) {
  const value = document.createElement("button");
  value.textContent = label;
  if (danger) value.className = "danger";
  value.addEventListener("click", () => void onClick());
  return value;
}
function heading(text: string) {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}
function message(text: string, error = false) {
  const p = document.createElement("p");
  p.textContent = text;
  p.className = error ? "error" : "muted";
  return p;
}
function pre(value: unknown) {
  const result = document.createElement("pre");
  result.textContent = JSON.stringify(value, null, 2);
  return result;
}
function required(id: string) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing browser privacy element ${id}`);
  return value;
}
async function confirmed(text: string, dialog: HTMLDialogElement, messageElement: HTMLElement) {
  messageElement.textContent = text;
  dialog.showModal();
  return new Promise<boolean>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    })
  );
}
