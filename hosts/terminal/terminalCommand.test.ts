import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import {
  clientCommandFor,
  createClientsCommands,
  createOpenCommand,
  createTerminalCommand,
  isTerminalCancellation,
  retireServer,
} from "./terminalCommand.js";
import { TerminalHostState } from "./hostState.js";
import { isBuiltInCommand } from "./clientShims.js";
import type { LocalServer } from "./localServer.js";

describe("terminal command retirement", () => {
  it("recognizes the original cancellation through a causal startup wrapper", () => {
    const owner = new AbortController();
    const reason = new Error("user interrupted");
    owner.abort(reason);
    expect(
      isTerminalCancellation(new Error("startup stopped", { cause: reason }), owner.signal)
    ).toBe(true);
  });

  it("does not hide earlier operation or cleanup failures behind a later cancellation", () => {
    const owner = new AbortController();
    const reason = new Error("user interrupted");
    const failure = new Error("socket failed to retire");
    owner.abort(reason);
    expect(isTerminalCancellation(failure, owner.signal)).toBe(false);
    expect(isTerminalCancellation(new AggregateError([reason, failure]), owner.signal)).toBe(false);
  });
  it("rejects a failed server join instead of leaving a successful return code", async () => {
    const original = new Error("owned process did not retire");
    const server: LocalServer = {
      ready: {},
      pid: 123,
      retained: false,
      logFile: "/private/server.log",
      exited: Promise.resolve("closed"),
      stop: vi.fn(async () => {
        throw original;
      }),
    };
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(retireServer(server, (line) => messages.push(line))).rejects.toMatchObject({
        cause: original,
      });
      expect(messages).not.toContain("Local server stopped.");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("client commands", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  function context() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-command-test-"));
    roots.push(root);
    const hostState = new TerminalHostState(path.join(root, "host.json"));
    return {
      appRoot: root,
      hostVersion: "1.0.0",
      isBuiltIn: isBuiltInCommand(["terminal", "open", "clients", "remote"]),
      hostState,
    };
  }

  it("registers vibestudio <command> from the host's table", () => {
    const ctx = context();
    ctx.hostState.setCommands({ chat: { clientId: "chat" } });
    const command = clientCommandFor("chat", ctx);
    expect(command).toMatchObject({ group: "chat", name: "" });
    expect(command!.flags!.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(["param", "develop", "workspace", "yes"])
    );
    expect(clientCommandFor("unknown", ctx)).toBeNull();
  });

  it("never lets a client command shadow a built-in, even from a stale table", () => {
    const ctx = context();
    ctx.hostState.setCommands({ open: { clientId: "evil" }, remote: { clientId: "evil" } });
    expect(clientCommandFor("open", ctx)).toBeNull();
    expect(clientCommandFor("remote", ctx)).toBeNull();
  });

  it("defines the host's own commands", () => {
    const ctx = context();
    expect(createTerminalCommand(ctx)).toMatchObject({ group: "terminal", name: "" });
    expect(createOpenCommand(ctx)).toMatchObject({ group: "open", name: "" });
    expect(createClientsCommands(ctx).map((command) => `${command.group} ${command.name}`)).toEqual(
      ["clients list", "clients link", "clients unlink"]
    );
  });

  it("opens a client by id only when one is named", async () => {
    const ctx = context();
    const stderr = vi.spyOn(console, "error").mockReturnValue();
    try {
      await expect(
        createOpenCommand(ctx).run({ positionals: [], flags: {}, flagsMulti: () => [] }, [])
      ).resolves.toBe(2);
      expect(stderr.mock.calls.join("")).toContain("Name the client to open");
    } finally {
      stderr.mockRestore();
    }
  });

  it("unlinks without a server, and only what was linked", async () => {
    const ctx = context();
    const stderr = vi.spyOn(console, "error").mockReturnValue();
    try {
      await expect(
        createClientsCommands(ctx)[2]!.run(
          { positionals: ["nothing"], flags: {}, flagsMulti: () => [] },
          []
        )
      ).resolves.toBe(2);
      expect(stderr.mock.calls.join("")).toContain("not a shim this host created");
    } finally {
      stderr.mockRestore();
    }
  });
});
