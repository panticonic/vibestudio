import { describe, it, expect } from "vitest";
import { VtSession } from "./VtSession.js";
import { classifyChord, parseNavKey } from "./inputRouter.js";
import { SessionManager, type RpcLike } from "./SessionManager.js";
import { registerHostService } from "./HostService.js";
import { encodeFrame, HOST_METHODS, SESSION_METHODS } from "@workspace/terminal-host-protocol";
import type { RpcBridge } from "@natstack/rpc";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("VtSession compositing", () => {
  it("emulates worker bytes into a trimmed grid (convertEol fixes LF drift)", async () => {
    const vt = new VtSession({ columns: 20, rows: 4 });
    await vt.write(enc("hello\nworld"));
    const rows = vt.grid();
    expect(rows[0]).toBe("hello");
    expect(rows[1]).toBe("world");
    vt.dispose();
  });

  it("applies relative-cursor redraws (Ink-style) correctly", async () => {
    const vt = new VtSession({ columns: 20, rows: 3 });
    await vt.write(enc("count = 1\n"));
    // Ink redraw: erase line, cursor up, rewrite.
    await vt.write(enc("\x1b[2K\x1b[1Acount = 2\n"));
    expect(vt.grid()[0]).toBe("count = 2");
    vt.dispose();
  });

  it("preserves color + attributes as styled runs", async () => {
    const vt = new VtSession({ columns: 20, rows: 2 });
    // bold red "ERR", reset, plain " ok"
    await vt.write(enc("\x1b[1;31mERR\x1b[0m ok"));
    const row = vt.styledGrid()[0]!;
    const errRun = row.find((r) => r.text.includes("ERR"));
    expect(errRun).toMatchObject({ fg: "red", bold: true });
    const okRun = row.find((r) => r.text.includes("ok"));
    expect(okRun?.bold).toBe(false);
    expect(okRun?.fg).toBeUndefined(); // default fg
    vt.dispose();
  });

  it("maps 256-palette + RGB colors to hex", async () => {
    const vt = new VtSession({ columns: 20, rows: 2 });
    await vt.write(enc("\x1b[38;2;18;52;86mRGB\x1b[0m")); // truecolor #123456
    const run = vt.styledGrid()[0]!.find((r) => r.text.includes("RGB"));
    expect(run?.fg).toBe("#123456");
    vt.dispose();
  });
});

describe("inputRouter", () => {
  it("classifies single control bytes as host chords", () => {
    expect(classifyChord(new Uint8Array([0x10]))).toBe("switcher");
    expect(classifyChord(new Uint8Array([0x01]))).toBe("approvals");
    expect(classifyChord(new Uint8Array([0x0c]))).toBe("logs");
    expect(classifyChord(new Uint8Array([0x0e]))).toBe("new");
    expect(classifyChord(new Uint8Array([0x11]))).toBe("quit");
    expect(classifyChord(new Uint8Array([0x1b]))).toBe("escape");
  });
  it("does not treat multi-byte sequences (arrows, text) as chords", () => {
    expect(classifyChord(enc("\x1b[A"))).toBeNull();
    expect(classifyChord(enc("hi"))).toBeNull();
  });
  it("parses overlay navigation keys", () => {
    expect(parseNavKey(enc("\x1b[A"))).toBe("up");
    expect(parseNavKey(enc("\x1b[B"))).toBe("down");
    expect(parseNavKey(new Uint8Array([0x0d]))).toBe("enter");
    expect(parseNavKey(new Uint8Array([0x1b]))).toBe("escape");
    expect(parseNavKey(enc("3"))).toEqual({ digit: 3 });
    expect(parseNavKey(enc("n"))).toEqual({ char: "n" });
  });
});

function fakeRpc(): { rpc: RpcLike; calls: Array<{ target: string; method: string; args: unknown[] }> } {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
  const rpc: RpcLike = {
    async call<T>(target: string, method: string, args: unknown[]): Promise<T> {
      calls.push({ target, method, args });
      if (method === "runtime.createEntity") return { targetId: "do:term:1" } as T;
      return undefined as T;
    },
  };
  return { rpc, calls };
}

