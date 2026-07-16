import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONTEXT_BINDING_FILE, CONTEXT_BINDING_PROTOCOL } from "@vibestudio/shared/contextBinding";
import {
  assertBindingWorkspace,
  findContextBinding,
  findContextBindingLocation,
} from "./contextBinding.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "context-binding-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI context binding", () => {
  it("walks upward and returns the exact identity binding", () => {
    const binding = {
      protocol: CONTEXT_BINDING_PROTOCOL,
      workspaceId: "workspace-1",
      contextId: "context-1",
    };
    fs.writeFileSync(path.join(root, CONTEXT_BINDING_FILE), JSON.stringify(binding));
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(findContextBinding(nested)).toEqual(binding);
    expect(findContextBindingLocation(nested)).toEqual({
      binding,
      directory: root,
      filePath: path.join(root, CONTEXT_BINDING_FILE),
    });
  });

  it("does not accept legacy, expanded, or malformed bindings", () => {
    for (const value of [
      { contextId: "context-1", workspaceId: "workspace-1" },
      {
        protocol: CONTEXT_BINDING_PROTOCOL,
        contextId: "context-1",
        workspaceId: "workspace-1",
        serverUrl: "http://127.0.0.1:5000",
      },
      "{not json",
    ]) {
      fs.writeFileSync(
        path.join(root, CONTEXT_BINDING_FILE),
        typeof value === "string" ? value : JSON.stringify(value)
      );
      expect(() => findContextBinding(root)).toThrow(/invalid context binding/u);
    }
  });

  it("does not walk past an invalid nearer binding to a valid parent", () => {
    fs.writeFileSync(
      path.join(root, CONTEXT_BINDING_FILE),
      JSON.stringify({
        protocol: CONTEXT_BINDING_PROTOCOL,
        workspaceId: "workspace-1",
        contextId: "parent",
      })
    );
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, CONTEXT_BINDING_FILE), "{broken");

    expect(() => findContextBinding(nested)).toThrow(
      `invalid context binding at ${path.join(nested, CONTEXT_BINDING_FILE)}`
    );
  });

  it("matches durable workspace identity, not a route URL", () => {
    const binding = {
      protocol: CONTEXT_BINDING_PROTOCOL,
      workspaceId: "workspace-1",
      contextId: "context-1",
    };
    expect(() => assertBindingWorkspace(binding, { workspaceId: "workspace-1" })).not.toThrow();
    expect(() => assertBindingWorkspace(binding, { workspaceId: "workspace-2" })).toThrow(
      /belongs to workspace/u
    );
  });
});
