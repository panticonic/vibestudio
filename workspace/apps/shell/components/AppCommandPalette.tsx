import { useCallback, useEffect, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import { Kbd, Flex, Text } from "@radix-ui/themes";
import { CommandPalette, type CommandItem } from "@workspace/ui";
import { setThemeModeAtom, setThemeConfigAtom } from "../state/themeAtoms";
import { workspaceChooserDialogOpenAtom } from "../state/appModeAtoms";
import { panel, palette } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import { useShellOverlay } from "../shell/useShellOverlay";

/** Accent swatches offered as quick theme commands (mirrors ThemeSettings). */
const ACCENTS = [
  "violet",
  "pink",
  "iris",
  "blue",
  "cyan",
  "grass",
  "tomato",
  "amber",
  "gray",
] as const;

type PaletteAction =
  | { kind: "global"; run: () => void | Promise<void> }
  | { kind: "panel"; panelId: string; commandId: string };

type PanelContribution = {
  panelId: string;
  commands: { id: string; label: string; hint?: string; section?: string }[];
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The single app-level command palette (Cmd/Ctrl+K). Shows GLOBAL shell
 * commands (run locally) plus the commands each panel contributes over the
 * runtime bridge (`palette.list()`), dispatching a chosen panel command back to
 * its owner (`palette.run()`).
 *
 * NOTE: the window `keydown` reaches the shell only while shell chrome is
 * focused; a menu accelerator emitting `open-command-palette` (wired in
 * useShellEvent below) covers the case where a panel iframe holds focus.
 */
export function AppCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [contributions, setContributions] = useState<PanelContribution[]>([]);
  useShellOverlay(open);

  const setThemeMode = useSetAtom(setThemeModeAtom);
  // The persisting action atom — writes localStorage so accent survives reload
  // (the raw themeConfigAtom applies live but is NOT persisted; mode already
  // uses its action atom above). Takes a patch and merges internally.
  const setThemeConfig = useSetAtom(setThemeConfigAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  // In Electron the `CmdOrCtrl+K` menu accelerator fires `open-command-palette`
  // app-globally (even when a panel iframe holds focus) and consumes the key, so
  // the menu is the source of truth there. The window keydown is the standalone
  // (no-menu) fallback — gated off when the Electron bridge is present to avoid
  // a double toggle.
  const openPalette = useCallback(() => setOpen(true), []);
  useShellEvent("open-command-palette", openPalette);

  useEffect(() => {
    const electron = (globalThis as { __vibestudioApp?: unknown }).__vibestudioApp;
    if (electron) return; // menu accelerator handles it
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "k" || e.key === "K")
      ) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pull the focused/contributing panels' commands each time we open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    let live = true;
    void palette
      .list()
      .then((list) => {
        if (live) setContributions(list as PanelContribution[]);
      })
      .catch(() => {
        if (live) setContributions([]);
      });
    return () => {
      live = false;
    };
  }, [open]);

  const globalItems = useMemo<CommandItem<PaletteAction>[]>(() => {
    const items: CommandItem<PaletteAction>[] = [
      {
        id: "appearance:light",
        label: "Appearance: Light",
        section: "Appearance",
        value: { kind: "global", run: () => setThemeMode("light") },
      },
      {
        id: "appearance:dark",
        label: "Appearance: Dark",
        section: "Appearance",
        value: { kind: "global", run: () => setThemeMode("dark") },
      },
      {
        id: "appearance:system",
        label: "Appearance: System",
        section: "Appearance",
        value: { kind: "global", run: () => setThemeMode("system") },
      },
      ...ACCENTS.map((accent) => ({
        id: `accent:${accent}`,
        label: `Accent: ${cap(accent)}`,
        section: "Theme",
        value: { kind: "global" as const, run: () => setThemeConfig({ accentColor: accent }) },
      })),
      {
        id: "workspace:switch",
        label: "Switch workspace…",
        section: "Workspace",
        value: { kind: "global", run: () => setWorkspaceChooserOpen(true) },
      },
      {
        id: "panel:reload",
        label: "Reload current panel",
        section: "Panel",
        value: {
          kind: "global",
          run: async () => {
            const id = await panel.getFocusedPanelId();
            if (id) await panel.reload(id);
          },
        },
      },
      {
        id: "panel:devtools",
        label: "Open panel devtools",
        section: "Panel",
        value: {
          kind: "global",
          run: async () => {
            const id = await panel.getFocusedPanelId();
            if (id) await panel.openDevTools(id);
          },
        },
      },
    ];
    return items;
  }, [setThemeMode, setThemeConfig, setWorkspaceChooserOpen]);

  const panelItems = useMemo<CommandItem<PaletteAction>[]>(
    () =>
      contributions.flatMap((contribution) =>
        contribution.commands.map((command) => ({
          id: `${contribution.panelId}:${command.id}`,
          label: command.label,
          hint: command.hint,
          section: command.section ?? "Panel",
          value: { kind: "panel" as const, panelId: contribution.panelId, commandId: command.id },
        }))
      ),
    [contributions]
  );

  const items = useMemo(() => {
    const all = [...globalItems, ...panelItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.hint?.toLowerCase().includes(q) ||
        item.section?.toLowerCase().includes(q)
    );
  }, [globalItems, panelItems, query]);

  const onSelect = useCallback((item: CommandItem<PaletteAction>) => {
    const action = item.value;
    if (action?.kind === "global") void action.run();
    else if (action?.kind === "panel") void palette.run(action.panelId, action.commandId);
    setOpen(false);
    setQuery("");
  }, []);

  return (
    <CommandPalette<PaletteAction>
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      items={items}
      onSelect={onSelect}
      placeholder="Search commands…"
      footer={
        <Flex align="center" gap="2">
          <Text size="1" color="gray">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> run · <Kbd>Esc</Kbd> close
          </Text>
        </Flex>
      }
    />
  );
}
