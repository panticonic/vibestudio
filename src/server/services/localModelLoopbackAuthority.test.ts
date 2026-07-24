import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { LocalModelLoopbackAuthority } from "./localModelLoopbackAuthority.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalModelLoopbackAuthority", () => {
  it("admits only the exact reviewed agent vessel, live port, and bearer", async () => {
    const root = fixtureRoot();
    const authority = new LocalModelLoopbackAuthority({ rootDir: root, pidAlive: () => true });
    const caller = agentCaller();

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(true);

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43118/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller: { ...caller, codeApproved: undefined },
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("https://example.test/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(false);
  });

  it("authorizes by sealed capability facts rather than a product class name", async () => {
    const root = fixtureRoot();
    const authority = new LocalModelLoopbackAuthority({ rootDir: root, pidAlive: () => true });
    const id = "do:workers/custom-agent:WorkspaceAgent:agent-1";
    const caller = {
      ...createVerifiedCaller(id, "do", {
        callerId: id,
        callerKind: "do",
        repoPath: "workers/custom-agent",
        effectiveVersion: "ev-custom",
        executionDigest: "b".repeat(64),
        requested: [
          {
            capability: "internal-model-runtime.use",
            resource: { kind: "exact" as const, key: "local-models" },
          },
        ],
      }),
      codeApproved: true as const,
    };

    await expect(
      authority.authorize({
        caller,
        targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
        method: "POST",
        headers: { Authorization: "Bearer loopback-secret" },
      })
    ).resolves.toBe(true);
  });

  it("fails closed for stale processes and unknown owner schemas", async () => {
    const root = fixtureRoot();
    const input = {
      caller: agentCaller(),
      targetUrl: new URL("http://127.0.0.1:43117/v1/chat/completions"),
      method: "POST",
      headers: { Authorization: "Bearer loopback-secret" },
    };
    await expect(
      new LocalModelLoopbackAuthority({ rootDir: root, pidAlive: () => false }).authorize(input)
    ).resolves.toBe(false);

    const owner = JSON.parse(readOwner(root)) as Record<string, unknown>;
    owner["unexpected"] = true;
    writeFileSync(join(root, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    await expect(
      new LocalModelLoopbackAuthority({ rootDir: root, pidAlive: () => true }).authorize(input)
    ).resolves.toBe(false);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vibestudio-local-model-authority-"));
  roots.push(root);
  writeFileSync(
    join(root, "owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      pid: 100,
      bootId: "boot",
      ports: { utility: 43117, main: 43118 },
      workspaceId: "ws-test",
      since: 1,
      serverPids: { utility: 101, main: 102 },
    }),
    { mode: 0o600 }
  );
  writeFileSync(join(root, "auth.key"), "loopback-secret\n", { mode: 0o600 });
  return root;
}

function readOwner(root: string): string {
  return readFileSync(join(root, "owner.json"), "utf8");
}

function agentCaller() {
  const id = "do:workers/agent-worker:AiChatWorker:agent-1";
  return {
    ...createVerifiedCaller(id, "do", {
      callerId: id,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "internal-model-runtime.use",
          resource: { kind: "exact", key: "local-models" },
        },
      ],
    }),
    codeApproved: true as const,
  };
}
