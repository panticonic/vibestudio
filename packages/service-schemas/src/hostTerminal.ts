import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";

export const HOST_TERMINAL_CAPABILITY = "host-terminal.open";
export const HOST_TERMINAL_PREPARATION = "hostTerminal.open";
const id = z.string().min(1).max(256);
const dimensions = {
  columns: z.number().int().min(20).max(1000),
  rows: z.number().int().min(5).max(1000),
};
const controlTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "host-terminal.session",
  rationale: "Controls only a receiver-owned terminal bound to the approved caller and connection",
};
export const hostTerminalMethods = defineServiceMethods({
  open: {
    capability: HOST_TERMINAL_CAPABILITY,
    description:
      "Open an explicitly approved terminal with full host access as the app's OS user. This is outside workspace confinement and does not elevate to administrator.",
    presentation: {
      title: "Open a terminal with full host access",
      action: "run commands with full host access",
      description:
        "Commands can read and change your host files, credentials, processes, network and other workspaces. Closing the terminal cannot undo those effects or guarantee descendant termination.",
      group: "host",
      authorityCategory: { domain: "computer", verb: "act" },
    },
    tier: {
      ...controlTier,
      family: "host-terminal.open",
      rationale:
        "Opening always prepares a fresh critical host-terminal authorization before spawning",
    },
    authority: {
      requirement: requirementForPrincipals(["user", "code"], HOST_TERMINAL_CAPABILITY),
      resource: { kind: "literal", key: HOST_TERMINAL_CAPABILITY },
      prepared: {
        resolver: HOST_TERMINAL_PREPARATION,
        leaves: [
          {
            capability: HOST_TERMINAL_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["user", "code"], HOST_TERMINAL_CAPABILITY)
            ),
            tier: "critical",
          },
        ],
      },
    },
    args: z.tuple([z.object(dimensions).strict()]),
    returns: z
      .object({ terminalSessionId: id, host: z.string(), cwd: z.string(), shell: z.string() })
      .strict(),
    access: {
      sensitivity: "admin",
      approval: [
        {
          capability: HOST_TERMINAL_CAPABILITY,
          tier: "critical",
          operation: { kind: "unknown", verb: "Open host terminal" },
          grantScopes: ["once"],
          severity: "severe",
          reason:
            "Arbitrary commands execute outside workspace confinement with the host user's authority.",
        },
      ],
    },
  },
  read: {
    description:
      "Read bounded output from an owned host terminal; cursor advances only over returned bytes.",
    tier: controlTier,
    args: z.tuple([
      z
        .object({
          terminalSessionId: id,
          after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          maxBytes: z
            .number()
            .int()
            .min(4)
            .max(512 * 1024)
            .optional(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        terminalSessionId: id,
        cursor: z.number(),
        text: z.string(),
        alive: z.boolean(),
        exit: z.object({ code: z.number(), signal: z.number().optional() }).nullable(),
      })
      .strict(),
    access: { sensitivity: "read" },
  },
  write: {
    description:
      "Write ordered terminal input. Retry only the latest sequence with identical bytes; out-of-order input is rejected.",
    tier: controlTier,
    args: z.tuple([
      z
        .object({
          terminalSessionId: id,
          sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          data: z.string().max(128 * 1024),
        })
        .strict(),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
  resize: {
    description: "Resize an owned host terminal.",
    tier: controlTier,
    args: z.tuple([z.object({ terminalSessionId: id, ...dimensions }).strict()]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
  close: {
    description:
      "Retire terminal control before attempting process cleanup. Host descendants may survive.",
    tier: controlTier,
    args: z.tuple([z.object({ terminalSessionId: id }).strict()]),
    returns: z
      .object({ processExited: z.boolean(), descendantCleanup: z.literal("unverified") })
      .strict(),
    access: { sensitivity: "write" },
  },
});
