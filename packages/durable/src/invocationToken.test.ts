import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "@vibez1/rpc";
import { DurableObjectBase, rpc } from "./index.js";
import { createTestDO } from "./test-utils.js";

/**
 * `DurableObjectBase.invocationToken` — the host-minted on-behalf-of nonce for the
 * dispatch currently being served (narrow-host-vcs-plan §4). Verifies:
 *  - the token is visible to the handler for the dispatch that carried it;
 *  - it is `undefined` when the inbound call carried none;
 *  - two dispatches interleaved at an await point each observe THEIR OWN token
 *    (captured at handler entry), never the other's;
 *  - the token is never emitted into an error response.
 */

// A shared barrier the probe handlers park on so two dispatches are in flight
// simultaneously (interleaving at a real await point). Reset per test.
let barrierGate: Promise<void> = Promise.resolve();
let releaseBarrier: () => void = () => {};
function armBarrier(): void {
  barrierGate = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
}

class TokenProbeDO extends DurableObjectBase {
  protected createTables(): void {}

  /** Read the token synchronously at entry — the supported contract. */
  @rpc
  readToken(): string | null {
    return this.invocationToken ?? null;
  }

  /**
   * Capture the token at entry, park on the shared barrier (so a second dispatch
   * can run its prologue and clobber the mutable field), then report BOTH the
   * entry capture and a post-await read. Only the entry capture is contractually
   * the current dispatch's token.
   */
  @rpc
  async readTokenAcrossBarrier(): Promise<{ atEntry: string | null; afterAwait: string | null }> {
    const atEntry = this.invocationToken ?? null;
    await barrierGate;
    const afterAwait = this.invocationToken ?? null;
    return { atEntry, afterAwait };
  }

  /** Throws, so we can assert the token never leaks into an error response. */
  @rpc
  boom(): never {
    if (this.invocationToken) throw new Error("probe exploded while serving a dispatch");
    throw new Error("probe exploded");
  }
}

/** POST an `__rpc` request envelope carrying an optional invocation token. */
function postRpc(
  instance: unknown,
  method: string,
  args: unknown[],
  invocationToken?: string
): Promise<Response> {
  const fetchable = instance as { fetch(request: Request): Promise<Response> };
  const envelope: RpcEnvelope = {
    from: "do:server",
    target: "do-service:test:TokenProbeDO",
    delivery: { caller: { callerId: "do:gad-store", callerKind: "do" } },
    provenance: [],
    message: {
      type: "request",
      requestId: `req-${method}-${Math.random().toString(36).slice(2)}`,
      fromId: "do:server",
      method,
      args,
      ...(invocationToken !== undefined ? { invocationToken } : {}),
    },
  };
  return fetchable.fetch(
    new Request("http://test/test-key/__rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })
  );
}

async function resultOf<T = unknown>(res: Response): Promise<T> {
  const body = (await res.json()) as { message?: { result?: unknown; error?: string } };
  if (body.message && "error" in body.message && body.message.error) {
    throw new Error(body.message.error);
  }
  return body.message?.result as T;
}

/** Yield a macrotask so a delivered dispatch reaches its handler and parks. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DurableObjectBase.invocationToken", () => {
  it("surfaces the token to the handler for the dispatch that carried it", async () => {
    const { instance } = await createTestDO(TokenProbeDO);
    const res = await postRpc(instance, "readToken", [], "tok-abc123");
    expect(res.status).toBe(200);
    await expect(resultOf(res)).resolves.toBe("tok-abc123");
  });

  it("is undefined (surfaced as null here) when the dispatch carried no token", async () => {
    const { instance } = await createTestDO(TokenProbeDO);
    const res = await postRpc(instance, "readToken", []);
    expect(res.status).toBe(200);
    await expect(resultOf(res)).resolves.toBeNull();
  });

  it("gives two dispatches interleaved at an await point each their own token", async () => {
    const { instance } = await createTestDO(TokenProbeDO);
    armBarrier();

    // Dispatch A is delivered first (its own macrotask, as workerd delivers
    // separate requests): its handler enters, captures "tok-A", and parks.
    const pA = postRpc(instance, "readTokenAcrossBarrier", [], "tok-A");
    await macrotask();

    // Dispatch B is delivered while A is parked — its prologue rebinds the
    // per-dispatch field to "tok-B"; B's handler captures "tok-B" and parks too.
    const pB = postRpc(instance, "readTokenAcrossBarrier", [], "tok-B");
    await macrotask();

    // Both handlers are now suspended at the same await. Release them together.
    releaseBarrier();
    const [resA, resB] = await Promise.all([pA, pB]);
    const rA = await resultOf<{ atEntry: string | null; afterAwait: string | null }>(resA);
    const rB = await resultOf<{ atEntry: string | null; afterAwait: string | null }>(resB);

    // The contract: each dispatch's ENTRY capture is its own token, never the
    // other's — this is what P3 relies on (read at entry, thread downstream).
    expect(rA.atEntry).toBe("tok-A");
    expect(rB.atEntry).toBe("tok-B");
  });

  it("does not leak the token into an error response", async () => {
    const { instance } = await createTestDO(TokenProbeDO);
    const res = await postRpc(instance, "boom", [], "secret-tok-XYZ");
    expect(res.status).toBe(200); // __rpc always 200; the error rides the envelope
    const body = (await res.json()) as { message?: { error?: string } };
    expect(body.message?.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("secret-tok-XYZ");
  });
});
