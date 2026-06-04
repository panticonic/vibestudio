/**
 * NatStackExtensionUIContext
 *
 * Bridges NatStack's local `PiExtensionUIContext` interface to channel
 * operations. Interactive primitives are only valid during a `tool_call`
 * dispatch, where the runtime binds the active `toolCallId` into a fresh
 * per-event wrapper. Non-interactive methods remain available for all events.
 */

import type {
  PiExtensionUIContext,
  PiExtensionUIDialogOptions as ExtensionUIDialogOptions,
  PiExtensionWidgetOptions as ExtensionWidgetOptions,
} from "./pi-extension-api.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface NatStackToolDispatchMeta {
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  mode?: "approval" | "ui-prompt";
}

/**
 * NatStack-internal UI bridge interface. The public Pi UI surface stays
 * toolCallId-free; the runtime binds the current toolCallId per event.
 */
export interface NatStackScopedUiContext {
  selectForTool(
    toolCallId: string,
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta
  ): Promise<string | undefined | AgentToolResult<any>>;
  confirmForTool(
    toolCallId: string,
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta
  ): Promise<boolean | AgentToolResult<any>>;
  inputForTool(
    toolCallId: string,
    title: string,
    placeholder: string | undefined,
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta
  ): Promise<string | undefined | AgentToolResult<any>>;
  editorForTool(
    toolCallId: string,
    title: string,
    prefill?: string,
    meta?: NatStackToolDispatchMeta
  ): Promise<string | undefined | AgentToolResult<any>>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, opts?: ExtensionWidgetOptions): void;
  setWorkingMessage(message: string | undefined): void;
}

export class NatStackUiToolResultError extends Error {
  constructor(readonly result: AgentToolResult<any>) {
    super(toolResultText(result) || "UI prompt returned a tool result");
    this.name = "NatStackUiToolResultError";
  }
}

function isAgentToolResult(value: unknown): value is AgentToolResult<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function toolResultText(result: AgentToolResult<any>): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

function unwrapUiValue<T>(value: T | AgentToolResult<any>): T {
  if (isAgentToolResult(value)) throw new NatStackUiToolResultError(value);
  return value;
}

export class NatStackExtensionUIContext implements PiExtensionUIContext {
  constructor(
    private readonly scopedUi: NatStackScopedUiContext,
    private readonly dispatchMeta?: NatStackToolDispatchMeta
  ) {}

  private requireToolDispatch(): Required<Pick<NatStackToolDispatchMeta, "toolCallId">> &
    NatStackToolDispatchMeta {
    if (!this.dispatchMeta?.toolCallId) {
      throw new Error("UI not available outside tool_call dispatch");
    }
    return this.dispatchMeta as Required<Pick<NatStackToolDispatchMeta, "toolCallId">> &
      NatStackToolDispatchMeta;
  }

  async select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions
  ): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return unwrapUiValue(
      await this.scopedUi.selectForTool(meta.toolCallId, title, options, opts, meta)
    );
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    const meta = this.requireToolDispatch();
    return unwrapUiValue(
      await this.scopedUi.confirmForTool(meta.toolCallId, title, message, opts, meta)
    );
  }

  async dispatchApproval(title: string, message: string): Promise<boolean> {
    const meta = { ...this.requireToolDispatch(), mode: "approval" as const };
    return unwrapUiValue(
      await this.scopedUi.confirmForTool(meta.toolCallId, title, message, undefined, meta)
    );
  }

  async input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions
  ): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return unwrapUiValue(
      await this.scopedUi.inputForTool(meta.toolCallId, title, placeholder, opts, meta)
    );
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return unwrapUiValue(await this.scopedUi.editorForTool(meta.toolCallId, title, prefill, meta));
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.scopedUi.notify(message, type);
  }

  setStatus(key: string, text: string | undefined): void {
    this.scopedUi.setStatus(key, text);
  }

  setWorkingMessage(message?: string): void {
    this.scopedUi.setWorkingMessage(message);
  }

  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    if (Array.isArray(content) || content === undefined) {
      this.scopedUi.setWidget(key, content as string[] | undefined, options);
    }
  }

  onTerminalInput(): () => void {
    return () => {};
  }

  setFooter(): void {
    /* TUI-only */
  }

  setHeader(): void {
    /* TUI-only */
  }

  setTitle(): void {
    /* TUI-only */
  }

  async custom<T>(): Promise<T> {
    throw new Error("ExtensionUIContext.custom() is not supported in NatStack headless mode");
  }

  pasteToEditor(): void {
    /* TUI-only */
  }

  setEditorText(): void {
    /* TUI-only */
  }

  getEditorText(): string {
    return "";
  }

  setEditorComponent(): void {
    /* TUI-only */
  }

  get theme(): never {
    return {} as never;
  }

  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }

  getTheme(): undefined {
    return undefined;
  }

  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: "Themes unsupported in NatStack headless mode" };
  }

  getToolsExpanded(): boolean {
    return true;
  }

  setToolsExpanded(): void {
    /* TUI-only */
  }
}
