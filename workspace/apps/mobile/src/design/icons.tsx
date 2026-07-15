/**
 * Central icon registry. lucide-react-native is optional at runtime (the OTA
 * bundle may predate the dependency), so every icon degrades to a text glyph.
 * Import icons from here instead of re-rolling the try/require dance.
 */

import React, { type ComponentType } from "react";
import { Text } from "react-native";

declare const require: (id: string) => unknown;

export type IconProps = { size?: number; color?: string; strokeWidth?: number };
export type IconComponent = ComponentType<IconProps>;
type IconModule = Record<string, IconComponent | undefined>;

let lucideIcons: IconModule = {};
try {
  lucideIcons = require("lucide-react-native") as IconModule;
} catch {
  lucideIcons = {};
}

function fallbackIcon(glyph: string): IconComponent {
  return function FallbackIcon({ size = 18, color }: IconProps) {
    return <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>;
  };
}

export function icon(name: string, glyph: string): IconComponent {
  return lucideIcons[name] ?? fallbackIcon(glyph);
}

// Navigation & chrome
export const ArrowLeft = icon("ArrowLeft", "‹");
export const ArrowRight = icon("ArrowRight", "›");
export const ChevronDown = icon("ChevronDown", "▾");
export const ChevronLeft = icon("ChevronLeft", "‹");
export const ChevronRight = icon("ChevronRight", "▸");
export const Menu = icon("Menu", "≡");
export const MoreHorizontal = icon("MoreHorizontal", "⋯");
export const Plus = icon("Plus", "+");
export const RefreshCw = icon("RefreshCw", "↻");
export const Search = icon("Search", "○");
export const Square = icon("Square", "■");
export const X = icon("X", "×");

// Panel kinds & suggestions
export const Bookmark = icon("Bookmark", "★");
export const Clock3 = icon("Clock3", "◷");
export const Globe = icon("Globe", "◎");
export const Globe2 = icon("Globe2", "◎");
export const LayoutGrid = icon("LayoutGrid", "▦");
export const LayoutPanelTop = icon("LayoutPanelTop", "▤");
export const Link2 = icon("Link2", "↗");
export const PanelTop = icon("PanelTop", "□");
export const Workflow = icon("Workflow", "◇");

// Actions
export const Archive = icon("Archive", "▣");
export const Copy = icon("Copy", "⧉");
export const CopyPlus = icon("CopyPlus", "⧉+");
export const ExternalLink = icon("ExternalLink", "↗");
export const Lock = icon("Lock", "⚿");
export const Pin = icon("Pin", "⤓");
export const PinOff = icon("PinOff", "⤓");
export const Power = icon("Power", "⏻");
export const Settings = icon("Settings", "⚙");
export const Settings2 = icon("Settings2", "⚙");
export const Unplug = icon("Unplug", "⏚");
export const User = icon("User", "◕");

// Status & feedback
export const AlertTriangle = icon("AlertTriangle", "!");
export const Bell = icon("Bell", "◔");
export const CheckCircle2 = icon("CheckCircle2", "✓");
export const Check = icon("Check", "✓");
export const Info = icon("Info", "i");
export const MessageCircle = icon("MessageCircle", "◍");
export const Moon = icon("Moon", "☾");
export const Smartphone = icon("Smartphone", "▯");
export const Sun = icon("Sun", "☀");
export const Wifi = icon("Wifi", "≋");
export const WifiOff = icon("WifiOff", "≠");
export const XCircle = icon("XCircle", "×");
