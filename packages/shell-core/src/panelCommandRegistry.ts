import type { RpcEventContext } from "@vibestudio/rpc";
import type { HostCommand } from "@vibestudio/shared/hostCommands";

export interface HostCommandContribution {
  panelId: string;
  commands: HostCommand[];
}

function isHostCommand(value: unknown): value is HostCommand {
  const command = value as Partial<HostCommand> | null;
  return (
    !!command &&
    typeof command === "object" &&
    typeof command.id === "string" &&
    typeof command.label === "string" &&
    (command.description === undefined || typeof command.description === "string") &&
    (command.group === undefined || typeof command.group === "string")
  );
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
