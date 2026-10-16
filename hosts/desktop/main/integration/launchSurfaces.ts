import type { ClientLaunchEntries } from "@vibestudio/client-host-core";
import { commandLine } from "./launcherArtifacts.js";

/**
 * The menus the OS shows for the app's icon, built from the clients' launch
 * entries (docs/client-hosts-and-clients-plan.md §4.7.5): the Dock menu on
 * macOS, the jump list on Windows. Pure data; the Electron objects are made
 * from it where they are applied.
 */

export interface DockMenuItem {
  label: string;
  link: string;
}

export type DockMenuSection =
  | { kind: "client"; clientId: string; title: string; items: DockMenuItem[] }
  | { kind: "open-windows"; items: Array<{ label: string; clientId: string }> };

/**
 * One section per client with something to launch, then the open client windows.
 * A client with only its `open` entry is a single item; with more, a submenu
 * under its title.
 */
export function buildDockMenu(
  clients: readonly ClientLaunchEntries[],
  openWindows: ReadonlyArray<{ clientId: string; title: string }>
): DockMenuSection[] {
  const sections: DockMenuSection[] = clients
    .filter((client) => client.entries.length > 0)
    .map((client) => ({
      kind: "client",
      clientId: client.clientId,
      title: client.title,
      items: client.entries.map((entry) => ({ label: entry.label, link: entry.link })),
    }));
  if (openWindows.length > 0) {
    sections.push({
      kind: "open-windows",
      items: openWindows.map((window) => ({ label: window.title, clientId: window.clientId })),
    });
  }
  return sections;
}

/** The structural subset of Electron's `JumpListCategory` this builds. */
export interface JumpListTask {
  type: "task";
  title: string;
  program: string;
  args: string;
  description: string;
  iconPath: string;
  iconIndex: number;
}

export interface JumpListCategoryData {
  type: "custom";
  name: string;
  items: JumpListTask[];
}

/**
 * `app.setJumpList` is process-wide, so intents of every client share the one
 * list, grouped by client. Each task starts this app with the link.
 */
export function buildJumpList(
  clients: readonly ClientLaunchEntries[],
  app: { command: readonly string[]; iconPath: string }
): JumpListCategoryData[] {
  const [program, ...prefix] = app.command;
  if (!program) throw new Error("The app has no command to launch");
  return clients
    .filter((client) => client.entries.length > 0)
    .map((client) => ({
      type: "custom",
      name: client.title,
      items: client.entries.map((entry) => ({
        type: "task",
        title: entry.label,
        program,
        args: commandLine([...prefix, entry.link]),
        description: entry.label,
        iconPath: app.iconPath,
        iconIndex: 0,
      })),
    }));
}
