import { describe, expect, it, vi } from "vitest";
import { createHostAuthorityNextActionTool } from "./authority-next-action.js";

async function run(decision: "allowed" | "acquirable" | "denied") {
  const call = vi.fn(async () => ({
    decision,
    leaves:
      decision === "denied"
        ? [
            {
              capability: "external.open",
              resourceKey: "https://example.com",
              status: "denied",
              tier: "gated",
              failure: {
                reason: "The user denied this action.",
                remediation: { message: "Respect the user's decision." },
              },
            },
          ]
        : [],
    ...(decision === "acquirable"
      ? {
          wouldPrompt: {
            cardType: "permission.gated",
            renderedAction: "open example.com in your browser",
          },
        }
      : {}),
  }));
  const tool = createHostAuthorityNextActionTool(
    call as unknown as <T>(method: string, args: unknown[]) => Promise<T>
  );
  const result = await tool.execute("call-1", {
    service: "externalOpen",
    method: "open",
    args: ["https://example.com"],
  });
  return { call, text: result.content[0]?.type === "text" ? result.content[0].text : "" };
}

describe("host_authority_next_action", () => {
  it("turns an acquirable contract into an exact one-call instruction", async () => {
    const { call, text } = await run("acquirable");
    expect(call).toHaveBeenCalledWith("authority.preflight", [
      {
        service: "externalOpen",
        method: "open",
        args: ["https://example.com"],
      },
    ]);
    expect(text).toContain("ASKS FIRST");
    expect(text).toContain(
      'eval({ syntax: "typescript", code: "return await rpc.call(\\"main\\", \\"externalOpen.open\\", [\\"https://example.com\\"]);" })'
    );
    expect(text).toContain("Do not use ask_user");
    expect(text).toContain("Do not create another approval");
  });

  it("distinguishes ready and blocked actions", async () => {
    expect((await run("allowed")).text).toContain("READY");
    expect((await run("denied")).text).toContain("BLOCKED");
    expect((await run("denied")).text).toContain("Respect the user's decision");
  });

  it("accepts the native main target plus qualified RPC method coordinates", async () => {
    const call = vi.fn(async () => ({ decision: "allowed", leaves: [] }));
    const tool = createHostAuthorityNextActionTool(
      call as unknown as <T>(method: string, args: unknown[]) => Promise<T>
    );

    const result = await tool.execute("call-1", {
      service: "main",
      method: "permissions.list",
      args: [],
    });

    expect(call).toHaveBeenCalledWith("authority.preflight", [
      { service: "permissions", method: "list", args: [] },
    ]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        'eval({ syntax: "typescript", code: "return await rpc.call(\\"main\\", \\"permissions.list\\", []);" })'
      ),
    });
  });
});
