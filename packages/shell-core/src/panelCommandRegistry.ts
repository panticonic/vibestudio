import type { RpcEventContext } from "@vibestudio/rpc";
import type { PaletteCommand } from "@vibestudio/shared/types";

export interface PanelCommandContribution {
  panelId: string;
  commands: PaletteCommand[];
}

function isPaletteCommand(value: unknown): value is PaletteCommand {
  const command = value as Partial<PaletteCommand> | null;
  return (
    !!command &&
    typeof command === "object" &&
    typeof command.id === "string" &&
    typeof command.label === "string" &&
    (command.hint === undefined || typeof command.hint === "string") &&
    (command.section === undefined || typeof command.section === "string")
  );
}

/**
 * Chrome-local registry for commands contributed by attributed panels/apps.
 * Native and desktop shells consume the same runtime event; only their
 * presentation differs (touch action sheet versus searchable palette).
 */
export class PanelCommandRegistry {
  private readonly contributions = new Map<string, PaletteCommand[]>();

  accept(event: Pick<RpcEventContext, "caller" | "payload">): boolean {
    if (event.caller.callerKind !== "panel" && event.caller.callerKind !== "app") return false;
    const commands = (event.payload as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(commands) || !commands.every(isPaletteCommand)) return false;

    const panelId = event.caller.callerPanelId ?? event.caller.callerId;
    if (commands.length === 0) this.contributions.delete(panelId);
    else this.contributions.set(panelId, commands);
    return true;
  }

  get(panelId: string): PaletteCommand[] {
    return this.contributions.get(panelId) ?? [];
  }

  list(focusedPanelId?: string | null): PanelCommandContribution[] {
    return [...this.contributions]
      .map(([panelId, commands]) => ({ panelId, commands }))
      .sort((a, b) => (a.panelId === focusedPanelId ? -1 : b.panelId === focusedPanelId ? 1 : 0));
  }

  clear(panelId?: string): void {
    if (panelId) this.contributions.delete(panelId);
    else this.contributions.clear();
  }
}
