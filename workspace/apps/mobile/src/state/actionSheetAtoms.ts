/**
 * Action sheet state -- one app-wide themed bottom sheet replaces the native
 * Alert/ActionSheetIOS menus so every contextual menu looks the same on both
 * platforms and can carry icons + descriptions (discoverability).
 *
 * Push a config with `showActionSheetAtom`; `ActionSheetHost` (mounted once in
 * App) renders the top of the stack.
 */

import { atom } from "jotai";
import type { IconComponent } from "../design/icons";

export type ActionSheetTone = "default" | "danger" | "primary";

export interface ActionSheetItem {
  id: string;
  label: string;
  /** One-line explanation shown under the label. Keep it short. */
  description?: string;
  icon?: IconComponent;
  tone?: ActionSheetTone;
  disabled?: boolean;
  /** Marks the current selection (renders a check). */
  selected?: boolean;
}

export interface ActionSheetConfig {
  title?: string;
  subtitle?: string;
  items: ActionSheetItem[];
  onSelect: (id: string) => void;
  onDismiss?: () => void;
}

export const actionSheetAtom = atom<ActionSheetConfig | null>(null);

export const showActionSheetAtom = atom(null, (_get, set, config: ActionSheetConfig) => {
  set(actionSheetAtom, config);
});

export const dismissActionSheetAtom = atom(null, (get, set) => {
  const current = get(actionSheetAtom);
  set(actionSheetAtom, null);
  current?.onDismiss?.();
});
