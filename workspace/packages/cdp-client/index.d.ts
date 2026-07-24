// Public type surface for @workspace/cdp-client — a workerd-native
// CDP client with a Playwright-style Page/Locator API implemented over raw CDP.
// Kept in sync with src/worker.ts (the implementation for the worker/workerd and
// vibestudio-panel conditions).

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CdpViewportSize {
  width: number;
  height: number;
}

export interface CdpScreenshotOptions {
  type?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
}

export interface CdpConsoleEvent {
  type: string;
  text: string;
  args: unknown[];
}

export interface CdpDomInspection {
  selector: string;
  found: boolean;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  role?: string;
  accessibleName?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  boundingBox?: BoundingBox;
  /** Nearest rendered ancestors first, for disambiguating repeated controls. */
  ancestors?: Array<{
    tagName: string;
    role: string;
    accessibleName: string;
    text: string;
  }>;
}

export type WaitState = "attached" | "detached" | "visible" | "hidden";
export interface ActionOptions {
  timeout?: number;
}
export interface ByTextOptions {
  exact?: boolean;
}
export type TextMatcher = string | RegExp;
export interface ByRoleOptions {
  name?: TextMatcher;
  exact?: boolean;
}

/**
 * A Playwright-style locator. Actions auto-wait for readiness and resolve
 * after their browser event turn, so the next action observes framework state.
 */
export interface CdpLocator {
  // Scoping / chaining
  /** CSS, or `text=...` compiled into the same semantic engine as getByText. */
  locator(selector: string): CdpLocator;
  getByRole(role: string, options?: ByRoleOptions): CdpLocator;
  getByText(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByLabel(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByPlaceholder(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByTestId(testId: string): CdpLocator;
  getByAltText(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByTitle(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  filter(options?: { hasText?: TextMatcher; hasTextExact?: boolean }): CdpLocator;
  nth(index: number): CdpLocator;
  first(): CdpLocator;
  last(): CdpLocator;
  all(): Promise<CdpLocator[]>;
  // Actions (auto-waiting)
  click(opts?: ActionOptions): Promise<void>;
  dblclick(opts?: ActionOptions): Promise<void>;
  hover(opts?: ActionOptions): Promise<void>;
  fill(value: string, opts?: ActionOptions): Promise<void>;
  type(text: string, opts?: ActionOptions): Promise<void>;
  clear(opts?: ActionOptions): Promise<void>;
  press(key: string, opts?: ActionOptions): Promise<void>;
  check(opts?: ActionOptions): Promise<void>;
  uncheck(opts?: ActionOptions): Promise<void>;
  setChecked(checked: boolean, opts?: ActionOptions): Promise<void>;
  selectOption(value: string | string[], opts?: ActionOptions): Promise<string[]>;
  focus(opts?: ActionOptions): Promise<void>;
  blur(opts?: ActionOptions): Promise<void>;
  selectText(opts?: ActionOptions): Promise<void>;
  scrollIntoViewIfNeeded(opts?: ActionOptions): Promise<void>;
  dispatchEvent(type: string, opts?: ActionOptions): Promise<void>;
  // State / reads
  waitFor(options?: { state?: WaitState; timeout?: number }): Promise<void>;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isChecked(opts?: ActionOptions): Promise<boolean>;
  isEnabled(opts?: ActionOptions): Promise<boolean>;
  isDisabled(opts?: ActionOptions): Promise<boolean>;
  isEditable(opts?: ActionOptions): Promise<boolean>;
  getAttribute(name: string, opts?: ActionOptions): Promise<string | null>;
  inputValue(opts?: ActionOptions): Promise<string>;
  innerText(opts?: ActionOptions): Promise<string>;
  textContent(): Promise<string | null>;
  allInnerTexts(): Promise<string[]>;
  allTextContents(): Promise<string[]>;
  evaluate<Result, Arg = unknown>(
    pageFunction: (element: Element, arg: Arg) => Result | Promise<Result>,
    arg?: Arg
  ): Promise<Result>;
  evaluateAll<Result, Arg = unknown>(
    pageFunction: (elements: Element[], arg: Arg) => Result | Promise<Result>,
    arg?: Arg
  ): Promise<Result>;
  boundingBox(): Promise<BoundingBox | null>;
  inspect(): Promise<CdpDomInspection>;
  /** Playwright-style description, e.g. `getByRole("button", { name: "Go" })`. */
  toString(): string;
}

/** A Playwright-style page bound to one CDP target. */
export interface CdpPage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  title(): Promise<string>;
  /** Playwright-compatible synchronous current URL. Do not await or attach `.catch()`. */
  url(): string;
  content(): Promise<string>;
  /** Set the default timeout (ms) for auto-waiting actions/reads. Default 30000. */
  setDefaultTimeout(timeoutMs: number): void;
  /** Emulate a CSS viewport on the current target. */
  setViewportSize(viewportSize: CdpViewportSize): Promise<void>;
  /** Current configured or observed CSS viewport. */
  viewportSize(): CdpViewportSize | null;
  evaluate(pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown>;
  /**
   * Find by CSS or `text=...`. A quoted JSON string is exact text; unquoted
   * text is substring matching. Prefer getBy* helpers for resilient locators.
   */
  locator(selector: string): CdpLocator;
  /** Find by ARIA role, optionally narrowed by accessible name. */
  getByRole(role: string, options?: ByRoleOptions): CdpLocator;
  getByText(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByLabel(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByPlaceholder(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByTestId(testId: string): CdpLocator;
  getByAltText(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  getByTitle(text: TextMatcher, options?: ByTextOptions): CdpLocator;
  waitForTimeout(timeout: number): Promise<void>;
  waitForFunction(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<unknown>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number }
  ): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { state?: WaitState; timeout?: number }
  ): Promise<CdpLocator | null>;
  keyboard: {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
    insertText(text: string): Promise<void>;
  };
  /** Alias for `keyboard.press(key)`. */
  pressKey(key: string): Promise<void>;
  consoleEvents(): CdpConsoleEvent[];
  clearConsoleEvents(): void;
  screenshot(options?: CdpScreenshotOptions): Promise<Uint8Array>;
  /** Disconnect this automation client. The owning panel remains open. */
  close(): Promise<void>;
}

/** Low-level raw CDP connection. Use for protocol-level work beyond the Page API. */
export class CdpConnection {
  static connect(wsEndpoint: string, authToken?: string): Promise<CdpConnection>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
  close(): void;
}

/** Error thrown by locator actions/reads; the message names the target locator. */
export class CdpError extends Error {
  readonly locator?: string;
  constructor(message: string, options?: { cause?: unknown; locator?: string });
}

export interface Browser {
  contexts(): Array<{ pages(): CdpPage[] }>;
  close(): Promise<void>;
}

export const BrowserImpl: {
  connect(
    wsEndpoint: string,
    options?: { transportOptions?: { authToken?: string } }
  ): Promise<Browser>;
};

export type Options = {
  headless?: boolean;
};

export function connect(
  wsEndpoint: string,
  browserName: string,
  options?: Options & { authToken?: string }
): Promise<Browser>;
