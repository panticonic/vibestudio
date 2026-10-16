import {
  app,
  Menu,
  type BaseWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { z } from "zod";

/**
 * Client-contributed native menus (docs/client-hosts-and-clients-plan.md §5.1).
 *
 * The host owns no client UI. A client holding `native-menus` describes the
 * entries it wants as plain data; the host builds the Electron menu from it,
 * relays a click back to the client as an action id, and keeps only a minimal
 * role menu (Edit, Window, Quit) of its own. The same model serves the
 * application menu (macOS menu bar) and the popup that windows with a custom
 * titlebar open from their own menu button.
 */

const MENU_ROLES = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "pasteAndMatchStyle",
  "delete",
  "selectAll",
  "minimize",
  "zoom",
  "front",
] as const;

/** Electron accelerator syntax: modifiers joined by `+`, then one key. */
export const ACCELERATOR =
  /^(?:(?:CmdOrCtrl|CommandOrControl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)\+)*(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Enter|Return|Tab|Space|Backspace|Delete|Escape|Esc|Home|End|PageUp|PageDown|Plus|[`~!@#$%^&*()_=[\]{};:'",.<>/?\\|-])$/u;

export interface ClientMenuItem {
  /** Action id relayed to the client when the item is chosen. */
  id?: string;
  label?: string;
  accelerator?: string;
  /**
   * The chord belongs to the client no matter what has keyboard focus: the
   * host intercepts it before a panel page can consume it. Reserve it for
   * chords that get a person out of a misbehaving page.
   */
  chromeOwned?: boolean;
  enabled?: boolean;
  role?: (typeof MENU_ROLES)[number];
  separator?: true;
  submenu?: ClientMenuItem[];
}

export interface ClientMenuModel {
  /** Top-level menus of the application menu, between the host's Edit and Window menus. */
  menus: Array<{ label: string; items: ClientMenuItem[] }>;
  /** The popup opened from the client's own menu button. */
  popup?: ClientMenuItem[];
}

const MAX_ITEMS = 400;

const ItemSchema: z.ZodType<ClientMenuItem> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(128).optional(),
      label: z.string().min(1).max(120).optional(),
      accelerator: z.string().regex(ACCELERATOR).optional(),
      chromeOwned: z.boolean().optional(),
      enabled: z.boolean().optional(),
      role: z.enum(MENU_ROLES).optional(),
      separator: z.literal(true).optional(),
      submenu: z.array(ItemSchema).max(100).optional(),
    })
    .strict()
    .superRefine((item, ctx) => {
      const kinds = [item.separator === true, item.role !== undefined, item.label !== undefined];
      if (kinds.filter(Boolean).length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "A menu item is exactly one of: separator, role, or labelled entry",
        });
        return;
      }
      if (item.label !== undefined && (item.id === undefined) === (item.submenu === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "A labelled menu item has either an action id or a submenu",
        });
      }
      if (item.chromeOwned && !item.accelerator) {
        ctx.addIssue({ code: "custom", message: "A chrome-owned item needs an accelerator" });
      }
    })
);

export const ClientMenuModelSchema: z.ZodType<ClientMenuModel> = z
  .object({
    menus: z
      .array(
        z.object({ label: z.string().min(1).max(60), items: z.array(ItemSchema).max(200) }).strict()
      )
      .max(12),
    popup: z.array(ItemSchema).max(200).optional(),
  })
  .strict()
  .superRefine((model, ctx) => {
    let count = 0;
    const visit = (items: readonly ClientMenuItem[]): void => {
      for (const item of items) {
        count += 1;
        if (item.submenu) visit(item.submenu);
      }
    };
    for (const menu of model.menus) visit(menu.items);
    visit(model.popup ?? []);
    if (count > MAX_ITEMS) {
      ctx.addIssue({ code: "custom", message: `A client menu has at most ${MAX_ITEMS} entries` });
    }
  });

/** What a client contributes to the system tray: a tooltip and a menu. */
export interface ClientTrayModel {
  tooltip?: string;
  items: ClientMenuItem[];
}

export const ClientTrayModelSchema: z.ZodType<ClientTrayModel> = z
  .object({
    tooltip: z.string().max(120).optional(),
    items: z.array(ItemSchema).max(100),
  })
  .strict();

export function parseClientTrayModel(value: unknown): ClientTrayModel {
  return ClientTrayModelSchema.parse(value);
}

/** Validate what a renderer sent: a client's menu is untrusted input. */
export function parseClientMenuModel(value: unknown): ClientMenuModel {
  return ClientMenuModelSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Accelerators
// ---------------------------------------------------------------------------

export interface KeyInput {
  type?: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

interface ParsedAccelerator {
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  return: "enter",
  esc: "escape",
  space: " ",
  plus: "+",
};

export function parseAccelerator(
  accelerator: string,
  platform: NodeJS.Platform
): ParsedAccelerator {
  const parts = accelerator.split("+");
  // A trailing `+` is the key itself ("CmdOrCtrl++" is not valid Electron; "Plus" is).
  const rawKey = parts.pop() ?? "";
  const parsed: ParsedAccelerator = {
    key: "",
    control: false,
    shift: false,
    alt: false,
    meta: false,
  };
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case "cmdorctrl":
      case "commandorcontrol":
        if (platform === "darwin") parsed.meta = true;
        else parsed.control = true;
        break;
      case "cmd":
      case "command":
      case "super":
      case "meta":
        parsed.meta = true;
        break;
      case "ctrl":
      case "control":
        parsed.control = true;
        break;
      case "alt":
      case "option":
        parsed.alt = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
    }
  }
  const lower = rawKey.toLowerCase();
  parsed.key = NAMED_KEYS[lower] ?? lower;
  return parsed;
}

export function acceleratorMatches(
  accelerator: string,
  input: KeyInput,
  platform: NodeJS.Platform
): boolean {
  if (input.type !== undefined && input.type !== "keyDown") return false;
  const wanted = parseAccelerator(accelerator, platform);
  return (
    input.key.toLowerCase() === wanted.key &&
    input.control === wanted.control &&
    input.shift === wanted.shift &&
    input.alt === wanted.alt &&
    input.meta === wanted.meta
  );
}

/** Every chrome-owned item of a model, with its action id. */
export function chromeOwnedItems(
  model: ClientMenuModel | undefined
): Array<{ id: string; accelerator: string }> {
  if (!model) return [];
  const found: Array<{ id: string; accelerator: string }> = [];
  const visit = (items: readonly ClientMenuItem[]): void => {
    for (const item of items) {
      if (item.chromeOwned && item.id && item.accelerator) {
        found.push({ id: item.id, accelerator: item.accelerator });
      }
      if (item.submenu) visit(item.submenu);
    }
  };
  for (const menu of model.menus) visit(menu.items);
  visit(model.popup ?? []);
  return found;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function toElectron(
  items: readonly ClientMenuItem[],
  dispatch: (id: string) => void
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.separator) return { type: "separator" };
    if (item.role) {
      return {
        role: item.role,
        ...(item.label ? { label: item.label } : {}),
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      };
    }
    return {
      label: item.label!,
      ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      ...(item.enabled === false ? { enabled: false } : {}),
      ...(item.submenu
        ? { submenu: toElectron(item.submenu, dispatch) }
        : { click: () => dispatch(item.id!) }),
    };
  });
}

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

/**
 * The application menu: the host's role menus around the focused client's own.
 * The host keeps nothing of any client's UI, only what every Electron app has.
 */
export function buildApplicationMenuTemplate(
  model: ClientMenuModel | undefined,
  options: { platform: NodeJS.Platform; appName: string; dispatch: (id: string) => void }
): MenuItemConstructorOptions[] {
  const isMac = options.platform === "darwin";
  const redo = isMac ? "Cmd+Shift+Z" : "Ctrl+Shift+Z";
  return [
    ...(isMac
      ? [
          {
            label: options.appName,
            submenu: [
              { role: "about" },
              SEPARATOR,
              { role: "services" },
              SEPARATOR,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              SEPARATOR,
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { label: "Redo", accelerator: redo, role: "redo" },
        SEPARATOR,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" } as const] : []),
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    ...(model?.menus ?? []).map(
      (menu): MenuItemConstructorOptions => ({
        label: menu.label,
        submenu: toElectron(menu.items, options.dispatch),
      })
    ),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [SEPARATOR, { role: "front" } as const]
          : [SEPARATOR, { role: "quit" } as const]),
      ],
    },
  ];
}

/** The popup a client's own menu button opens, closed by the host's Exit entry. */
export function buildPopupTemplate(
  model: ClientMenuModel | undefined,
  dispatch: (id: string) => void
): MenuItemConstructorOptions[] {
  const items = toElectron(model?.popup ?? [], dispatch);
  return [
    ...items,
    ...(items.length > 0 ? [SEPARATOR] : []),
    { label: "Exit", accelerator: "CmdOrCtrl+Q", role: "quit" },
  ];
}

// ---------------------------------------------------------------------------
// Per-window state bound to Electron
// ---------------------------------------------------------------------------

export interface ChromeShortcuts {
  /** Install the key interception on a web contents of the window. */
  intercept(contents: WebContents): void;
  /** Whether this key event is a chord the window's client owns. */
  isChromeOwned(input: Electron.Input): boolean;
}

export interface ClientMenusDeps {
  /** Deliver a chosen item to the client window that contributed it. */
  deliver(windowId: string, actionId: string): void;
  platform?: NodeJS.Platform;
  appName?: string;
}

/**
 * The menus clients contributed, one model per window. The application menu
 * follows the focused window: a window's focus applies its own client's model.
 */
export class ClientMenus {
  private readonly models = new Map<string, ClientMenuModel>();
  private readonly intercepted = new WeakSet<WebContents>();
  private readonly platform: NodeJS.Platform;
  private readonly appName: string;

  constructor(private readonly deps: ClientMenusDeps) {
    this.platform = deps.platform ?? process.platform;
    this.appName = deps.appName ?? app.name;
  }

  set(windowId: string, model: ClientMenuModel): void {
    this.models.set(windowId, model);
  }

  clear(windowId: string): void {
    this.models.delete(windowId);
  }

  get(windowId: string): ClientMenuModel | undefined {
    return this.models.get(windowId);
  }

  /** Make the application menu show this window's client menu (the window just took focus). */
  applyFor(windowId: string): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate(this.models.get(windowId), {
          platform: this.platform,
          appName: this.appName,
          dispatch: (id) => this.deps.deliver(windowId, id),
        })
      )
    );
  }

  popup(windowId: string, window: BaseWindow, position: { x: number; y: number }): void {
    const menu = Menu.buildFromTemplate(
      buildPopupTemplate(this.models.get(windowId), (id) => this.deps.deliver(windowId, id))
    );
    menu.popup({ window, x: position.x, y: position.y });
  }

  /** The chrome-owned chords of one window, as the key interception both of its views needs. */
  shortcutsFor(windowId: string): ChromeShortcuts {
    const owned = (input: Electron.Input) =>
      chromeOwnedItems(this.models.get(windowId)).find((item) =>
        acceleratorMatches(item.accelerator, input, this.platform)
      );
    return {
      isChromeOwned: (input) => owned(input) !== undefined,
      intercept: (contents) => {
        if (this.intercepted.has(contents)) return;
        this.intercepted.add(contents);
        contents.on("before-input-event", (event, input) => {
          const item = owned(input);
          if (!item) return;
          event.preventDefault();
          this.deps.deliver(windowId, item.id);
        });
      },
    };
  }
}
