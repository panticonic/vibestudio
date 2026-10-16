import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHostState, buildCommandTable } from "./hostState.js";
import {
  isBuiltInCommand,
  linkClientShim,
  syncClientIndex,
  unlinkClientShim,
  type ShimContext,
} from "./clientShims.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function context(): ShimContext & { directory: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shims-test-"));
  roots.push(root);
  const directory = path.join(root, "bin");
  fs.mkdirSync(directory);
  return {
    state: new TerminalHostState(path.join(root, "host.json")),
    isBuiltIn: isBuiltInCommand(["terminal", "remote", "fs"]),
    directory,
  };
}

const chat = { id: "chat", runtime: "terminal" as const, terminalCommand: "chat" };

describe("command table", () => {
  it("registers each client's command", () => {
    expect(
      buildCommandTable(
        [chat, { id: "notes", runtime: "terminal", terminalCommand: "notes" }],
        () => false
      )
    ).toEqual({
      commands: { chat: { clientId: "chat" }, notes: { clientId: "notes" } },
      rejected: [],
    });
  });

  it("never lets a client shadow a built-in command", () => {
    const builtIn = isBuiltInCommand(["remote", "fs"]);
    const table = buildCommandTable(
      [
        { id: "evil", runtime: "terminal", terminalCommand: "remote" },
        { id: "evil2", runtime: "terminal", terminalCommand: "open" },
        { id: "evil3", runtime: "terminal", terminalCommand: "fs" },
        chat,
      ],
      builtIn
    );
    expect(table.commands).toEqual({ chat: { clientId: "chat" } });
    expect(table.rejected.map((entry) => entry.command).sort()).toEqual(["fs", "open", "remote"]);
  });

  it("gives a name two clients claim to neither", () => {
    const table = buildCommandTable(
      [chat, { id: "other", runtime: "terminal", terminalCommand: "chat" }],
      () => false
    );
    expect(table.commands).toEqual({});
    expect(table.rejected).toHaveLength(2);
  });

  it("ignores clients of other runtimes", () => {
    const table = buildCommandTable(
      [{ id: "d", runtime: "web", terminalCommand: "chat" }],
      () => false
    );
    expect(table.commands).toEqual({});
  });
});

describe("shims", () => {
  it("links a shim, records it, and unlinks it", () => {
    const ctx = context();
    const { table } = syncClientIndex(ctx, [chat]);
    const file = linkClientShim(ctx, { name: "vchat", listing: chat, table });
    expect(file).toBe(path.join(ctx.directory, "vchat"));
    expect(fs.readFileSync(file, "utf8")).toContain('exec vibestudio chat "$@"');
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(ctx.state.read().shims).toEqual({ vchat: { clientId: "chat", command: "chat" } });
    expect(unlinkClientShim(ctx, "vchat")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(ctx.state.read().shims).toEqual({});
  });

  it("launches by id when the client has no command", () => {
    const ctx = context();
    const plain = { id: "notes", runtime: "terminal" as const };
    const { table } = syncClientIndex(ctx, [plain]);
    const file = linkClientShim(ctx, { name: "notes", listing: plain, table });
    expect(fs.readFileSync(file, "utf8")).toContain('exec vibestudio open notes "$@"');
  });

  it("refuses names that are built-in commands, malformed, or already taken by something else", () => {
    const ctx = context();
    const { table } = syncClientIndex(ctx, [chat]);
    expect(() => linkClientShim(ctx, { name: "open", listing: chat, table })).toThrow("built-in");
    expect(() => linkClientShim(ctx, { name: "remote", listing: chat, table })).toThrow("built-in");
    expect(() => linkClientShim(ctx, { name: "Bad Name", listing: chat, table })).toThrow("usable");
    fs.writeFileSync(path.join(ctx.directory, "taken"), "#!/bin/sh\necho mine\n");
    expect(() => linkClientShim(ctx, { name: "taken", listing: chat, table })).toThrow(
      "not written by vibestudio"
    );
    expect(fs.readFileSync(path.join(ctx.directory, "taken"), "utf8")).toContain("echo mine");
  });

  it("only unlinks shims it recorded, and never deletes a file it did not write", () => {
    const ctx = context();
    expect(() => unlinkClientShim(ctx, "vchat")).toThrow("not a shim this host created");
    const { table } = syncClientIndex(ctx, [chat]);
    const file = linkClientShim(ctx, { name: "vchat", listing: chat, table });
    fs.writeFileSync(file, "#!/bin/sh\necho replaced by the user\n");
    expect(unlinkClientShim(ctx, "vchat")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toContain("replaced by the user");
    expect(ctx.state.read().shims).toEqual({});
  });

  it("removes a shim when its client is no longer listed", () => {
    const ctx = context();
    const { table } = syncClientIndex(ctx, [chat]);
    const file = linkClientShim(ctx, { name: "vchat", listing: chat, table });
    const synced = syncClientIndex(ctx, []);
    expect(synced.removedShims).toEqual(["vchat"]);
    expect(fs.existsSync(file)).toBe(false);
    expect(ctx.state.read().shims).toEqual({});
    expect(ctx.state.read().commands).toEqual({});
  });

  it("rewrites a shim whose client changed its command", () => {
    const ctx = context();
    const { table } = syncClientIndex(ctx, [chat]);
    const file = linkClientShim(ctx, { name: "vchat", listing: chat, table });
    syncClientIndex(ctx, [{ ...chat, terminalCommand: "talk" }]);
    expect(fs.readFileSync(file, "utf8")).toContain('exec vibestudio talk "$@"');
    syncClientIndex(ctx, [{ id: "chat", runtime: "terminal" }]);
    expect(fs.readFileSync(file, "utf8")).toContain('exec vibestudio open chat "$@"');
    expect(ctx.state.read().shims["vchat"]).toEqual({ clientId: "chat", command: "open chat" });
  });
});

describe("development mode", () => {
  it("is a per-client, per-device host setting", () => {
    const ctx = context();
    expect(ctx.state.isDevelopment("chat")).toBe(false);
    ctx.state.setDevelopment("chat", true);
    expect(ctx.state.isDevelopment("chat")).toBe(true);
    expect(ctx.state.isDevelopment("other")).toBe(false);
    ctx.state.setDevelopment("chat", false);
    expect(ctx.state.isDevelopment("chat")).toBe(false);
  });
});

describe("client index for completions", () => {
  it("records terminal clients with their intents (open first) alongside the command table", () => {
    const ctx = context();
    syncClientIndex(ctx, [
      {
        ...chat,
        intents: [{ name: "ask", kind: "background", handler: "svc#ask" }],
      },
      { id: "web", runtime: "web" },
    ]);
    const data = ctx.state.read();
    expect(data.commands).toEqual({ chat: { clientId: "chat" } });
    expect(data.clients).toEqual({ chat: { intents: ["open", "ask"] } });
  });
});
