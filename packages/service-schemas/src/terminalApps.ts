/**
 * Terminal app launch service: runs terminal apps (panels hosted by
 * terminals, at `terminal-apps/<name>`) as Node programs in workspace PTYs,
 * and keeps each person's terminal sessions — the one tab registry every
 * terminal client (the terminal browser, the desktop terminal panel) shows.
 *
 * A session is either a terminal app (a slotless panel runtime held by this
 * service: its own principal, context and stateArgs) or a plain login shell.
 * The PTY belongs to the person (shell extension ownership), so any of their
 * clients attaches to it with the shell extension's framed attach stream.
 */
import { z } from "zod";
import { JsonObjectSchema } from "@vibestudio/shared/wireValues";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { TerminalSessionEntry } from "@vibestudio/shared/terminalSessions";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";

export const TERMINAL_APPS_RUN_CAPABILITY = "terminal-apps.run";
export const TERMINAL_APPS_RUN_PREPARATION = "terminalApps.run";
export const TERMINAL_SESSIONS_CHANGED_EVENT = "terminal-apps:sessions-changed" as const;

const WEBSITE = {
  kind: "closed",
  reason: "Terminal sessions belong to a person's own terminal clients.",
} as const;

const sessionId = z.string().min(1).max(128);
const size = {
  cols: z.number().int().min(10).max(1000),
  rows: z.number().int().min(3).max(1000),
};

export const TerminalSessionEntrySchema: z.ZodType<TerminalSessionEntry> = z
  .object({
    sessionId,
    kind: z.enum(["app", "shell"]),
    /** `terminal-apps/<name>` for an app. */
    source: z.string().optional(),
    title: z.string(),
    /** One emoji, when the app declares it. */
    icon: z.string().optional(),
    /** The app's runtime principal while it runs (approvals name it). */
    principalId: z.string().optional(),
    /** The live PTY session to attach to with the shell extension. */
    shellSessionId: z.string().nullable(),
    running: z.boolean(),
    exit: z
      .object({ code: z.number().nullable(), signal: z.string().optional() })
      .strict()
      .optional(),
    createdAt: z.number(),
    lastActiveAt: z.number(),
  })
  .strict();
export type { TerminalSessionEntry };

const controlTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "terminal-apps.control",
  rationale: "Controls only the calling person's own terminal sessions",
};

const runAuthority = {
  requirement: requirementForPrincipals(["user", "code"], TERMINAL_APPS_RUN_CAPABILITY),
  resource: { kind: "literal" as const, key: TERMINAL_APPS_RUN_CAPABILITY },
  prepared: {
    resolver: TERMINAL_APPS_RUN_PREPARATION,
    leaves: [
      {
        capability: TERMINAL_APPS_RUN_CAPABILITY,
        requirement: fixedPreparedAuthorityRequirement(
          requirementForPrincipals(["user", "code"], TERMINAL_APPS_RUN_CAPABILITY)
        ),
        tier: "gated" as const,
      },
    ],
  },
};

const runPresentation = {
  title: "Run a terminal app",
  action: "run a terminal app or shell in this workspace",
  description:
    "Start a program in a terminal session inside this workspace's native runtime, as you.",
  group: "computer",
  authorityCategory: { domain: "computer" as const, verb: "act" as const },
};

const runAccess: MethodAccessDescriptor = {
  sensitivity: "write" as const,
  approval: [
    {
      capability: TERMINAL_APPS_RUN_CAPABILITY,
      tier: "gated",
      operation: { kind: "unknown", verb: "Run terminal app" },
      grantScopes: ["once", "session", "version"],
      reason: "A terminal app runs native code in the workspace runtime as you.",
    },
  ],
};

export const terminalAppsMethods = defineServiceMethods({
  list: {
    website: WEBSITE,
    description:
      "The calling person's terminal sessions in this workspace (apps and shells), most recently active first.",
    tier: controlTier,
    args: z.tuple([]),
    returns: z.array(TerminalSessionEntrySchema),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  launch: {
    website: WEBSITE,
    capability: TERMINAL_APPS_RUN_CAPABILITY,
    presentation: runPresentation,
    description:
      "Start a terminal app (`source` = terminal-apps/<name>) or, without a source, a login shell, in a new terminal session sized cols×rows. Returns the session; attach to its shellSessionId.",
    tier: { ...controlTier, tier: "gated" as const, family: "terminal-apps.run" },
    authority: runAuthority,
    args: z.tuple([
      z
        .object({
          source: z.string().min(1).max(256).optional(),
          ...size,
          /** How the launching terminal opens approvals, shown by apps. */
          approvalsKey: z.string().max(40).optional(),
        })
        .strict(),
    ]),
    returns: TerminalSessionEntrySchema,
    access: runAccess,
  },
  resume: {
    website: WEBSITE,
    capability: TERMINAL_APPS_RUN_CAPABILITY,
    presentation: runPresentation,
    description:
      "Return a session; when its program is no longer running, start it again in the same session (an app keeps its state and context).",
    tier: { ...controlTier, tier: "gated" as const, family: "terminal-apps.run" },
    authority: runAuthority,
    args: z.tuple([
      z.object({ sessionId, ...size, approvalsKey: z.string().max(40).optional() }).strict(),
    ]),
    returns: TerminalSessionEntrySchema,
    access: runAccess,
  },
  close: {
    website: WEBSITE,
    description:
      "End a terminal session for good: its program is terminated and the session is forgotten.",
    tier: controlTier,
    args: z.tuple([sessionId]),
    returns: z.void(),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "destructive" },
  },
  getSettings: {
    website: WEBSITE,
    description: "The calling person's terminal settings (prefix key, bell, mouse, …).",
    tier: controlTier,
    args: z.tuple([]),
    returns: JsonObjectSchema,
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  setSettings: {
    website: WEBSITE,
    description: "Replace the calling person's terminal settings (at most 4 KB of JSON).",
    tier: controlTier,
    args: z.tuple([JsonObjectSchema]),
    returns: z.void(),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
});
