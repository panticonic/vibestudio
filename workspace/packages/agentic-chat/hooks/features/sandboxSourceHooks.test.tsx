// @vitest-environment jsdom

import React, { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/pubsub";
import { useActionBar } from "./useActionBar";
import { useInlineUi } from "./useInlineUi";
import type { ActionBarHookState } from "./useActionBar";
import type { InlineUiState } from "./useInlineUi";
import type { ChatMessage } from "../../types";

function makeMessage(content: unknown): ChatMessage {
  return {
    id: "msg-1",
    senderId: "agent-1",
    content: JSON.stringify(content),
    contentType: CONTENT_TYPE_INLINE_UI,
    kind: "message",
    complete: true,
  } as ChatMessage;
}

describe("sandbox source hooks", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__vibez1ModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__vibez1Require__"];
    originalPreload = (globalThis as Record<string, unknown>)["__vibez1PreloadModules__"];

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibez1ModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__vibez1Require__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__vibez1PreloadModules__"] = async (ids: string[]) => ids.map((id) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    });
  });

  afterEach(() => {
    if (originalModuleMap === undefined) delete (globalThis as Record<string, unknown>)["__vibez1ModuleMap__"];
    else (globalThis as Record<string, unknown>)["__vibez1ModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined) delete (globalThis as Record<string, unknown>)["__vibez1Require__"];
    else (globalThis as Record<string, unknown>)["__vibez1Require__"] = originalRequire;
    if (originalPreload === undefined) delete (globalThis as Record<string, unknown>)["__vibez1PreloadModules__"];
    else (globalThis as Record<string, unknown>)["__vibez1PreloadModules__"] = originalPreload;
  });

  it("compiles inline_ui file sources with package.json inferred imports", async () => {
    const states: InlineUiState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/ui.tsx") return `import { label } from "label-lib"; export default function App() { return label; }`;
      if (path === "packages/app/package.json") return JSON.stringify({ dependencies: { "label-lib": "2" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return `module.exports = { label: "ready" };`;
    };
    const messages = [makeMessage({ id: "ui-1", source: { type: "file", path: "packages/app/ui.tsx" } })];

    function Harness() {
      const state = useInlineUi({ messages, loadSourceFile, loadImport });
      useEffect(() => { states.push(state); }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      const entry = states[states.length - 1]?.inlineUiComponents.get("ui-1");
      expect(entry?.Component).toBeTruthy();
    });
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });

  it("compiles action bar file sources with package.json inferred imports", async () => {
    const states: ActionBarHookState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/bar.tsx") return `import { label } from "label-lib"; export default function Bar() { return label; }`;
      if (path === "packages/app/package.json") return JSON.stringify({ dependencies: { "label-lib": "3" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return `module.exports = { label: "ready" };`;
    };
    const data = { id: "bar-1", source: { type: "file" as const, path: "packages/app/bar.tsx" } };

    function Harness() {
      const state = useActionBar({
        data,
        loadSourceFile,
        loadImport,
      });
      useEffect(() => { states.push(state); }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      const entry = states[states.length - 1]?.actionBar?.component;
      expect(entry?.error).toBeUndefined();
      expect(entry?.Component).toBeTruthy();
    });
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:3" }]);
  });
});
