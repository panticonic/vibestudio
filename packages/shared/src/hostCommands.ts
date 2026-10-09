import type { RpcEnvelope, RpcEventContext } from "@vibestudio/rpc";

/**
 * A command contributed by hosted content to its owning application shell.
 * The contract describes intent; each host chooses an idiomatic presentation
 * such as the desktop command palette or a native mobile action sheet.
 */
export interface HostCommand {
  /** Stable id, unique within the contributing panel. */
  id: string;
  label: string;
  /** Optional supporting copy shown by hosts that have room for it. */
  description?: string;
  /** Optional grouping label, usually the contributing feature or panel. */
  group?: string;
  /**
   * Ordered arguments the host prompts for before running the command.
   * Omitted entirely by legacy contributions, which stay valid unchanged.
   */
  args?: HostCommandArg[];
  /**
   * Declarative availability: the command is offered only while the
   * contributing panel is the focused one. Functions cannot cross the wire, so
   * this is the only availability a contribution can express.
   */
  requiresFocus?: boolean;
  /** Destructive: hosts render it in their danger tone and never auto-run it. */
  danger?: boolean;
}

/** Argument types a serialized contribution may declare. */
export type HostCommandArgType = "string" | "enum" | "number" | "url";

/**
 * One declarative argument.
 *
 * There is no dynamic completion here on purpose: a contributed suggester would
 * be a function on the wire. Enum options are inline and static, and free text
 * is validated by `pattern` alone. If a real need for completion appears, the
 * follow-up is a round-trip event to the contributing panel — not a function.
 */
export interface HostCommandArg {
  name: string;
  /** Placeholder shown while the host prompts for this argument. */
  label: string;
  type: HostCommandArgType;
  /** Optional arguments are skippable; required ones block execution. */
  required: boolean;
  /** Inline, static option list. Only meaningful for `type: "enum"`. */
  options?: { value: string; label: string }[];
  /** Regular-expression source used to validate a free-text value. */
  pattern?: string;
}

export const HOST_COMMAND_CONTRIBUTION_EVENT = "runtime:host-command-contribution";
export const HOST_COMMAND_RUN_EVENT = "runtime:host-command-run";

/** Payload of {@link HOST_COMMAND_RUN_EVENT}. */
export interface HostCommandRunPayload {
  commandId: string;
}

/** The complete command set one panel slot currently contributes. */
export interface HostCommandContribution {
  panelId: string;
  commands: HostCommand[];
}

const ARG_TYPES = new Set<string>(["string", "enum", "number", "url"]);

function isArgOption(value: unknown): value is { value: string; label: string } {
  const option = value as Partial<{ value: string; label: string }> | null;
  return (
    !!option &&
    typeof option === "object" &&
    typeof option.value === "string" &&
    typeof option.label === "string"
  );
}

/**
 * Contributions arrive as serialized event payloads, so every field is
 * untrusted input rather than a typed call. A malformed argument invalidates
 * the whole contribution: a half-accepted command would prompt for something
 * the contributing panel cannot answer.
 */
function isHostCommandArg(value: unknown): value is HostCommandArg {
  const arg = value as Partial<HostCommandArg> | null;
  if (!arg || typeof arg !== "object") return false;
  if (typeof arg.name !== "string" || arg.name.length === 0) return false;
  if (typeof arg.label !== "string") return false;
  if (typeof arg.type !== "string" || !ARG_TYPES.has(arg.type)) return false;
  if (typeof arg.required !== "boolean") return false;
  if (
    arg.options !== undefined &&
    (!Array.isArray(arg.options) || !arg.options.every(isArgOption))
  ) {
    return false;
  }
  // A pattern that cannot compile would silently reject every value the user
  // types, so reject it here where the contributor can still be told why.
  if (arg.pattern !== undefined) {
    if (typeof arg.pattern !== "string") return false;
    try {
      new RegExp(arg.pattern, "u");
    } catch {
      return false;
    }
  }
  return true;
}

function isHostCommand(value: unknown): value is HostCommand {
  const command = value as Partial<HostCommand> | null;
  if (!command || typeof command !== "object") return false;
  if (typeof command.id !== "string" || typeof command.label !== "string") return false;
  if (command.description !== undefined && typeof command.description !== "string") return false;
  if (command.group !== undefined && typeof command.group !== "string") return false;
  if (command.requiresFocus !== undefined && typeof command.requiresFocus !== "boolean") {
    return false;
  }
  if (command.danger !== undefined && typeof command.danger !== "boolean") return false;
  if (command.args !== undefined) {
    if (!Array.isArray(command.args) || !command.args.every(isHostCommandArg)) return false;
    // Duplicate names would make the collected argument record lossy.
    const names = new Set(command.args.map((arg) => arg.name));
    if (names.size !== command.args.length) return false;
  }
  return true;
}

