import type { RpcEventContext } from "@vibestudio/rpc";
import type { HostCommand, HostCommandArg } from "@vibestudio/shared/hostCommands";

export interface HostCommandContribution {
  panelId: string;
  commands: HostCommand[];
}

const ARG_TYPES = new Set(["string", "enum", "number", "url"]);

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
  if (arg.options !== undefined && (!Array.isArray(arg.options) || !arg.options.every(isArgOption))) {
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

/**
 * Chrome-local registry for commands contributed by attributed panels/apps.
 * Native and desktop shells consume the same runtime event; only their
 * presentation differs (touch action sheet versus searchable palette).
 */
export class HostCommandRegistry {
  private readonly contributions = new Map<string, HostCommand[]>();

  accept(event: Pick<RpcEventContext, "caller" | "payload">): boolean {
    if (event.caller.callerKind !== "panel" && event.caller.callerKind !== "app") return false;
    const commands = (event.payload as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(commands) || !commands.every(isHostCommand)) return false;

    const panelId = event.caller.callerPanelId ?? event.caller.callerId;
    if (commands.length === 0) this.contributions.delete(panelId);
    else this.contributions.set(panelId, commands);
    return true;
  }

  get(panelId: string): HostCommand[] {
    return this.contributions.get(panelId) ?? [];
  }

  list(focusedPanelId?: string | null): HostCommandContribution[] {
    return [...this.contributions]
      .map(([panelId, commands]) => ({ panelId, commands }))
      .sort((a, b) => (a.panelId === focusedPanelId ? -1 : b.panelId === focusedPanelId ? 1 : 0));
  }

  clear(panelId?: string): void {
    if (panelId) this.contributions.delete(panelId);
    else this.contributions.clear();
  }
}
