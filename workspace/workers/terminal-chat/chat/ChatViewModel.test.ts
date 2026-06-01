import { describe, it, expect } from "vitest";
import { ChatViewModel } from "./ChatViewModel.js";
import type { HeadlessSession, ChatMessage } from "@workspace/agentic-session";

/** Minimal HeadlessSession stand-in exposing what ChatViewModel uses. */
function fakeSession(messages: ChatMessage[]): HeadlessSession {
  const listeners = new Set<(m: ChatMessage) => void>();
  return {
    get messages() {
      return messages;
    },
    get connected() {
      return true;
    },
    onMessage(listener: (m: ChatMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send() {
      return "id";
    },
    // not used by the view-model paths under test
  } as unknown as HeadlessSession;
}

function fakeRpc(handler?: (m: string, a: unknown[]) => unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    rpc: {
      async call<T>(_t: string, method: string, args: unknown[]): Promise<T> {
        calls.push({ method, args });
        return (handler?.(method, args) ?? undefined) as T;
      },
    },
  };
}

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  senderId: "s",
  content: "",
  ...over,
});

describe("ChatViewModel.view mapping", () => {
  it("maps user/agent/thinking/tool/approval messages to view roles", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u", senderId: "user", content: "hello", senderMetadata: { type: "panel", handle: "you" } }),
      msg({ id: "a", senderId: "agent", content: "hi", complete: false, senderMetadata: { type: "agent", handle: "ai-chat" } }),
      msg({ id: "t", senderId: "agent", content: "x", contentType: "thinking" }),
      msg({
        id: "i",
        senderId: "agent",
        content: "",
        invocation: { id: "i1", name: "bash", arguments: {}, execution: { status: "pending", description: "ls" } },
      }),
      msg({ id: "p", senderId: "agent", content: "", approval: { id: "ap", status: "requested", question: "Run rm?" } }),
    ];
    const { rpc } = fakeRpc();
    const vm = new ChatViewModel({ session: fakeSession(messages), rpc });
    const view = vm.view();
    expect(view.map((v) => v.role)).toEqual(["user", "agent", "thinking", "tool", "approval"]);
    expect(view[1]).toMatchObject({ role: "agent", streaming: true, sender: "ai-chat" });
    expect(view[3]?.text).toContain("bash");
    expect(view[4]?.text).toContain("Run rm?");
  });

  it("/help adds a notice without calling the agent", async () => {
    const { rpc, calls } = fakeRpc();
    const vm = new ChatViewModel({ session: fakeSession([]), rpc });
    await vm.submit("/help");
    expect(calls).toHaveLength(0);
    expect(vm.view().some((v) => v.text.includes("/agents"))).toBe(true);
  });

  it("/agents calls workers.listSources and lists them", async () => {
    const { rpc, calls } = fakeRpc((m) =>
      m === "workers.listSources" ? [{ name: "workers/agent-worker" }, { name: "workers/coder" }] : undefined,
    );
    const vm = new ChatViewModel({ session: fakeSession([]), rpc });
    await vm.submit("/agents");
    expect(calls[0]?.method).toBe("workers.listSources");
    expect(vm.view().some((v) => v.text.includes("workers/coder"))).toBe(true);
  });

  it("plain text is sent to the agent via session.send", async () => {
    let sent = "";
    const session = fakeSession([]);
    (session as unknown as { send: (t: string) => Promise<string> }).send = async (t) => {
      sent = t;
      return "id";
    };
    const { rpc } = fakeRpc();
    const vm = new ChatViewModel({ session, rpc });
    await vm.submit("hello there");
    expect(sent).toBe("hello there");
  });
});
