/**
 * Wire schema for the Electron "app" lifecycle service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { AppInfoSchema } from "@vibestudio/shared/panelContracts";

// Access descriptors carry sensitivity metadata beside the compositional
// principal requirements declared by the service definition.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

/**
 * Shell-owned surfaces a caller may ask the host to open — the wire shape of
 * `@vibestudio/shared/shellSurface`'s `ShellSurfaceTarget`. The string forms
 * are the original management surfaces; object forms open the command agent
 * overlay about a panel, an About page, or run a panel's contributed host
 * command. Detailed field rules live in `validateShellSurfaceTarget`.
 */
export const ShellSurfaceTargetSchema = z.union([
  z.enum(["connection-settings", "workspace-chooser"]),
  z.object({ kind: z.enum(["connection-settings", "workspace-chooser"]) }).strict(),
  z
    .object({
      kind: z.literal("command-agent"),
      panelId: z.string().min(1).optional(),
      mode: z.enum(["all", "commands", "goto", "quickfire"]).optional(),
      prompt: z.string().max(4_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("about"), page: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal("panel-command"),
      panelId: z.string().min(1),
      commandId: z.string().min(1).max(256),
    })
    .strict(),
]);
export type ShellSurfaceTarget = z.infer<typeof ShellSurfaceTargetSchema>;

export const ShellSurfaceKindSchema = z.enum([
  "connection-settings",
  "workspace-chooser",
  "command-agent",
  "about",
  "panel-command",
]);

export const appMethods = defineServiceMethods({
  getInfo: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "App version plus connection mode/host, current server connection status, and the selected ICE path (relay vs direct).",
    args: z.tuple([]),
    returns: AppInfoSchema,
    access: READ_ACCESS,
    examples: [
      {
        args: [],
        returns: {
          version: "1.0.0",
          connectionMode: "local",
          connectionStatus: "connected",
          connectionCandidateType: null,
        },
      },
    ],
  },
  getSystemTheme: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Whether the OS is currently in dark or light appearance.",
    args: z.tuple([]),
    returns: z.enum(["dark", "light"]),
    access: READ_ACCESS,
    examples: [{ args: [], returns: "dark" }],
  },
  setThemeMode: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.mutate",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Set the app theme source to light, dark, or system (follow OS). Requires the window-management capability.",
    args: z.tuple([z.enum(["light", "dark", "system"])]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["dark"] }],
  },
  openDevTools: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Open Chromium DevTools for the calling app view (or the shell). Requires the window-management capability.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  openExternal: {
    capability: "external.open",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    presentation: {
      title: "Open a link in another application",
      action: "open a link in another application",
      description: "Open a web link in your default browser or another app.",
      group: "host",
      authorityCategory: {
        domain: "sharing",
        verb: "act",
      },
    },
    description:
      "Open an http(s) URL in the user's default external browser. Requires the open-external capability; non-http(s) URLs are rejected.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["https://example.com"] }],
  },
  openWorkspacePath: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Reveal the workspace directory in the OS file manager. Shell-only.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  openShellSurface: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale:
        "Open bias: opens bounded first-party shell chrome without changing the managed state; §2 default {code, session} family",
    },
    description:
      "Open a typed shell-owned surface without exposing its private state to the caller: connection settings, the workspace chooser, an About page, the command agent overlay about a panel (optionally pre-filled, never auto-sent), or a panel's contributed host command. Rejects kinds this host cannot open; see describeShellSurfaces.",
    args: z.tuple([ShellSurfaceTargetSchema]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  describeShellSurfaces: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale:
        "Open bias: read-only list of first-party chrome this host can open; §2 default {code, session} family",
    },
    description:
      "List the shell surface kinds this host can open with openShellSurface, so a caller can offer only what works here instead of probing.",
    args: z.tuple([]),
    returns: z.object({ surfaces: z.array(ShellSurfaceKindSchema) }).strict(),
    access: { sensitivity: "read" },
  },
  clearBuildCache: {
    capability: "workspace.build-cache.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Clear cached build files",
      action: "clear cached build files",
      description: "Remove cached build files so apps rebuild fresh next time.",
      group: "host",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description:
      "Recompute the build graph and invalidate ready panels so they rebuild on next load. Requires the panel-hosting capability.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getShellPages: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "List the shell's built-in about/info page routes. Requires the panel-hosting capability.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  applyUpdate: {
    capability: "application.update",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Install an application update",
      action: "install an application update",
      description: "Install a pending application update.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
    description:
      "Apply a pending build update for the given app id; returns whether an update was applied. Requires shell or a panel-hosting app.",
    args: z.tuple([z.string()]),
    returns: z.object({ applied: z.boolean() }),
    access: WRITE_ACCESS,
    examples: [{ args: ["com.example.app"], returns: { applied: true } }],
  },
  listPendingUpdates: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "List apps with a pending build update, including source/target build keys and versions. Requires shell or a panel-hosting app.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        appId: z.string().describe("Identifier of the app with a pending update."),
        source: z.string().optional().describe("Source build key the update originates from."),
        target: z.string().optional().describe("Target build key the update moves to."),
        url: z.string().describe("Location of the pending update artifact."),
        buildKey: z
          .string()
          .nullable()
          .optional()
          .describe("Build key the update would install, if known."),
        effectiveVersion: z
          .string()
          .nullable()
          .optional()
          .describe("Effective version after applying the update, if known."),
        previousBuildKey: z
          .string()
          .nullable()
          .optional()
          .describe("Build key currently installed, if known."),
        previousEffectiveVersion: z
          .string()
          .nullable()
          .optional()
          .describe("Effective version currently installed, if known."),
      })
    ),
    access: READ_ACCESS,
  },
});
