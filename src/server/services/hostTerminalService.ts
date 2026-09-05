import {
  hostTerminalMethods,
  HOST_TERMINAL_CAPABILITY,
  HOST_TERMINAL_PREPARATION,
} from "@vibestudio/service-schemas/hostTerminal";
import {
  fixedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { NativeTerminalRegistry } from "./nativeTerminal.js";
import type { ContextIngestionRecorder } from "./contextIntegrityStore.js";
import { randomUUID } from "node:crypto";

/** Installed native-effect receiver. Its launch configuration is host-owned;
 * the RPC caller can neither choose an executable nor bypass the open approval. */
export function createHostTerminalService(deps: {
  workspaceId: string;
  host: string;
  shell: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  recordContextIngestion: ContextIngestionRecorder;
}): ServiceDefinition & { stop(): Promise<void> } {
  const terminals = new NativeTerminalRegistry();
  const sessions = new Map<string, { owner: string; connection: AbortSignal }>();
  const connections = new WeakMap<AbortSignal, string>();
  const pendingClosures = new Set<Promise<unknown>>();
  const closeTerminal = (id: string, identity: string) => {
    const closing = terminals.close(id, identity);
    pendingClosures.add(closing);
    void closing.then(
      () => pendingClosures.delete(closing),
      () => pendingClosures.delete(closing)
    );
    return closing;
  };
  let stopped = false;
  const owner = (ctx: ServiceContext): string => {
    const userId = verifiedInitiatingUserId(ctx);
    const connection = ctx.connectionSignal;
    if (stopped || ctx.signal?.aborted || !userId || !connection || connection.aborted)
      throw new Error("Host terminals require an authenticated user and live connection");
    let generation = connections.get(connection);
    if (!generation) {
      generation = randomUUID();
      connections.set(connection, generation);
      connection.addEventListener(
        "abort",
        () => {
          void retire([...sessions].filter(([, binding]) => binding.connection === connection));
        },
        { once: true }
      );
    }
    return JSON.stringify([
      deps.workspaceId,
      userId,
      generation,
      ctx.caller.runtime.id,
      ctx.caller.code?.executionDigest ?? null,
    ]);
  };
  const requireSession = (ctx: ServiceContext, id: string): string => {
    const identity = owner(ctx);
    if (sessions.get(id)?.owner !== identity)
      throw Object.assign(
        new Error("Host terminal does not belong to this caller and connection"),
        { code: "EACCES" }
      );
    terminals.assertOwner(id, identity);
    return identity;
  };
  const retire = async (
    selected: Array<[string, { owner: string; connection: AbortSignal }]>
  ): Promise<void> => {
    for (const [id] of selected) sessions.delete(id);
    const results = await Promise.allSettled(
      selected.map(([id, binding]) => closeTerminal(id, binding.owner))
    );
    for (const result of results) {
      if (result.status === "rejected") console.warn("Host terminal cleanup failed", result.reason);
      else if (!result.value.processExited)
        console.warn("Host terminal control retired; process exit unconfirmed");
    }
  };
  return {
    name: "hostTerminal",
    description:
      "Explicitly approved terminals with full host-user access outside workspace confinement",
    authority: { principals: ["user", "code"] },
    methods: hostTerminalMethods,
    authorityPreparation: {
      [HOST_TERMINAL_PREPARATION]: (ctx) => {
        const identity = owner(ctx);
        const resource = {
          type: "host-terminal",
          label: deps.host,
          value: `host-terminal:${deps.host}:${deps.workspaceId}`,
        };
        return {
          selections: [
            fixedPreparedAuthoritySelection({
              capability: HOST_TERMINAL_CAPABILITY,
              resourceKey: resource.value,
              challenge: {
                title: `Open a terminal with full access to ${deps.host}?`,
                description:
                  "This terminal runs outside the workspace sandbox. Commands can read or change your host files, credentials, processes, network and other workspaces. Closing it cannot undo changes or guarantee that background processes stop.",
                severity: "severe",
                deniedReason: "Full host terminal access was not approved",
                resource,
                operation: { kind: "unknown", verb: "Open host terminal", object: resource },
                details: [
                  { label: "Host", value: deps.host },
                  { label: "Workspace", value: deps.workspaceId },
                  { label: "Shell", value: deps.shell },
                  { label: "Initial directory", value: deps.cwd },
                  {
                    label: "Access",
                    value: "Full access as the app's OS user; no administrator elevation",
                  },
                ],
              },
            }),
          ],
          payload: { owner: identity },
        };
      },
    },
    handler: defineServiceHandler("hostTerminal", hostTerminalMethods, {
      open: (ctx, [dimensions]) => {
        const identity = owner(ctx);
        const prepared = ctx.preparedAuthority;
        if (
          prepared?.resolver !== HOST_TERMINAL_PREPARATION ||
          (prepared.payload as { owner?: unknown } | null)?.owner !== identity
        ) {
          throw new Error("Host terminal launch requires the dispatcher's approved prepared state");
        }
        const launched = terminals.launch({
          ownerSessionId: identity,
          executable: deps.shell,
          args: deps.args,
          cwd: deps.cwd,
          env: deps.environment,
          ...dimensions,
        });
        sessions.set(launched.terminalSessionId, {
          owner: identity,
          connection: ctx.connectionSignal!,
        });
        return {
          terminalSessionId: launched.terminalSessionId,
          host: deps.host,
          cwd: deps.cwd,
          shell: deps.shell,
        };
      },
      read: async (ctx, [input]) => {
        requireSession(ctx, input.terminalSessionId);
        const result = terminals.read(input);
        if (result.text)
          await deps.recordContextIngestion(ctx, {
            key: `host-terminal:${input.terminalSessionId}`,
            via: "host-terminal-read",
            classification: "external",
          });
        requireSession(ctx, input.terminalSessionId);
        return result;
      },
      write: (ctx, [input]) => {
        requireSession(ctx, input.terminalSessionId);
        terminals.write(input);
      },
      resize: (ctx, [input]) => {
        requireSession(ctx, input.terminalSessionId);
        terminals.resize(input);
      },
      close: (ctx, [input]) => {
        const identity = requireSession(ctx, input.terminalSessionId);
        sessions.delete(input.terminalSessionId);
        return closeTerminal(input.terminalSessionId, identity);
      },
    }),
    stop: async () => {
      stopped = true;
      await retire([...sessions]);
      await Promise.allSettled([...pendingClosures]);
    },
  };
}
