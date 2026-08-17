/**
 * notification service method schemas.
 */

import { z } from "zod";
import type { NotificationPayload } from "@vibestudio/shared/events";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export type NotificationShowRequest = Omit<
  NotificationPayload,
  "id" | "sourcePanelId" | "iconDataUrl"
>;

// Access descriptors carry sensitivity metadata beside the compositional
// principal requirements declared by the service or method.
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

const USER_INBOX_SIGNAL_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

/**
 * The push half of a userland inbox escalation (messaging plan §4.5 step 5).
 * Userland owns the durable entry; the host owns device registrations, so this
 * is the one seam where enough of the entry crosses to render a phone
 * notification and deep-link back into the conversation.
 */
export const UserInboxPushRequestSchema = z
  .object({
    notificationId: z.string().min(1),
    kind: z.string().min(1).describe("Inbox entry kind, e.g. `agent.message`."),
    title: z.string().min(1),
    body: z.string().optional(),
    /** `high` marks the sender's `interrupt` rung; `normal` is the `inbox` rung. */
    priority: z.enum(["normal", "high"]).default("normal"),
    /** Deep-link facts. `channelId` + `messageId` land the device on the envelope. */
    channelId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    senderParticipantId: z.string().optional(),
    senderHandle: z.string().optional(),
  })
  .strict();
export type UserInboxPushRequest = z.infer<typeof UserInboxPushRequestSchema>;

export const NotificationActionSchema = z.object({
  id: z.string().describe("Stable action identifier reported back via reportAction."),
  label: z.string().describe("Button label shown to the user."),
  variant: z
    .enum(["solid", "soft", "ghost"])
    .optional()
    .describe("Visual emphasis of the action button."),
  command: z
    .union([
      z.object({ type: z.literal("app.applyUpdate"), appId: z.string() }),
      z.object({
        type: z.literal("runtime.supervision.rollback"),
        release: z
          .object({
            kind: z.literal("app"),
            releaseId: z.string(),
          })
          .strict(),
        buildKey: z.string().optional(),
      }),
      z.object({
        type: z.literal("runtime.supervision.restart"),
        identity: z
          .object({
            kind: z.enum(["panel", "worker", "do", "app", "extension"]),
            entityId: z.string(),
          })
          .strict(),
      }),
      z
        .object({
          type: z.literal("runtime.execution.recover"),
          entityId: z.string().min(1),
          expectedExecutionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
          strategy: z.enum(["restore-exact", "replace-incarnation"]),
        })
        .strict(),
      z.object({ type: z.literal("desktop.installNpmUpdate") }),
      z.object({ type: z.literal("desktop.copyNpmUpdateCommand") }),
      z.object({ type: z.literal("browser.downloadOpen"), downloadId: z.string() }),
      z.object({ type: z.literal("browser.downloadReveal"), downloadId: z.string() }),
      z
        .object({
          type: z.literal("panel.open"),
          source: z.string().min(1),
          stateArgs: z.record(z.unknown()).optional(),
        })
        .strict(),
      z.object({ type: z.literal("panel.focus"), panelId: z.string() }),
    ])
    .optional()
    .describe("Optional built-in command the shell runs when the action is taken."),
  invoke: z
    .object({
      kind: z.literal("extension"),
      extension: z.string(),
      method: z.string(),
      args: z.array(z.unknown()).optional(),
    })
    .optional()
    .describe("Optional extension invocation the shell runs when the action is taken."),
});

export const NotificationDetailSchema = z.object({
  label: z.string().describe("Detail row label."),
  value: z.string().describe("Detail row value."),
  mono: z.boolean().optional().describe("Render the value in a monospace font."),
});

export const NotificationHistoryItemSchema = z.object({
  title: z.string().optional().describe("Optional title of the prior notification."),
  message: z.string().describe("Message text of the prior notification."),
  timestamp: z.number().optional().describe("Epoch milliseconds when it occurred."),
  details: z
    .array(NotificationDetailSchema)
    .optional()
    .describe("Detail rows associated with the prior notification."),
});

export const NotificationShowRequestSchema = z
  .object({
    type: z
      .enum(["info", "success", "warning", "error", "consent"])
      .describe("Notification severity/kind; 'consent' drives an approval prompt."),
    title: z.string().describe("Notification title."),
    message: z.string().optional().describe("Notification body message."),
    consent: z
      .object({
        provider: z.string(),
        scopes: z.array(z.string()),
        callerId: z.string(),
        callerTitle: z.string(),
        callerKind: z.enum(["panel", "app", "worker", "do"]),
      })
      .optional()
      .describe("Consent request details shown for 'consent'-type notifications."),
    ttl: z.number().optional().describe("Auto-dismiss timeout in milliseconds."),
    actions: z
      .array(NotificationActionSchema)
      .optional()
      .describe("Action buttons offered to the user."),
    details: z.array(NotificationDetailSchema).optional().describe("Expandable detail rows."),
    history: z
      .array(NotificationHistoryItemSchema)
      .optional()
      .describe("Prior related notifications shown as history."),
  })
  .strict() satisfies z.ZodType<NotificationShowRequest>;

export const notificationMethods = defineServiceMethods({
  show: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Show a notification in the shell chrome; returns a host-issued id attributed to the verified caller.",
    args: z.tuple([NotificationShowRequestSchema]),
    returns: z.string(),
    access: WRITE_ACCESS,
    examples: [{ args: [{ type: "info", title: "Hello", message: "World" }] }],
  },
  showToUser: {
    agentFacing: false,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Code-owned background work addresses a transient notice to its recorded owner",
    },
    description:
      "Code/host-only: show an addressed shell notification for one host-verified user account.",
    args: z.tuple([z.string().min(1), NotificationShowRequestSchema]),
    returns: z.string(),
    authority: { principals: ["code", "host"] },
    access: WRITE_ACCESS,
  },
  dismiss: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Dismiss a notification previously issued to this caller, rejecting any pending waitForAction for it.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["notif-123"] }],
  },
  reportAction: {
    agentFacing: false,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Shell-only: report a user action on an addressed notification and resolve its pending waitForAction.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["notif-123", "approve"] }],
  },
  signalUserInbox: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Notify every live session for one host-verified account that its durable userland inbox changed.",
    args: z.tuple([z.string().min(1)]),
    returns: z.boolean(),
    authority: { principals: ["code", "host"] },
    access: USER_INBOX_SIGNAL_ACCESS,
    examples: [{ args: ["usr_alice"] }],
  },
  pushUserInbox: {
    agentFacing: false,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale:
        "Code-owned escalation reaches one host-verified account's registered devices; the durable inbox entry stays in userland",
    },
    description:
      "Code/host-only: push one durable userland inbox entry to a host-verified account's registered devices with a deep link back to its conversation. Returns the number of devices reached.",
    args: z.tuple([z.string().min(1), UserInboxPushRequestSchema]),
    returns: z.number(),
    authority: { principals: ["code", "host"] },
    access: USER_INBOX_SIGNAL_ACCESS,
    examples: [
      {
        args: [
          "usr_alice",
          {
            notificationId: "agent.message:say:call-1:usr_alice",
            kind: "agent.message",
            title: "Briefing ready",
            priority: "normal",
            channelId: "channel-1",
            messageId: "say:call-1",
          },
        ],
      },
    ],
  },
});
