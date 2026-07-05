/*
 * hello-vanilla — a Vibestudio panel with ZERO UI framework.
 * ---------------------------------------------------------
 * This panel exists to prove the purest, most framework-agnostic path through
 * the panel build system:
 *
 *   - It depends on ONLY `@workspace/runtime` — no `@workspace/react`, no
 *     `@workspace/svelte`. (See package.json.)
 *   - It uses the `vanilla` template (workspace/templates/vanilla), whose
 *     template.json declares `{ "framework": "vanilla" }`. That makes the build
 *     pick the vanilla esbuild adapter: no JSX transform, no mount helper — the
 *     adapter simply imports this module and lets it do its own DOM work.
 *   - Every pixel below is produced with plain `document.createElement` and
 *     real DOM event listeners. No virtual DOM, no reactivity library.
 *
 * The NEUTRAL runtime surface we rely on (all imported from `@workspace/runtime`):
 *
 *   - `id`         — this panel's entity id                 (top-level export)
 *   - `contextId`  — the durable context this panel is bound to (top-level export)
 *   - `panel`      — the panel-only namespace. We use:
 *        • panel.getTheme()        → "light" | "dark"  (synchronous snapshot)
 *        • panel.onThemeChange(cb) → invokes cb immediately AND on every change;
 *                                    returns an unsubscribe function.
 *        • panel.stateArgs.get()   → the panel's state-args object (synchronous)
 *
 * NOTE for readers: `getStateArgs` is intentionally NOT imported here. Despite
 * being a function inside the runtime, it is *not* a top-level export of
 * `@workspace/runtime` — the supported public path is `panel.stateArgs.get()`,
 * which is exactly what we use below.
 */

import "./style.css";
import { id, contextId, panel } from "@workspace/runtime";

// --- Tiny DOM helper -------------------------------------------------------
// A one-liner over document.createElement so the demo stays readable while
// remaining 100% framework-free. It assigns plain element properties
// (className, textContent, …) and appends string/Node children.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// One labeled row for the "facts" definition list: <dt>label</dt><dd>value</dd>.
function fact(label: string, value: Node | string): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(el("dt", { textContent: label }), el("dd", {}, value));
  return frag;
}

// --- Mount point -----------------------------------------------------------
// The vanilla template provides <div id="root"></div>. We render straight into
// it; there is no framework "mount" step.
const root = document.getElementById("root");
if (!root) {
  throw new Error("hello-vanilla: #root element not found in template HTML");
}

// --- Runtime facts ---------------------------------------------------------
// `panel.getTheme()` is a synchronous snapshot of the *current* appearance.
// We capture it once here to show the value the panel started with; live
// updates are handled separately by panel.onThemeChange below.
const initialTheme = panel.getTheme();

// `panel.stateArgs.get()` returns the state-args object the panel was opened
// with (an empty object when none were supplied).
const stateArgs = panel.stateArgs.get();

// This <dd> is updated live whenever the host theme changes.
const liveThemeValue = el("span", { className: "hv-mono", textContent: initialTheme });

// --- Counter (interactivity via DOM event listeners) -----------------------
let count = 0;
const countValue = el("span", { className: "hv-count-value", textContent: String(count) });
const renderCount = (): void => {
  countValue.textContent = String(count);
};

const decBtn = el("button", { className: "hv-btn", type: "button", textContent: "−" }); // minus sign
const incBtn = el("button", { className: "hv-btn", type: "button", textContent: "+" });
const resetBtn = el("button", {
  className: "hv-btn hv-btn-reset",
  type: "button",
  textContent: "Reset",
});

decBtn.addEventListener("click", () => {
  count -= 1;
  renderCount();
});
incBtn.addEventListener("click", () => {
  count += 1;
  renderCount();
});
resetBtn.addEventListener("click", () => {
  count = 0;
  renderCount();
});

// --- Build the view --------------------------------------------------------
const card = el(
  "div",
  { className: "hv-card" },
  el("h1", { className: "hv-title", textContent: "Hello, Vanilla" }),
  el("p", {
    className: "hv-subtitle",
    textContent: "A Vibestudio panel with no UI framework — just @workspace/runtime + DOM.",
  }),
  el(
    "dl",
    { className: "hv-facts" },
    fact("Panel id", el("span", { className: "hv-mono", textContent: id })),
    fact("Context id", el("span", { className: "hv-mono", textContent: contextId })),
    fact("Theme (live)", liveThemeValue),
    fact(
      "State args",
      el("code", { className: "hv-code", textContent: JSON.stringify(stateArgs, null, 2) }),
    ),
  ),
  el("div", { className: "hv-counter" }, decBtn, countValue, incBtn, resetBtn),
);

root.append(card);

// --- Live theme handling ---------------------------------------------------
// applyTheme drives ALL theme-dependent UI: it flips the single `data-theme`
// attribute on #root (CSS in style.css does the rest) and updates the readout.
const applyTheme = (theme: "light" | "dark"): void => {
  root.dataset["theme"] = theme;
  liveThemeValue.textContent = theme;
};

// panel.onThemeChange fires the callback immediately (so this also performs the
// initial paint) and again on every host theme change. It returns an
// unsubscribe function, which we tear down when the panel unloads.
const unsubscribeTheme = panel.onThemeChange(applyTheme);
window.addEventListener("beforeunload", () => {
  unsubscribeTheme();
});