describe("SessionManager", () => {
  const viewport = { columns: 40, rows: 6 };

  it("spawns a session via createEntity + startSession and focuses it", async () => {
    const { rpc, calls } = fakeRpc();
    const sm = new SessionManager({ rpc, hostPrincipalId: "app:host", viewport });
    const record = await sm.open({ source: "workers/terminal-chat", className: "TerminalChatWorker", title: "Chat" });
    expect(record.status).toBe("running");
    expect(calls[0]?.method).toBe("runtime.createEntity");
    expect(calls[1]?.method).toBe(SESSION_METHODS.start);
    expect((calls[1]?.args[0] as { hostPrincipalId: string }).hostPrincipalId).toBe("app:host");
    expect(sm.focused()?.sessionId).toBe(record.sessionId);
  });

  it("writes ordered frames into the session VT and drops stale seq", async () => {
    const { rpc } = fakeRpc();
    const sm = new SessionManager({ rpc, hostPrincipalId: "app:host", viewport });
    const r = await sm.open({ source: "s", className: "C", title: "T" });
    await sm.onFrame(encodeFrame(r.sessionId, "stdout", enc("line A\n"), 0));
    await sm.onFrame(encodeFrame(r.sessionId, "stdout", enc("STALE\n"), 0)); // dup seq dropped
    await sm.onFrame(encodeFrame(r.sessionId, "stdout", enc("line B\n"), 1));
    const rows = r.vt.grid();
    expect(rows[0]).toBe("line A");
    expect(rows[1]).toBe("line B");
  });

  it("routes input to the focused session", async () => {
    const { rpc, calls } = fakeRpc();
    const sm = new SessionManager({ rpc, hostPrincipalId: "app:host", viewport });
    const r = await sm.open({ source: "s", className: "C", title: "T" });
    calls.length = 0;
    await sm.sendInput(enc("x"));
    expect(calls[0]).toMatchObject({ target: r.targetId, method: SESSION_METHODS.onInput });
  });

  it("closes a session and clears focus", async () => {
    const { rpc } = fakeRpc();
    const sm = new SessionManager({ rpc, hostPrincipalId: "app:host", viewport });
    const r = await sm.open({ source: "s", className: "C", title: "T" });
    await sm.close(r.sessionId);
    expect(sm.list()).toHaveLength(0);
    expect(sm.focused()).toBeNull();
  });
});

describe("HostService caller ownership", () => {
  function setup() {
    type Ctx = { callerId: string; callerKind: string };
    const handlers = new Map<string, (ctx: Ctx, ...a: unknown[]) => unknown>();
    const bridge = {
      exposeMethodWithCaller: (m: string, h: (ctx: Ctx, ...a: unknown[]) => unknown) =>
        handlers.set(m, h),
    } as unknown as RpcBridge;
    const { rpc } = fakeRpc(); // createEntity → targetId "do:term:1"
    const sessions = new SessionManager({ rpc, hostPrincipalId: "app:host", viewport: { columns: 40, rows: 6 } });
    const rejected: Array<{ method: string; caller: string; session: string }> = [];
    registerHostService(bridge, {
      sessions,
      setRealRawMode: () => {},
      isOverlayOpen: () => false,
      onRejected: (method, caller, session) => rejected.push({ method, caller, session }),
    });
    return { handlers, sessions, rejected };
  }

  it("authorizes by strict owner-match, accepts the trusted gateway relay, rejects others", async () => {
    const { handlers, sessions, rejected } = setup();
    const rec = await sessions.open({ source: "s", className: "C", title: "T" });
    expect(sessions.ownerOf(rec.sessionId)).toBe("do:term:1"); // the worker's principal

    const onFrame = handlers.get(HOST_METHODS.onFrame)!;
    const frame = encodeFrame(rec.sessionId, "stdout", new TextEncoder().encode("hi\n"), 0);

    // An unrelated principal (e.g. a panel) → rejected, nothing applied.
    onFrame({ callerId: "panel:evil", callerKind: "panel" }, frame);
    expect(rejected).toEqual([
      { method: HOST_METHODS.onFrame, caller: "panel:evil", session: rec.sessionId },
    ]);

    // Strict owner → accepted.
    onFrame({ callerId: "do:term:1", callerKind: "do" }, frame);
    // Trusted gateway relay (today's DO path, caller collapsed to "main") → accepted.
    onFrame({ callerId: "main", callerKind: "server" }, frame);
    expect(rejected).toHaveLength(1); // only the panel was rejected

    // Apply a fresh-seq frame directly (await the async VT write) for the grid assertion.
    await sessions.onFrame(encodeFrame(rec.sessionId, "stdout", new TextEncoder().encode("hi\n"), 10));
    expect(rec.vt.grid()[0]).toBe("hi");
  });

  it("rejects setRawMode from an unrelated principal", () => {
    const { handlers, rejected } = setup();
    const setRaw = handlers.get(HOST_METHODS.setRawMode)! as (
      ctx: { callerId: string; callerKind: string },
      sessionId: string,
      enabled: boolean,
    ) => { ok: boolean; reason?: string };
    const result = setRaw({ callerId: "panel:evil", callerKind: "panel" }, "term-x", true);
    expect(result).toEqual({ ok: false, reason: "not-authorized" });
    expect(rejected.some((r) => r.method === HOST_METHODS.setRawMode)).toBe(true);
  });
});
