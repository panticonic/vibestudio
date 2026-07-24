/**
 * Compact theme-identity control: appearance mode, accent color, and corner
 * radius. Writes the shell's theme atoms; the accent/radius changes broadcast
 * live to every panel over the runtime bridge (see App.tsx → panel.updateThemeConfig).
 */
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  Popover,
  IconButton,
  Flex,
  Text,
  SegmentedControl,
  Tooltip,
  Select,
} from "@radix-ui/themes";
import { ColorWheelIcon, CheckIcon } from "@radix-ui/react-icons";
import {
  themeModeAtom,
  setThemeModeAtom,
  themeConfigAtom,
  setThemeConfigAtom,
  type ThemeConfigValue,
} from "../state/themeAtoms";

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
const GRAYS = ["gray", "mauve", "slate", "sage", "olive", "sand"] as const;
/**
 * Panel WebContentsViews are native siblings of the shell's own view, so they
 * always composite above shell DOM — no z-index reaches over them. Dialogs get
 * around that by hiding the panels while they're open (useShellOverlay), but
 * that would be self-defeating here: the whole point of this popover is
 * watching the theme change land on those panels. So instead the popover is
 * confined to the panel tree's rectangle, which is shell chrome and never
 * covered. Falls back to the viewport if this ever renders outside the tree.
 */
const SHELL_CHROME_BOUNDARY_SELECTOR = '[data-shell-panel-sidebar="true"]';
const RADII: ThemeConfigValue["radius"][] = ["none", "small", "medium", "large", "full"];
const SCALINGS: ThemeConfigValue["scaling"][] = ["90%", "95%", "100%", "105%", "110%"];

export function ThemeSettings() {
  const mode = useAtomValue(themeModeAtom);
  const config = useAtomValue(themeConfigAtom);
  const setMode = useSetAtom(setThemeModeAtom);
  const setConfig = useSetAtom(setThemeConfigAtom);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);

  // Resolved on open rather than on mount: the tree is remounted whenever the
  // user toggles navigation modes, so a reference taken once goes stale.
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    setBoundary(triggerRef.current?.closest(SHELL_CHROME_BOUNDARY_SELECTOR) ?? null);
  }, []);

  return (
    <Popover.Root onOpenChange={handleOpenChange}>
      <Tooltip content="Appearance">
        <Popover.Trigger>
          <IconButton
            ref={triggerRef}
            variant="ghost"
            size="2"
            className="app-touch-target"
            aria-label="Appearance settings"
          >
            <ColorWheelIcon />
          </IconButton>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Content
        size="2"
        // Upward and end-aligned: the trigger sits at the foot of the tree, so
        // this is the one direction with room inside the boundary.
        side="top"
        align="end"
        {...(boundary ? { collisionBoundary: boundary } : {})}
        style={{
          width: 264,
          // Radix publishes the room left inside the boundary; clamping to it
          // keeps a narrowed tree from pushing the popover under the panels.
          maxWidth: "var(--radix-popover-content-available-width)",
          zIndex: "var(--z-popover)" as unknown as number,
        }}
      >
        <Flex direction="column" gap="3">
          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Appearance
            </Text>
            <SegmentedControl.Root
              size="1"
              value={mode}
              onValueChange={(value) => setMode(value as typeof mode)}
            >
              <SegmentedControl.Item className="app-touch-target" value="light">
                Light
              </SegmentedControl.Item>
              <SegmentedControl.Item className="app-touch-target" value="dark">
                Dark
              </SegmentedControl.Item>
              <SegmentedControl.Item className="app-touch-target" value="system">
                System
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Accent
            </Text>
            <Flex gap="2" wrap="wrap">
              {ACCENTS.map((accent) => {
                const selected = config.accentColor === accent;
                return (
                  <Tooltip key={accent} content={accent}>
                    <button
                      type="button"
                      aria-label={`Accent ${accent}`}
                      aria-pressed={selected}
                      onClick={() => setConfig({ accentColor: accent })}
                      className="app-touch-target"
                      style={
                        {
                          width: 26,
                          height: 26,
                          borderRadius: "var(--radius-3)",
                          // The swatch's own accent scale, scoped via data-accent-color.
                          background: `var(--${accent}-9)`,
                          border: selected
                            ? "2px solid var(--gray-12)"
                            : "1px solid var(--surface-border)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          padding: 0,
                        } as CSSProperties
                      }
                    >
                      {selected ? <CheckIcon style={{ color: "white" }} /> : null}
                    </button>
                  </Tooltip>
                );
              })}
            </Flex>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Gray
            </Text>
            <Select.Root
              size="1"
              value={config.grayColor}
              onValueChange={(value) => setConfig({ grayColor: value })}
            >
              <Select.Trigger className="app-touch-target" />
              <Select.Content>
                {GRAYS.map((gray) => (
                  <Select.Item key={gray} value={gray}>
                    {gray}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Corner radius
            </Text>
            <Select.Root
              size="1"
              value={config.radius}
              onValueChange={(value) => setConfig({ radius: value as ThemeConfigValue["radius"] })}
            >
              <Select.Trigger className="app-touch-target" />
              <Select.Content>
                {RADII.map((radius) => (
                  <Select.Item key={radius} value={radius}>
                    {radius}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Scaling
            </Text>
            <Select.Root
              size="1"
              value={config.scaling}
              onValueChange={(value) =>
                setConfig({ scaling: value as ThemeConfigValue["scaling"] })
              }
            >
              <Select.Trigger className="app-touch-target" />
              <Select.Content>
                {SCALINGS.map((scaling) => (
                  <Select.Item key={scaling} value={scaling}>
                    {scaling}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" color="gray" weight="medium">
              Panel background
            </Text>
            <SegmentedControl.Root
              size="1"
              value={config.panelBackground}
              onValueChange={(value) =>
                setConfig({ panelBackground: value as ThemeConfigValue["panelBackground"] })
              }
            >
              <SegmentedControl.Item className="app-touch-target" value="solid">
                Solid
              </SegmentedControl.Item>
              <SegmentedControl.Item className="app-touch-target" value="translucent">
                Translucent
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </Flex>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