export interface HostCommandRegistryOptions {
  /**
   * Deliver {@link HOST_COMMAND_RUN_EVENT} to the live runtime in `panelId`'s
   * slot. This is the host's only transport duty; the panel performs the
   * action and every state and availability check.
   */
  dispatchRun(panelId: string, payload: HostCommandRunPayload): void | Promise<void>;
  /** Diagnostics for shell-local events the registry drops. */
  warn?(message: string): void;
}

/**
 * Host-side registry for panel-contributed commands. It owns every rule of the
 * panel-to-host contract so desktop and mobile hosts only render:
 *
 * - a contribution is attributed to the host-side slot that delivered it,
 *   never to a panel id in the payload;
 * - each contribution is that slot's complete command set and replaces the
 *   previous one atomically; an empty set clears it;
 * - only event envelopes reach the local shell; requests are rejected, and an
 *   unknown shell event is dropped locally with a diagnostic;
 * - running a command dispatches `{ commandId }` to the same slot.
 */
export interface HostCommandRegistry {
  /**
   * Accept one envelope a live panel slot addressed to `target: "shell"`.
   * `panelId` is the slot the host transport received it from. Throws for a
   * request or response: the local shell accepts events only.
   */
  deliverShellEnvelope(panelId: string, envelope: Pick<RpcEnvelope, "message">): void;
  /**
   * Accept a contribution event the host RPC layer delivered with an
   * authenticated caller. Only panel and app callers may contribute; the slot
   * is the caller's visible panel slot.
   */
  acceptRpcEvent(event: Pick<RpcEventContext, "caller" | "payload">): boolean;
  get(panelId: string): HostCommand[];
  /** Every slot's commands, the focused slot first. */
  list(focusedPanelId?: string | null): HostCommandContribution[];
  run(panelId: string, commandId: string): Promise<void>;
  /**
   * Forget a slot's commands when its panel navigates, closes, or loses its
   * runtime. Without an id, forget every slot (host teardown).
   */
  release(panelId?: string): void;
  /** Retire only contributions from this exact runtime incarnation. */
  releaseRuntime(runtimeEntityId: string): void;
  /** Observe contribution changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createHostCommandRegistry(
  options: HostCommandRegistryOptions
): HostCommandRegistry {
  const contributions = new Map<string, { commands: HostCommand[]; runtimeEntityId: string }>();
  const listeners = new Set<() => void>();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const accept = (panelId: string, payload: unknown, runtimeEntityId = panelId): boolean => {
    const commands = (payload as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(commands) || !commands.every(isHostCommand)) {
      warn(`[host-commands] Rejected malformed command contribution from ${panelId}`);
      return false;
    }
    if (commands.length === 0) {
      const current = contributions.get(panelId);
      if (!current || current.runtimeEntityId !== runtimeEntityId) return true;
      contributions.delete(panelId);
    } else {
      contributions.set(panelId, { commands, runtimeEntityId });
    }
    changed();
    return true;
  };

  return {
    deliverShellEnvelope(panelId, envelope) {
      const message = envelope.message;
      if (message.type !== "event") {
        throw new Error(`The local shell accepts events only (from ${panelId})`);
      }
      if (message.event !== HOST_COMMAND_CONTRIBUTION_EVENT) {
        warn(
          `[host-commands] Ignored unsupported local shell event ${message.event} from ${panelId}`
        );
        return;
      }
      accept(panelId, message.payload);
    },
    acceptRpcEvent(event) {
      const { caller } = event;
      if (caller.callerKind !== "panel" && caller.callerKind !== "app") return false;
      return accept(caller.callerPanelId ?? caller.callerId, event.payload, caller.callerId);
    },
    get(panelId) {
      return contributions.get(panelId)?.commands ?? [];
    },
    list(focusedPanelId) {
      return [...contributions]
        .map(([panelId, { commands }]) => ({ panelId, commands }))
        .sort((a, b) => (a.panelId === focusedPanelId ? -1 : b.panelId === focusedPanelId ? 1 : 0));
    },
    async run(panelId, commandId) {
      await options.dispatchRun(panelId, { commandId });
    },
    release(panelId) {
      if (panelId === undefined) {
        if (contributions.size === 0) return;
        contributions.clear();
      } else if (!contributions.delete(panelId)) {
        return;
      }
      changed();
    },
    releaseRuntime(runtimeEntityId) {
      let removed = false;
      for (const [slotId, contribution] of contributions) {
        if (contribution.runtimeEntityId === runtimeEntityId)
          removed = contributions.delete(slotId) || removed;
      }
      if (removed) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
