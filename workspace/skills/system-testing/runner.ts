import { HeadlessSession } from "@workspace/agentic-session";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { gad, rpc } from "@workspace/runtime";

// This runner is eval'd server-side (in the orchestrating agent's EvalDO), so it
// uses the portable client surface — NOT panel-only `getStateArgs`/`slotId`.
// `rpc.selfId` is the stable runtime id, used as the channel-membership clientId.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export const SYSTEM_TEST_AGENT_PROMPT = `You are running inside an automated Vibez1 system test.

Your job is to exercise the documented path honestly, not to make the test pass by inventing workarounds.

When a task depends on Vibez1 behavior, use the relevant docs or skill files to choose the most straightforward supported approach.

If that documented approach fails, stop and report what happened. Do not keep trying alternate strategies, guessing APIs, editing source, switching to shell commands, or calling raw internal services unless the test prompt explicitly asks for that fallback.

When reporting a failure, include the docs or skill files you used, the operation you attempted, the exact error or unexpected result, and the mismatch between the docs and reality.

Use file-loaded eval for substantive multi-line or multi-file eval work. Do not create or edit helper files merely to work around a short documented suite-orchestration eval snippet. If an operation fails, report the error you actually observed, verbatim, with the operation that produced it.

Keep evidence bounded. Report summaries, counts, ids, byte lengths, exact error messages, the final agent message, the validation reason, and the relevant tool call statuses/errors. Do not paste large raw payloads, full database rows, full channel envelopes, image data, or secrets.

Every final response should be concise, include the requested marker tokens exactly when applicable, and mention any problems encountered while setting up or running the test. Never just refer to files or artifacts; describe what the evidence shows and include the concrete mismatch/error in the response.`;

export class HeadlessRunner {
  private contextId: string;
  private model: string | undefined;

  /**
   * `model` is the model spawned test agents should inherit — the orchestrating
   * agent reads its OWN model from eval (`(await agent.describe()).config.model`)
   * and passes it here. Model is per-agent, so each spawned headless agent is
   * created with it as its initial config (via creation stateArgs).
   */
  constructor(contextId: string, opts?: { model?: string }) {
    this.contextId = contextId;
    this.model = opts?.model;
  }

  /**
   * Spawn a headless session bound to this panel.
   *
   * The test agent's eval executes server-side in the agent's own EvalDO. The
   * agent uses the standard Vibez1 chat prompt and tool surface; panel/UI
   * tools like inline_ui and feedback_form are simply absent because no panel
   * is connected to this headless session. Tests that specifically exercise
   * UI-tool selection may opt into synthetic panel UI methods; those publish
   * the same typed channel events but do not mount browser renderers.
   *
   * Per-test prompt overrides can be passed through spawn extraConfig as
   * `systemPrompt` and `systemPromptMode`.
   */
  async spawn(opts?: {
    source?: string;
    className?: string;
    /**
     * System tests default to isolated agent contexts so VCS state cannot leak
     * across tests or through the orchestrating panel. Use "parent" only when a
     * test explicitly needs the orchestrator's context.
     */
    context?: "isolated" | "parent";
    /**
     * Test-only harness mode: advertise panel-local UI methods from the
     * headless client so spawned agents can exercise inline_ui/action-bar tool
     * calls and typed UI event publication without a browser panel.
     */
    syntheticPanelUiTools?: boolean;
  }): Promise<HeadlessSession> {
    return HeadlessSession.createWithAgent({
      config: {
        clientId: rpc.selfId,
        rpc: rpcConfig,
      },
      rpcCall: (t: string, m: string, args: unknown[]) => rpcConfig.call(t, m, args),
      source: opts?.source ?? "workers/agent-worker",
      className: opts?.className ?? "AiChatWorker",
      ...(opts?.context === "parent" ? { contextId: this.contextId } : {}),
      includeSyntheticPanelUiMethods: opts?.syntheticPanelUiTools === true,
      // The model rides the spawned agent's CREATION config (per-agent, seeded
      // from stateArgs.agentConfig) so it inherits the orchestrator's model.
      extraConfig: {
        systemPrompt: SYSTEM_TEST_AGENT_PROMPT,
        systemPromptMode: "append",
        ...(this.model ? { model: this.model } : {}),
      },
    });
  }

  async collectDiagnostics(opts?: {
    channelId?: string | null;
    branchId?: string | null;
    error?: unknown;
  }): Promise<Record<string, unknown>> {
    const channelId = opts?.channelId ?? null;
    const diagnostics: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      contextId: this.contextId,
      channelId,
      error: opts?.error instanceof Error ? opts.error.message : opts?.error ? String(opts.error) : null,
    };
    try {
      diagnostics["buildProvenance"] = await rpc.call("main", "build.inspectBuildProvenance", [
        "@workspace-skills/system-testing",
      ]);
    } catch (err) {
      diagnostics["buildProvenanceError"] = err instanceof Error ? err.message : String(err);
    }
    if (channelId) {
      try {
        diagnostics["agentHealth"] = await gad.inspectAgentHealth({
          channelId,
          branchId: opts?.branchId,
          limit: 50,
          envelopeLimit: 25,
          storageLimit: 25,
        });
      } catch (err) {
        diagnostics["agentHealthError"] = err instanceof Error ? err.message : String(err);
      }
    }
    return diagnostics;
  }
}
