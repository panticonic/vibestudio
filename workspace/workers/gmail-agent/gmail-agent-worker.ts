import { AgentWorkerBase, type RespondPolicy } from "@workspace/agentic-do";
import { complete, getModel as getPiModel, type Context } from "@earendil-works/pi-ai";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import {
  AGENTIC_PROTOCOL_VERSION,
  type ActorRef,
  type AgenticEvent,
  type CustomMessageDisplayMode,
  type MessageId,
} from "@workspace/agentic-protocol";
import {
  createGmailClient,
  type GmailClient,
  type GmailMessage,
  type GmailThread,
} from "@workspace/gmail";
import {
  reduce as reduceGmailThread,
  type GmailThreadState,
} from "@workspace/gmail/renderers/gmail-thread.reducer";
import type { PiRunnerOptions } from "@workspace/harness";
import type { ParticipantDescriptor } from "@workspace/harness";

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_THREAD_LOAD_LIMIT = 12;
const GMAIL_ACTION_BAR_FILE = "skills/gmail/action-bar.tsx";
const GMAIL_ACTION_BAR_MAX_HEIGHT = 180;
const GMAIL_UI_INSTALL_VERSION = 2;
const GMAIL_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
} satisfies Record<string, string>;
const GMAIL_RENDERERS = [
  { typeId: "gmail.inbox", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-inbox.tsx" },
  { typeId: "gmail.category", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-category.tsx" },
  { typeId: "gmail.thread", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-thread.tsx" },
  { typeId: "gmail.compose", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-compose.tsx" },
];
const GMAIL_SETUP_ONBOARDING_PROMPT = [
  "You have just been added as the Gmail agent for this channel.",
  "Start first-run setup. Ask the user what kinds of incoming email you should pay attention to.",
  "Do not run semantic analysis over every message by default. The built-in default only wakes for unread inbox mail from senders the user has replied to before.",
  "When the user answers, use the normal workspace file tools as needed to inspect and edit the Gmail agent code so incoming email wakes you only on the requested static/cheap signals.",
  "Useful watch categories to offer: important senders or domains, invoices and receipts, scheduling, customer/user messages, urgent operational mail, every email, or nothing yet.",
  "After you have implemented or confirmed the requested behavior, call gmail_markConfigured with a concise summary.",
].join("\n");
const METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Date",
  "Message-ID",
  "References",
  "In-Reply-To",
];
const GMAIL_SYSTEM_CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

type GmailTool = NonNullable<PiRunnerOptions["extraTools"]>[number];
type GmailToolParameters = GmailTool["parameters"];

interface GmailChannelState {
  channelId: string;
  historyId?: string;
  emailAddress?: string;
  credentialId?: string;
  pollIntervalMs: number;
  inboxMessageId?: string;
  lastSyncAt?: number;
  lastError?: string;
  lastOverviewJson?: string;
  lastSearchQuery?: string;
  lastSearchJson?: string;
  setupStatus: "needs-user-preferences" | "configured";
  setupPromptedAt?: number;
  configuredAt?: number;
  setupSummary?: string;
}

interface GmailThreadStateRow {
  channel_id: string;
  thread_id: string;
  message_id: string | null;
  subject: string;
  from_addr: string;
  snippet: string;
  unread: number;
  in_inbox: number;
  actionable: number;
  category: string | null;
  updated_at: number;
}

type GmailAttentionAction =
  | "surface"
  | "summarize"
  | "draft"
  | "archive"
  | "markRead";

type GmailAttentionScope = "metadata" | "snippet" | "full-thread-on-wake";
type GmailAttentionField = GmailAttentionCondition["field"];
type GmailAttentionOperator = NonNullable<GmailAttentionCondition["op"]>;

const GMAIL_ATTENTION_FIELDS = [
  "from",
  "fromDomain",
  "to",
  "subject",
  "snippet",
  "label",
  "category",
  "hasAttachment",
  "priorReplyToSender",
  "wakeAll",
] as const satisfies readonly GmailAttentionField[];

const GMAIL_ATTENTION_OPERATORS = [
  "contains",
  "equals",
  "matches",
  "present",
] as const satisfies readonly GmailAttentionOperator[];

const GMAIL_ATTENTION_ACTIONS = [
  "surface",
  "summarize",
  "draft",
  "archive",
  "markRead",
] as const satisfies readonly GmailAttentionAction[];

const GMAIL_ATTENTION_SCOPES = [
  "metadata",
  "snippet",
  "full-thread-on-wake",
] as const satisfies readonly GmailAttentionScope[];

const EMPTY_TOOL_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const SEARCH_TOOL_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", minLength: 1 },
    limit: { type: "number", minimum: 1, maximum: 25 },
  },
  required: ["q"],
  additionalProperties: false,
} as const;

const THREAD_ID_TOOL_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string", minLength: 1 },
  },
  required: ["threadId"],
  additionalProperties: false,
} as const;

const SEND_TOOL_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    threadId: { type: "string" },
    messageId: { type: "string" },
    sourceThreadId: { type: "string" },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

const CATEGORIZE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string", minLength: 1 },
    category: { type: "string", minLength: 1 },
  },
  required: ["threadId", "category"],
  additionalProperties: false,
} as const;

const POLL_INTERVAL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    pollIntervalMs: { type: "number", minimum: 30_000 },
  },
  required: ["pollIntervalMs"],
  additionalProperties: false,
} as const;

const LIST_THREADS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 25 },
  },
  additionalProperties: false,
} as const;

const MARK_CONFIGURED_TOOL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  additionalProperties: false,
} as const;

interface GmailAttentionCondition {
  field:
    | "from"
    | "fromDomain"
    | "to"
    | "subject"
    | "snippet"
    | "label"
    | "category"
    | "hasAttachment"
    | "priorReplyToSender"
    | "wakeAll";
  op?: "contains" | "equals" | "matches" | "present";
  value?: string;
}

interface GmailAttentionMatcher {
  any?: GmailAttentionCondition[];
  all?: GmailAttentionCondition[];
  not?: GmailAttentionCondition[];
}

interface GmailAttentionDirective {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope: GmailAttentionScope;
  priority: number;
  match: GmailAttentionMatcher;
  actions: GmailAttentionAction[];
}

interface GmailAttentionRuleSet {
  version: 1;
  directives: GmailAttentionDirective[];
}

interface GmailAttentionRuleSetRecord {
  channelId: string;
  ruleSet: GmailAttentionRuleSet;
  updatedAt: number;
}

interface GmailAttentionRulesSnapshot {
  channelId: string;
  rules: GmailAttentionDirective[];
  ruleSet: GmailAttentionRuleSet;
  updatedAt: number;
  capabilities: {
    fields: readonly GmailAttentionField[];
    operators: readonly GmailAttentionOperator[];
    actions: readonly GmailAttentionAction[];
    scopes: readonly GmailAttentionScope[];
  };
  rpc: {
    source: "workers/gmail-agent";
    className: "GmailAgentWorker";
    objectKey: string;
    resolveMethod: "workers.resolveDurableObject";
  };
}

interface GmailAttentionDecision {
  wake: boolean;
  directiveId?: string;
  directiveName?: string;
  reason?: string;
  actions?: GmailAttentionAction[];
}

interface GmailAttentionEvent {
  threadId: string;
  messageId?: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  category?: string;
  hasAttachment: boolean;
  priorReplyToSender?: boolean;
  unread: boolean;
  inInbox: boolean;
  addressedToUser: boolean;
  internalDate?: number;
}

interface GmailAttentionHit {
  threadId: string;
  directiveId: string;
  directiveName: string;
  reason: string;
  actions: GmailAttentionAction[];
  matchedAt: number;
}

interface GmailThreadCardState extends GmailThreadState {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  unread: boolean;
  inInbox: boolean;
  category?: string;
  actionable: boolean;
  attention?: GmailAttentionDecision;
  updatedAt: number;
}

interface GmailComposeState {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  draftId?: string;
  threadId?: string;
  sourceThreadId?: string;
  status: "draft" | "saved" | "discarded" | "sending" | "sent" | "error";
  error?: string;
}

interface GmailInboxState {
  email?: string;
  unread: number;
  inbox: number;
  urgent: number;
  draftCount: number;
  perCategory?: Record<string, number>;
  actionable: GmailThreadCardState[];
  setupStatus: "needs-user-preferences" | "configured";
  setupSummary?: string;
  attentionRules?: GmailAttentionRuleSet;
  attentionHits?: GmailAttentionHit[];
  searchQuery?: string;
  searchResults?: GmailThreadCardState[];
  lastSyncedAt?: string;
  lastError?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function gmailAgentObjectKey(channelId: string): string {
  return `gmail-${channelId}`;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function header(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function latestMessage(thread: GmailThread): GmailMessage | undefined {
  return thread.messages?.[thread.messages.length - 1];
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes =
    typeof Buffer !== "undefined"
      ? Buffer.from(padded, "base64")
      : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textFromPart(part: NonNullable<GmailMessage["payload"]> | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = textFromPart(child);
    if (text) return text;
  }
  return "";
}

function partHasAttachment(part: NonNullable<GmailMessage["payload"]> | undefined): boolean {
  if (!part) return false;
  if (part.filename || part.body?.attachmentId) return true;
  return (part.parts ?? []).some(partHasAttachment);
}

function textContentFromAssistant(message: Awaited<ReturnType<typeof complete>>): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function categoryFromLabels(labels: Set<string>): string | undefined {
  for (const [labelId, category] of Object.entries(GMAIL_SYSTEM_CATEGORIES)) {
    if (labels.has(labelId)) return category;
  }
  return undefined;
}

function slug(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || "directive";
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function fromDomain(from: string): string {
  const email = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const domain = /@([^>\s,]+)/.exec(email)?.[1] ?? "";
  return domain.toLowerCase();
}

function normalizeEmailAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = /<([^>]+)>/.exec(value)?.[1] ?? value;
  const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(candidate);
  return match?.[0].toLowerCase();
}

function parseAddressList(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(",") : value ?? "";
  return Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
    .map((match) => match[0]!.toLowerCase());
}

function defaultAttentionRules(): GmailAttentionRuleSet {
  return {
    version: 1,
    directives: [
      {
        id: "prior-replies",
        name: "People you have replied to",
        description:
          "Wake only for unread inbox mail from senders you have replied to before.",
        enabled: true,
        scope: "metadata",
        priority: 100,
        match: {
          all: [
            { field: "priorReplyToSender", op: "present" },
            { field: "label", op: "contains", value: "INBOX" },
            { field: "label", op: "contains", value: "UNREAD" },
          ],
        },
        actions: ["surface", "summarize"],
      },
    ],
  };
}

function validateAttentionRules(value: unknown): GmailAttentionRuleSet {
  const root = record(value);
  if (root["version"] !== 1) throw new Error("attention rules version must be 1");
  const rawDirectives = root["directives"];
  if (!Array.isArray(rawDirectives)) throw new Error("attention rules directives must be an array");
  if (rawDirectives.length > 50) throw new Error("attention rules can contain at most 50 directives");
  const ids = new Set<string>();
  const directives = rawDirectives.map((item, index): GmailAttentionDirective => {
    const directive = record(item);
    const id = typeof directive["id"] === "string" ? slug(directive["id"]) : `directive-${index + 1}`;
    if (ids.has(id)) throw new Error(`duplicate attention directive id: ${id}`);
    ids.add(id);
    const name =
      typeof directive["name"] === "string" && directive["name"].trim()
        ? directive["name"].trim().slice(0, 120)
        : id;
    const scope =
      directive["scope"] === "full-thread-on-wake" || directive["scope"] === "metadata"
        ? directive["scope"]
        : "snippet";
    const actions: GmailAttentionAction[] = Array.isArray(directive["actions"])
      ? directive["actions"].filter((action): action is GmailAttentionAction =>
          (GMAIL_ATTENTION_ACTIONS as readonly string[]).includes(String(action))
        )
      : ["surface"];
    const match = validateMatcher(directive["match"]);
    return {
      id,
      name,
      ...(typeof directive["description"] === "string"
        ? { description: directive["description"].slice(0, 500) }
        : {}),
      enabled: directive["enabled"] !== false,
      scope,
      priority: Math.max(0, Math.min(Number(directive["priority"] ?? 50) || 50, 1000)),
      match,
      actions: actions.length > 0 ? actions : (["surface"] satisfies GmailAttentionAction[]),
    };
  });
  return { version: 1, directives };
}

function validateMatcher(value: unknown): GmailAttentionMatcher {
  const matcher = record(value);
  const next: GmailAttentionMatcher = {};
  for (const key of ["any", "all", "not"] as const) {
    const raw = matcher[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new Error(`attention matcher ${key} must be an array`);
    next[key] = raw.map(validateCondition);
    if (next[key]!.length > 25) throw new Error(`attention matcher ${key} has too many conditions`);
  }
  if (!next.any && !next.all) throw new Error("attention matcher requires any or all conditions");
  return next;
}

function validateCondition(value: unknown): GmailAttentionCondition {
  const condition = record(value);
  const field = condition["field"];
  if (
    ![
      ...(GMAIL_ATTENTION_FIELDS as readonly string[])
    ].includes(String(field))
  ) {
    throw new Error(`unsupported attention condition field: ${String(field)}`);
  }
  const op = condition["op"];
  if (
    op !== undefined &&
    !(GMAIL_ATTENTION_OPERATORS as readonly string[]).includes(String(op))
  ) {
    throw new Error(`unsupported attention condition op: ${String(op)}`);
  }
  const valueText = typeof condition["value"] === "string" ? condition["value"].slice(0, 500) : undefined;
  if (
    field !== "hasAttachment" &&
    field !== "priorReplyToSender" &&
    field !== "wakeAll" &&
    !valueText
  ) {
    throw new Error(`attention condition ${String(field)} requires value`);
  }
  if (op === "matches" && valueText) new RegExp(valueText);
  return {
    field: field as GmailAttentionCondition["field"],
    ...(op ? { op: op as GmailAttentionCondition["op"] } : {}),
    ...(valueText ? { value: valueText } : {}),
  };
}

function conditionMatches(condition: GmailAttentionCondition, event: GmailAttentionEvent): boolean {
  if (condition.field === "wakeAll") return true;
  if (condition.field === "hasAttachment") return event.hasAttachment;
  if (condition.field === "priorReplyToSender") return event.priorReplyToSender === true;
  const haystack =
    condition.field === "fromDomain"
      ? fromDomain(event.from)
      : condition.field === "from"
        ? event.from
        : condition.field === "to"
          ? event.to
          : condition.field === "subject"
            ? event.subject
            : condition.field === "snippet"
              ? event.snippet
              : condition.field === "label"
                ? event.labels.join(" ")
                : event.category ?? "";
  const needle = condition.value ?? "";
  const op = condition.op ?? (condition.field === "fromDomain" ? "equals" : "contains");
  if (op === "present") return Boolean(haystack);
  if (op === "equals") return normalizeText(haystack) === normalizeText(needle);
  if (op === "matches") return new RegExp(needle, "i").test(haystack);
  return normalizeText(haystack).includes(normalizeText(needle));
}

function directiveDecision(
  directive: GmailAttentionDirective,
  event: GmailAttentionEvent
): GmailAttentionDecision | null {
  if (!directive.enabled) return null;
  if (directive.match.not?.some((condition) => conditionMatches(condition, event))) return null;
  const anyOk = directive.match.any
    ? directive.match.any.some((condition) => conditionMatches(condition, event))
    : true;
  const allOk = directive.match.all
    ? directive.match.all.every((condition) => conditionMatches(condition, event))
    : true;
  if (!anyOk || !allOk) return null;
  return {
    wake: true,
    directiveId: directive.id,
    directiveName: directive.name,
    reason: directive.description ?? directive.name,
    actions: directive.actions,
  };
}

function parseActionsJson(value: unknown): GmailAttentionAction[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is GmailAttentionAction =>
          (GMAIL_ATTENTION_ACTIONS as readonly string[]).includes(String(item))
        )
      : ["surface"];
  } catch {
    return ["surface"];
  }
}

function maxInternalDate(thread: GmailThread): number {
  const newest = Math.max(
    ...(thread.messages ?? [])
      .map((m) => Number(m.internalDate ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  return Number.isFinite(newest) && newest > 0 ? newest : Date.now();
}

function isExcludedActionableCategory(labels: Set<string>): boolean {
  return (
    labels.has("CATEGORY_PROMOTIONS") ||
    labels.has("CATEGORY_SOCIAL") ||
    labels.has("CATEGORY_UPDATES") ||
    labels.has("CATEGORY_FORUMS")
  );
}

function addressHeaderIncludes(
  message: GmailMessage | undefined,
  email: string | undefined
): boolean {
  if (!message || !email) return false;
  const normalizedEmail = email.toLowerCase();
  const recipients = [header(message, "To"), header(message, "Cc"), header(message, "Bcc")]
    .filter((value): value is string => Boolean(value))
    .join(",")
    .toLowerCase();
  return recipients.includes(normalizedEmail);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

function toolResult(details: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function threadCardState(
  thread: GmailThread,
  category?: string | null,
  userEmail?: string,
  attention?: GmailAttentionDecision
): GmailThreadCardState {
  const message = latestMessage(thread) ?? thread.messages?.[0];
  const labels = new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? []));
  const latestLabels = new Set(message?.labelIds ?? []);
  const resolvedCategory = category ?? categoryFromLabels(labels);
  const unread = labels.has("UNREAD");
  const inInbox = labels.has("INBOX");
  const actionable =
    latestLabels.has("UNREAD") &&
    !isExcludedActionableCategory(labels) &&
    addressHeaderIncludes(message, userEmail);
  const updatedAt = maxInternalDate(thread);
  return {
    threadId: thread.id,
    subject: (message && header(message, "Subject")) || "(no subject)",
    from: (message && header(message, "From")) || "",
    snippet: message?.snippet ?? "",
    participants: Array.from(
      new Set(
        (thread.messages ?? [])
          .flatMap((m) => [header(m, "From"), header(m, "To")])
          .filter((value): value is string => Boolean(value))
      )
    ),
    lastSnippet: message?.snippet ?? "",
    unreadCount: unread ? 1 : 0,
    hasDraft: false,
    status: unread ? "unread" : inInbox ? "open" : "archived",
    unread,
    inInbox,
    actionable: actionable || Boolean(attention?.wake),
    ...(attention?.wake ? { attention } : {}),
    ...(resolvedCategory ? { category: resolvedCategory } : {}),
    updatedAt,
  };
}

function attentionEventFromThread(
  thread: GmailThread,
  userEmail?: string
): GmailAttentionEvent | null {
  const message = latestMessage(thread) ?? thread.messages?.[0];
  if (!message) return null;
  const labels = Array.from(new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? [])));
  const labelSet = new Set(labels);
  return {
    threadId: thread.id,
    messageId: message.id,
    from: header(message, "From") ?? "",
    to: [header(message, "To"), header(message, "Cc"), header(message, "Bcc")]
      .filter((value): value is string => Boolean(value))
      .join(", "),
    subject: header(message, "Subject") ?? "",
    snippet: message.snippet ?? "",
    labels,
    ...(categoryFromLabels(labelSet) ? { category: categoryFromLabels(labelSet) } : {}),
    hasAttachment: (thread.messages ?? []).some((item) => partHasAttachment(item.payload)),
    unread: labelSet.has("UNREAD"),
    inInbox: labelSet.has("INBOX"),
    addressedToUser: addressHeaderIncludes(message, userEmail),
    internalDate: Number(message.internalDate ?? 0) || undefined,
  };
}

export class GmailAgentWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  private gmailClients = new Map<string, GmailClient>();
  private recoveredChannels = new Set<string>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Gmail");
  }

  protected override createTables(): void {
    super.createTables();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_channel_state (
        channel_id TEXT PRIMARY KEY,
        history_id TEXT,
        email_address TEXT,
        credential_id TEXT,
        poll_interval_ms INTEGER NOT NULL,
        inbox_message_id TEXT,
        last_sync_at INTEGER,
        last_error TEXT,
        last_overview_json TEXT,
        last_search_query TEXT,
        last_search_json TEXT,
        setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences',
        setup_prompted_at INTEGER,
        configured_at INTEGER,
        setup_summary TEXT
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN last_overview_json TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN email_address TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN credential_id TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN last_search_query TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN last_search_json TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(
        `ALTER TABLE gmail_channel_state ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences'`
      );
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN setup_prompted_at INTEGER`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN configured_at INTEGER`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN setup_summary TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_threads (
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        subject TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        snippet TEXT NOT NULL,
        unread INTEGER NOT NULL,
        in_inbox INTEGER NOT NULL,
        actionable INTEGER NOT NULL DEFAULT 0,
        category TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, thread_id)
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE gmail_threads ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists on upgraded objects.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_categories (
        channel_id TEXT NOT NULL,
        category TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY(channel_id, category)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_attention_rules (
        channel_id TEXT PRIMARY KEY,
        rules_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_attention_hits (
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        directive_id TEXT NOT NULL,
        directive_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        matched_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, thread_id, directive_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_replied_senders (
        channel_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display TEXT,
        first_replied_at INTEGER NOT NULL,
        last_replied_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(channel_id, email)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_attention_turns (
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        directive_id TEXT NOT NULL,
        last_message_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, thread_id, directive_id)
      )
    `);
  }

  protected gmailForChannel(channelId: string): GmailClient {
    const credentialId = this.getGmailCredentialId(channelId);
    const key = credentialId ?? "__default__";
    let client = this.gmailClients.get(key);
    if (!client) {
      client = this.createGmailClient(credentialId);
      this.gmailClients.set(key, client);
    }
    return client;
  }

  protected createGmailClient(credentialId?: string): GmailClient {
    return createGmailClient(this.credentials, credentialId ? { credentialId } : {});
  }

  private getGmailCredentialId(channelId: string): string | undefined {
    const state = this.getChannelState(channelId);
    if (state.credentialId) return state.credentialId;
    const config = record(this.subscriptions.getConfig(channelId));
    return stringArg(config, "googleCredentialId") ?? stringArg(config, "credentialId") ?? undefined;
  }

  protected override getDefaultModel(): string {
    return "openai-codex:gpt-5.5";
  }

  protected async generateDraftReplyBody(channelId: string, thread: GmailThread): Promise<string> {
    const modelName = this.getModel(channelId);
    const colonIdx = modelName.indexOf(":");
    if (colonIdx < 0) throw new Error(`Model must be "provider:model", got: ${modelName}`);
    const provider = modelName.slice(0, colonIdx);
    const modelId = modelName.slice(colonIdx + 1);
    const model = getPiModel(provider as never, modelId as never);
    if (!model) throw new Error(`No model metadata found for model provider: ${provider}`);

    const latest = latestMessage(thread);
    const context: Context = {
      systemPrompt: [
        "Draft a concise Gmail reply.",
        "Return only the email body, without a subject, greeting explanation, markdown, or signoff unless the thread clearly calls for one.",
        "Do not invent facts. If the answer needs missing information, ask for it briefly.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            `Subject: ${latest ? (header(latest, "Subject") ?? "") : ""}`,
            "",
            "Thread:",
            ...(thread.messages ?? []).map((message) =>
              [
                `From: ${header(message, "From") ?? ""}`,
                `Date: ${header(message, "Date") ?? ""}`,
                textFromPart(message.payload).slice(0, 4_000) || message.snippet || "",
              ].join("\n")
            ),
          ]
            .join("\n\n")
            .slice(0, 16_000),
        },
      ],
    };
    const response = await complete(model, context, {
      apiKey: await this.getApiKeyForChannel(channelId, {
        resumeCurrentTurnOnMissingCredential: false,
      })(),
      temperature: 0.2,
      maxTokens: 300,
    });
    return (
      textContentFromAssistant(response) ||
      "Thanks for the note. I will take a look and follow up shortly."
    );
  }

  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned-or-followup";
  }

  protected override getRunnerPromptConfig(_channelId: string): {
    systemPrompt?: string;
    systemPromptMode?: "replace";
  } {
    return {
      systemPromptMode: "replace",
      systemPrompt: [
        "You are the Gmail agent for this channel.",
        "Operate narrowly on Gmail tasks: inbox triage, search, summaries, drafting replies, sending only when requested, archiving, marking read, and explaining Gmail sync state.",
        "Treat the Gmail inbox card as the shared mail desk: keep passive sync state there, and create compose cards only for explicit draft or compose actions.",
        "For incoming mail attention, do not run semantic analysis over every message by default. Ask what the user wants watched, then use the eval tool to call this Gmail worker's public attention-rule RPC methods, or use normal workspace dev/file tools for deeper code changes.",
        "Your built-in default attention filter wakes only for unread inbox mail from senders the user has replied to before.",
        "Attention logic should wake on static metadata/snippet factors first: sender, domain, recipients, subject, snippet, labels, category, attachments, or an explicit wake-all directive.",
        "To edit attention rules from eval, resolve this Durable Object with workers.resolveDurableObject('workers/gmail-agent', 'GmailAgentWorker', `gmail-${channelId}`), then call listAttentionRules/upsertAttentionRule/setAttentionRuleEnabled/deleteAttentionRule/clearAttentionRules/resetAttentionRules on that target.",
        "When first-run attention setup is actually complete, call gmail_markConfigured with a concise summary. Do not mark configured merely because you asked the initial question.",
        "Do not start work unless invoked by an action bar, a Gmail custom message, an explicit @gmail mention, or a direct user follow-up immediately after one of your messages.",
        "In multi-agent channels, use roster and channel-context notes to recognize when another agent is active or addressed. If no Gmail intervention is useful, call close_turn_without_response instead of sending a visible reply.",
        "Prefer Gmail methods and concise answers. Never invent message contents.",
      ].join("\n"),
    };
  }

  protected override getRunnerTools(channelId: string): PiRunnerOptions["extraTools"] {
    return [
      this.gmailTool(
        "gmail_checkInbox",
        "Synchronize Gmail now and refresh Gmail cards.",
        EMPTY_TOOL_SCHEMA,
        async (_toolCallId, params) => this.syncChannel(channelId)
      ),
      this.gmailTool(
        "gmail_markConfigured",
        "Mark first-run Gmail setup complete after the requested attention behavior has been implemented or confirmed. Parameters: { summary?: string }.",
        MARK_CONFIGURED_TOOL_SCHEMA,
        async (_toolCallId, params) => this.markConfigured(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_search",
        "Search Gmail. Parameters: { q: string, limit?: number }.",
        SEARCH_TOOL_SCHEMA,
        async (_toolCallId, params) => this.search(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_summarizeThread",
        "Fetch sanitized thread contents for summarization. Parameters: { threadId: string }.",
        THREAD_ID_TOOL_SCHEMA,
        async (_toolCallId, params) => this.getThread(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_draftReply",
        "Create a reply compose card. Parameters: { threadId: string }.",
        THREAD_ID_TOOL_SCHEMA,
        async (_toolCallId, params) => this.draftReply(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_send",
        "Send a Gmail message. Parameters: { to: string, cc?: string, bcc?: string, subject: string, body: string, threadId?: string, messageId?: string }.",
        SEND_TOOL_SCHEMA,
        async (_toolCallId, params) => this.send(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_saveDraft",
        "Save a Gmail draft. Parameters: { to: string, cc?: string, bcc?: string, subject: string, body: string, threadId?: string, messageId?: string }.",
        SEND_TOOL_SCHEMA,
        async (_toolCallId, params) => this.saveDraft(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_archiveThread",
        "Archive a Gmail thread locally and in Gmail. Parameters: { threadId: string }.",
        THREAD_ID_TOOL_SCHEMA,
        async (_toolCallId, params) => this.archiveThread(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_markRead",
        "Mark a Gmail thread read. Parameters: { threadId: string }.",
        THREAD_ID_TOOL_SCHEMA,
        async (_toolCallId, params) => this.markRead(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_categorize",
        "Set a local category for a Gmail thread. Parameters: { threadId: string, category: string }.",
        CATEGORIZE_TOOL_SCHEMA,
        async (_toolCallId, params) => this.categorize(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_clearSearch",
        "Clear the Gmail desk search results.",
        EMPTY_TOOL_SCHEMA,
        async () => this.clearSearch(channelId)
      ),
      this.gmailTool(
        "gmail_setPollInterval",
        "Configure Gmail polling. Parameters: { pollIntervalMs: number }.",
        POLL_INTERVAL_TOOL_SCHEMA,
        async (_toolCallId, params) => this.setPollInterval(channelId, record(params))
      ),
      this.gmailTool(
        "gmail_listActionableThreads",
        "List current unread or inbox threads. Parameters: { limit?: number }.",
        LIST_THREADS_TOOL_SCHEMA,
        async (_toolCallId, params) =>
          this.listActionableThreads(channelId, numberArg(record(params), "limit") ?? 6)
      ),
    ];
  }

  private gmailTool(
    name: string,
    description: string,
    parameters: GmailToolParameters,
    execute: (toolCallId: string, params: unknown) => Promise<unknown> | unknown
  ): GmailTool {
    return {
      name,
      label: name,
      description,
      parameters,
      execute: async (toolCallId, params) => toolResult(await execute(toolCallId, params)),
    } as GmailTool;
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "gmail",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "Gmail",
      type: "agent",
      metadata: { provider: "gmail" },
      methods: [
        { name: "checkNow", description: "Synchronize Gmail now" },
        { name: "markConfigured", description: "Mark first-run Gmail setup complete" },
        { name: "categorize", description: "Set a local category for a Gmail thread" },
        { name: "draftReply", description: "Create a reply compose card for a Gmail thread" },
        { name: "send", description: "Send a Gmail message or compose card" },
        { name: "saveDraft", description: "Save a Gmail draft from a compose card" },
        { name: "discardCompose", description: "Mark a Gmail compose card discarded" },
        { name: "archiveThread", description: "Archive a Gmail thread" },
        { name: "markRead", description: "Mark a Gmail thread read" },
        { name: "compose", description: "Create a Gmail compose card" },
        { name: "search", description: "Search Gmail and publish a result card" },
        { name: "clearSearch", description: "Clear Gmail search results from the inbox card" },
        { name: "listActionableThreads", description: "Return current actionable Gmail threads" },
        { name: "setPollInterval", description: "Configure Gmail polling interval" },
        { name: "getThread", description: "Fetch sanitized Gmail thread contents" },
        ...this.getStandardAgentMethods(),
      ],
    };
  }

  override async subscribeChannel(
    opts: Parameters<AgentWorkerBase["subscribeChannel"]>[0]
  ): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    const credentialId =
      stringArg(record(opts.config), "googleCredentialId") ??
      stringArg(record(opts.config), "credentialId");
    if (credentialId) {
      const state = this.getChannelState(opts.channelId);
      state.credentialId = credentialId;
      this.saveChannelState(state);
    }
    await this.installChannelUi(opts.channelId);
    this.setAlarm(this.getChannelState(opts.channelId).pollIntervalMs);
    await this.startSetupTurnIfNeeded(opts.channelId);
    return result;
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    const states = this.sql.exec(`SELECT channel_id FROM gmail_channel_state`).toArray();
    for (const row of states) {
      const channelId = String(row["channel_id"]);
      await this.ensureRecovered(channelId);
      await this.syncChannel(channelId).catch((err) => {
        this.recordSyncError(channelId, err);
        console.error(`[GmailAgentWorker] sync failed for channel=${channelId}:`, err);
      });
    }
    const intervals = this.sql.exec(`SELECT poll_interval_ms FROM gmail_channel_state`).toArray();
    const next = intervals
      .map((row) => Number(row["poll_interval_ms"]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0];
    if (next) this.setAlarm(next);
  }

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      const standardResult = await this.handleStandardAgentMethodCall(channelId, methodName, args);
      if (standardResult) return standardResult;

      switch (methodName) {
        case "checkNow":
          await this.ensureRecovered(channelId);
          return { result: await this.syncChannel(channelId) };
        case "markConfigured":
          return { result: await this.markConfigured(channelId, record(args)) };
        case "categorize":
          await this.ensureRecovered(channelId);
          return { result: await this.categorize(channelId, record(args)) };
        case "draftReply":
          await this.ensureRecovered(channelId);
          return { result: await this.draftReply(channelId, record(args)) };
        case "send":
          await this.ensureRecovered(channelId);
          return { result: await this.send(channelId, record(args)) };
        case "saveDraft":
          await this.ensureRecovered(channelId);
          return { result: await this.saveDraft(channelId, record(args)) };
        case "discardCompose":
          return { result: await this.discardCompose(channelId, record(args)) };
        case "archiveThread":
          await this.ensureRecovered(channelId);
          return { result: await this.archiveThread(channelId, record(args)) };
        case "markRead":
          await this.ensureRecovered(channelId);
          return { result: await this.markRead(channelId, record(args)) };
        case "compose":
          return { result: await this.compose(channelId, record(args)) };
        case "search":
          await this.ensureRecovered(channelId);
          return { result: await this.search(channelId, record(args)) };
        case "clearSearch":
          return { result: await this.clearSearch(channelId) };
        case "listActionableThreads":
          await this.ensureRecovered(channelId);
          return {
            result: this.listActionableThreads(channelId, numberArg(record(args), "limit") ?? 6),
          };
        case "setPollInterval":
          return { result: this.setPollInterval(channelId, record(args)) };
        case "getThread":
          return { result: await this.getThread(channelId, record(args)) };
        default:
          return { result: { error: `unknown method: ${methodName}` }, isError: true };
      }
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gmail_channel_state (channel_id, poll_interval_ms) VALUES (?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS
    );
  }

  private getChannelState(channelId: string): GmailChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      historyId: row["history_id"] as string | undefined,
      emailAddress: row["email_address"] as string | undefined,
      credentialId: row["credential_id"] as string | undefined,
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      inboxMessageId: row["inbox_message_id"] as string | undefined,
      lastSyncAt: row["last_sync_at"] as number | undefined,
      lastError: row["last_error"] as string | undefined,
      lastOverviewJson: row["last_overview_json"] as string | undefined,
      lastSearchQuery: row["last_search_query"] as string | undefined,
      lastSearchJson: row["last_search_json"] as string | undefined,
      setupStatus:
        row["setup_status"] === "configured" ? "configured" : "needs-user-preferences",
      setupPromptedAt: row["setup_prompted_at"] as number | undefined,
      configuredAt: row["configured_at"] as number | undefined,
      setupSummary: row["setup_summary"] as string | undefined,
    };
  }

  private saveChannelState(state: GmailChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_channel_state
       (channel_id, history_id, email_address, credential_id, poll_interval_ms, inbox_message_id, last_sync_at, last_error, last_overview_json, last_search_query, last_search_json, setup_status, setup_prompted_at, configured_at, setup_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.historyId ?? null,
      state.emailAddress ?? null,
      state.credentialId ?? null,
      state.pollIntervalMs,
      state.inboxMessageId ?? null,
      state.lastSyncAt ?? null,
      state.lastError ?? null,
      state.lastOverviewJson ?? null,
      state.lastSearchQuery ?? null,
      state.lastSearchJson ?? null,
      state.setupStatus,
      state.setupPromptedAt ?? null,
      state.configuredAt ?? null,
      state.setupSummary ?? null
    );
  }

  private getAttentionRulesRecord(channelId: string): GmailAttentionRuleSetRecord {
    const row = this.sql
      .exec(`SELECT * FROM gmail_attention_rules WHERE channel_id = ?`, channelId)
      .toArray()[0];
    if (!row) {
      const ruleSet = defaultAttentionRules();
      return {
        channelId,
        ruleSet,
        updatedAt: 0,
      };
    }
    try {
      const ruleSet = validateAttentionRules(JSON.parse(String(row["rules_json"])));
      return {
        channelId,
        ruleSet,
        updatedAt: Number(row["updated_at"] ?? 0),
      };
    } catch {
      const ruleSet = defaultAttentionRules();
      return {
        channelId,
        ruleSet,
        updatedAt: Number(row["updated_at"] ?? 0),
      };
    }
  }

  private saveAttentionRules(channelId: string, ruleSet: GmailAttentionRuleSet): void {
    const normalized = validateAttentionRules(ruleSet);
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_rules
       (channel_id, rules_json, updated_at)
       VALUES (?, ?, ?)`,
      channelId,
      JSON.stringify(normalized),
      Date.now()
    );
  }

  private assertSubscribedChannel(channelId: string): void {
    if (!channelId || !this.subscriptions.getParticipantId(channelId)) {
      throw new Error(`Gmail agent is not subscribed to channel: ${channelId}`);
    }
  }

  private assertAttentionRuleWriteAllowed(): void {
    const caller = this.caller;
    if (!caller) return;
    if (["panel", "shell", "server", "harness"].includes(caller.callerKind)) return;
    throw new Error("Gmail attention rule changes must be initiated from a user-facing panel");
  }

  private async startSetupTurnIfNeeded(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured" || state.setupPromptedAt) return;
    await this.submitAgentInitiatedTurn(channelId, { content: GMAIL_SETUP_ONBOARDING_PROMPT }, {
      mode: "sequential",
      steeringId: `gmail-setup:${channelId}`,
    });
    state.setupPromptedAt = Date.now();
    this.saveChannelState(state);
  }

  private async installChannelUi(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    for (const renderer of GMAIL_RENDERERS) {
      const event: AgenticEvent<"messageType.registered"> = {
        kind: "messageType.registered",
        actor,
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          typeId: renderer.typeId,
          displayMode: renderer.displayMode,
          source: { type: "file", path: renderer.path },
          imports: GMAIL_UI_IMPORTS,
          registeredBy: actor,
        },
        createdAt: new Date().toISOString(),
      };
      await channel.publishAgenticEvent(actor.id, event, {
        idempotencyKey: `gmail:ui:v${GMAIL_UI_INSTALL_VERSION}:message-type:${renderer.typeId}`,
        senderMetadata: actor.metadata,
      });
    }

    const actionBarEvent: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "gmail-action-bar",
        source: { type: "file", path: GMAIL_ACTION_BAR_FILE },
        imports: GMAIL_UI_IMPORTS,
        maxHeight: GMAIL_ACTION_BAR_MAX_HEIGHT,
        result: { ok: true },
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, actionBarEvent, {
      idempotencyKey: `gmail:ui:v${GMAIL_UI_INSTALL_VERSION}:action-bar`,
      senderMetadata: actor.metadata,
    });
  }

  private async markConfigured(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ configured: true; configuredAt: string; summary?: string }> {
    const state = this.getChannelState(channelId);
    const summary = stringArg(args, "summary")?.slice(0, 500);
    state.setupStatus = "configured";
    state.configuredAt = Date.now();
    state.setupSummary = summary;
    this.saveChannelState(state);
    await this.publishOverview(channelId);
    return {
      configured: true,
      configuredAt: new Date(state.configuredAt).toISOString(),
      ...(summary ? { summary } : {}),
    };
  }

  async listAttentionRules(channelId: string): Promise<GmailAttentionRulesSnapshot> {
    this.assertSubscribedChannel(channelId);
    const record = this.getAttentionRulesRecord(channelId);
    return {
      channelId,
      rules: record.ruleSet.directives,
      ruleSet: record.ruleSet,
      updatedAt: record.updatedAt,
      capabilities: {
        fields: GMAIL_ATTENTION_FIELDS,
        operators: GMAIL_ATTENTION_OPERATORS,
        actions: GMAIL_ATTENTION_ACTIONS,
        scopes: GMAIL_ATTENTION_SCOPES,
      },
      rpc: {
        source: "workers/gmail-agent",
        className: "GmailAgentWorker",
        objectKey: gmailAgentObjectKey(channelId),
        resolveMethod: "workers.resolveDurableObject",
      },
    };
  }

  async upsertAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    const input = record(args);
    const rawRule = input["rule"] ?? input["directive"] ?? input;
    const rule = validateAttentionRules({ version: 1, directives: [rawRule] }).directives[0]!;
    const current = this.getAttentionRulesRecord(channelId).ruleSet;
    const directives = [
      ...current.directives.filter((directive) => directive.id !== rule.id),
      rule,
    ].sort((a, b) => b.priority - a.priority);
    const ruleSet = validateAttentionRules({ version: 1, directives });
    this.saveAttentionRules(channelId, ruleSet);
    await this.recomputeAttentionForStoredThreads(channelId);
    await this.publishOverview(channelId);
    return { saved: true, rule, ruleSet };
  }

  async setAttentionRuleEnabled(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    const input = record(args);
    const id = slug(stringArg(input, "id") ?? "");
    if (!id) throw new Error("setAttentionRuleEnabled requires id");
    const enabled = booleanArg(input, "enabled");
    if (enabled === undefined) throw new Error("setAttentionRuleEnabled requires enabled");
    const current = this.getAttentionRulesRecord(channelId).ruleSet;
    const rule = current.directives.find((directive) => directive.id === id);
    if (!rule) throw new Error(`attention rule not found: ${id}`);
    const ruleSet = validateAttentionRules({
      version: 1,
      directives: current.directives.map((directive) =>
        directive.id === id ? { ...directive, enabled } : directive
      ),
    });
    this.saveAttentionRules(channelId, ruleSet);
    await this.recomputeAttentionForStoredThreads(channelId);
    await this.publishOverview(channelId);
    return {
      saved: true,
      rule: ruleSet.directives.find((directive) => directive.id === id)!,
      ruleSet,
    };
  }

  async deleteAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ deleted: true; id: string; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    const id = slug(stringArg(record(args), "id") ?? "");
    if (!id) throw new Error("deleteAttentionRule requires id");
    const current = this.getAttentionRulesRecord(channelId).ruleSet;
    const ruleSet = validateAttentionRules({
      version: 1,
      directives: current.directives.filter((directive) => directive.id !== id),
    });
    if (ruleSet.directives.length === current.directives.length) {
      throw new Error(`attention rule not found: ${id}`);
    }
    this.saveAttentionRules(channelId, ruleSet);
    await this.recomputeAttentionForStoredThreads(channelId);
    await this.publishOverview(channelId);
    return { deleted: true, id, ruleSet };
  }

  async clearAttentionRules(channelId: string): Promise<{
    cleared: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    const ruleSet = validateAttentionRules({ version: 1, directives: [] });
    this.saveAttentionRules(channelId, ruleSet);
    await this.recomputeAttentionForStoredThreads(channelId);
    await this.publishOverview(channelId);
    return { cleared: true, ruleSet, rules: [] };
  }

  async resetAttentionRules(channelId: string): Promise<{
    reset: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    const ruleSet = defaultAttentionRules();
    this.saveAttentionRules(channelId, ruleSet);
    await this.recomputeAttentionForStoredThreads(channelId);
    await this.publishOverview(channelId);
    return { reset: true, ruleSet, rules: ruleSet.directives };
  }

  private evaluateAttentionRules(
    ruleSet: GmailAttentionRuleSet,
    event: GmailAttentionEvent
  ): GmailAttentionDecision {
    const matches = ruleSet.directives
      .map((directive) => directiveDecision(directive, event))
      .filter((decision): decision is GmailAttentionDecision => Boolean(decision))
      .sort((a, b) => {
        const aDirective = ruleSet.directives.find((directive) => directive.id === a.directiveId);
        const bDirective = ruleSet.directives.find((directive) => directive.id === b.directiveId);
        return (bDirective?.priority ?? 0) - (aDirective?.priority ?? 0);
      });
    return matches[0] ?? { wake: false };
  }

  private recordAttentionHit(
    channelId: string,
    threadId: string,
    decision: GmailAttentionDecision
  ): void {
    if (!decision.wake || !decision.directiveId || !decision.directiveName) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_hits
       (channel_id, thread_id, directive_id, directive_name, reason, actions_json, matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      threadId,
      decision.directiveId,
      decision.directiveName,
      decision.reason ?? decision.directiveName,
      JSON.stringify(decision.actions ?? ["surface"]),
      Date.now()
    );
  }

  private recordRepliedSender(
    channelId: string,
    email: string | undefined,
    display: string | undefined,
    source: "sent-mail" | "send"
  ): void {
    if (!email) return;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO gmail_replied_senders
       (channel_id, email, display, first_replied_at, last_replied_at, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, email) DO UPDATE SET
         display = COALESCE(excluded.display, gmail_replied_senders.display),
         last_replied_at = excluded.last_replied_at,
         source = excluded.source`,
      channelId,
      email.toLowerCase(),
      display ?? null,
      now,
      now,
      source
    );
  }

  private hasRepliedToSender(channelId: string, from: string): boolean {
    const email = normalizeEmailAddress(from);
    if (!email) return false;
    const row = this.sql
      .exec(
        `SELECT email FROM gmail_replied_senders WHERE channel_id = ? AND email = ? LIMIT 1`,
        channelId,
        email
      )
      .toArray()[0];
    return Boolean(row);
  }

  private async seedRepliedSendersFromSentMail(channelId: string): Promise<void> {
    const gmail = this.gmailForChannel(channelId);
    const result = await gmail.search("in:sent", {
      maxResults: 50,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Bcc"],
    });
    for (const message of result.messages) {
      for (const headerName of ["To", "Cc", "Bcc"]) {
        for (const email of parseAddressList(header(message, headerName))) {
          this.recordRepliedSender(channelId, email, email, "sent-mail");
        }
      }
    }
  }

  private shouldStartAttentionTurn(
    channelId: string,
    event: GmailAttentionEvent,
    decision: GmailAttentionDecision
  ): boolean {
    if (!decision.wake || !decision.directiveId) return false;
    if (!event.unread || !event.inInbox) return false;
    const messageKey = event.messageId ?? String(event.internalDate ?? "unknown");
    const row = this.sql
      .exec(
        `SELECT last_message_id FROM gmail_attention_turns
         WHERE channel_id = ? AND thread_id = ? AND directive_id = ?`,
        channelId,
        event.threadId,
        decision.directiveId
      )
      .toArray()[0];
    if (String(row?.["last_message_id"] ?? "") === messageKey) return false;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_turns
       (channel_id, thread_id, directive_id, last_message_id, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      event.threadId,
      decision.directiveId,
      messageKey,
      Date.now()
    );
    return true;
  }

  private async startAttentionTurn(
    channelId: string,
    event: GmailAttentionEvent,
    decision: GmailAttentionDecision
  ): Promise<void> {
    if (!this.shouldStartAttentionTurn(channelId, event, decision)) return;
    const actions = decision.actions?.length ? decision.actions.join(", ") : "surface";
    await this.submitAgentInitiatedTurn(
      channelId,
      {
        content: [
          "A new Gmail message matched your deterministic attention rules.",
          "",
          `Thread: ${event.threadId}`,
          `From: ${event.from || "(unknown)"}`,
          `To: ${event.to || "(unknown)"}`,
          `Subject: ${event.subject || "(no subject)"}`,
          `Reason: ${decision.reason ?? decision.directiveName ?? decision.directiveId}`,
          `Requested actions: ${actions}`,
          "",
          `Snippet: ${event.snippet || "(none)"}`,
          "",
          "Use Gmail tools only if needed. Do not send mail without an explicit user request.",
        ].join("\n"),
      },
      {
        mode: "sequential",
        steeringId: `gmail-attention:${channelId}:${event.threadId}:${decision.directiveId}:${event.messageId ?? event.internalDate ?? "message"}`,
      }
    );
  }

  private attentionHits(channelId: string, limit = 8): GmailAttentionHit[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ?
         ORDER BY matched_at DESC
         LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 50))
      )
      .toArray();
    return rows.map((row) => ({
      threadId: String(row["thread_id"]),
      directiveId: String(row["directive_id"]),
      directiveName: String(row["directive_name"]),
      reason: String(row["reason"]),
      actions: parseActionsJson(row["actions_json"]),
      matchedAt: Number(row["matched_at"] ?? 0),
    }));
  }

  private attentionHitForThread(channelId: string, threadId: string): GmailAttentionHit | null {
    const row = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ? AND thread_id = ?
         ORDER BY matched_at DESC
         LIMIT 1`,
        channelId,
        threadId
      )
      .toArray()[0];
    return row
      ? {
          threadId,
          directiveId: String(row["directive_id"]),
          directiveName: String(row["directive_name"]),
          reason: String(row["reason"]),
          actions: parseActionsJson(row["actions_json"]),
          matchedAt: Number(row["matched_at"] ?? 0),
        }
      : null;
  }

  private async recomputeAttentionForStoredThreads(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    this.sql.exec(`DELETE FROM gmail_attention_hits WHERE channel_id = ?`, channelId);
    const rows = this.sql
      .exec(`SELECT thread_id FROM gmail_threads WHERE channel_id = ?`, channelId)
      .toArray();
    for (const row of rows) {
      const threadId = String(row["thread_id"]);
      try {
        await this.refreshThread(channelId, threadId, state.emailAddress);
      } catch {
        // Stale or inaccessible threads will be reconciled by the next Gmail sync.
      }
    }
  }

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);

    const folded = await this.indexOwnCustomMessages(channelId, (typeId) => {
      if (typeId === "gmail.thread") {
        return (state, update) => reduceGmailThread(state as GmailThreadState, update as never);
      }
      return undefined;
    });

    const state = this.getChannelState(channelId);
    const inbox = folded.get("gmail.inbox");
    if (!state.inboxMessageId && inbox && inbox.size > 0) {
      state.inboxMessageId = [...inbox.keys()][0];
      this.saveChannelState(state);
    }

    for (const [messageId, value] of folded.get("gmail.thread") ?? []) {
      const thread = record(value);
      const threadId = typeof thread["threadId"] === "string" ? thread["threadId"] : undefined;
      if (!threadId) continue;
      const subject = typeof thread["subject"] === "string" ? thread["subject"] : "(no subject)";
      const from =
        Array.isArray(thread["participants"]) && typeof thread["participants"][0] === "string"
          ? thread["participants"][0]
          : "";
      const snippet =
        typeof thread["lastSnippet"] === "string"
          ? thread["lastSnippet"]
          : typeof thread["snippet"] === "string"
            ? thread["snippet"]
            : "";
      const unreadCount = typeof thread["unreadCount"] === "number" ? thread["unreadCount"] : 0;
      const status = typeof thread["status"] === "string" ? thread["status"] : "unread";
      const category = typeof thread["category"] === "string" ? thread["category"] : null;
      const actionable =
        Boolean(thread["actionable"]) ||
        (unreadCount > 0 &&
          status !== "archived" &&
          !["Promotions", "Social", "Updates", "Forums"].includes(category ?? ""));
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_threads
         (channel_id, thread_id, message_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        threadId,
        messageId,
        subject,
        from,
        snippet,
        unreadCount > 0 ? 1 : 0,
        status === "archived" ? 0 : 1,
        actionable ? 1 : 0,
        category,
        Date.now()
      );
    }

    for (const [messageId, value] of folded.get("gmail.category") ?? []) {
      const category = record(value)["name"];
      if (typeof category !== "string" || !category) continue;
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_categories (channel_id, category, message_id) VALUES (?, ?, ?)`,
        channelId,
        category,
        messageId
      );
    }
  }

  private setPollInterval(
    channelId: string,
    args: Record<string, unknown>
  ): { pollIntervalMs: number } {
    const pollIntervalMs = Math.max(
      60_000,
      numberArg(args, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS
    );
    const state = this.getChannelState(channelId);
    state.pollIntervalMs = pollIntervalMs;
    this.saveChannelState(state);
    this.setAlarm(pollIntervalMs);
    return { pollIntervalMs };
  }

  private async syncChannel(
    channelId: string
  ): Promise<{ ok: true; historyId: string; threadsUpdated: number }> {
    const state = this.getChannelState(channelId);
    const gmail = this.gmailForChannel(channelId);
    if (!state.historyId) {
      const profile = await gmail.getProfile();
      state.historyId = profile.historyId;
      state.emailAddress = profile.emailAddress;
      state.lastSyncAt = Date.now();
      state.lastError = undefined;
      this.saveChannelState(state);
      await this.seedRepliedSendersFromSentMail(channelId).catch(() => undefined);
      await this.bootstrapRecentThreads(channelId, profile.emailAddress);
      await this.publishOverview(channelId, profile.emailAddress);
      return { ok: true, historyId: profile.historyId, threadsUpdated: 0 };
    }

    if (!state.emailAddress) {
      const profile = await gmail.getProfile();
      state.emailAddress = profile.emailAddress;
    }
    const diff = await gmail.syncSince(state.historyId);
    for (const thread of diff.threads) {
      await this.refreshThread(channelId, thread.threadId, state.emailAddress, { allowWake: true });
    }
    state.historyId = diff.historyId;
    state.lastSyncAt = Date.now();
    state.lastError = undefined;
    this.saveChannelState(state);
    await this.publishOverview(channelId);
    return { ok: true, historyId: diff.historyId, threadsUpdated: diff.threads.length };
  }

  private async bootstrapRecentThreads(channelId: string, userEmail: string): Promise<void> {
    const gmail = this.gmailForChannel(channelId);
    const result = await gmail.listMessages({
      maxResults: INITIAL_THREAD_LOAD_LIMIT,
      labelIds: ["INBOX"],
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const threadIds = Array.from(
      new Set(
        result.messages
          .map((message) => message.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      )
    );
    for (const threadId of threadIds) {
      await this.refreshThread(channelId, threadId, userEmail);
    }
  }

  private recordSyncError(channelId: string, err: unknown): void {
    const state = this.getChannelState(channelId);
    state.lastSyncAt = Date.now();
    state.lastError = err instanceof Error ? err.message : String(err);
    this.saveChannelState(state);
  }

  private async refreshThread(
    channelId: string,
    threadId: string,
    userEmail?: string,
    opts: { allowWake?: boolean } = {}
  ): Promise<GmailThreadCardState> {
    const existing = this.threadRow(channelId, threadId);
    const gmail = this.gmailForChannel(channelId);
    let thread: GmailThread;
    try {
      thread = await gmail.getThread(threadId, {
        format: "metadata",
        metadataHeaders: METADATA_HEADERS,
      });
    } catch (err) {
      if (!existing || !isNotFoundError(err)) throw err;
      const archived = this.threadCardFromRow({
        ...existing,
        unread: 0,
        in_inbox: 0,
        actionable: 0,
        updated_at: Date.now(),
      });
      this.sql.exec(
        `UPDATE gmail_threads SET unread = 0, in_inbox = 0, actionable = 0, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
        archived.updatedAt,
        channelId,
        threadId
      );
      if (existing.message_id)
        await this.updateCustom(channelId, existing.message_id, {
          kind: "statusChange",
          status: "archived",
        });
      return archived;
    }
    const event = attentionEventFromThread(thread, userEmail);
    if (event) event.priorReplyToSender = this.hasRepliedToSender(channelId, event.from);
    const attention = event
      ? this.evaluateAttentionRules(this.getAttentionRulesRecord(channelId).ruleSet, event)
      : { wake: false };
    if (event && attention.wake) {
      this.recordAttentionHit(channelId, thread.id, attention);
      if (opts.allowWake) await this.startAttentionTurn(channelId, event, attention);
    }
    const card = threadCardState(thread, existing?.category, userEmail, attention);
    const messageId = existing?.message_id ?? null;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_threads
       (channel_id, thread_id, message_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      card.threadId,
      messageId,
      card.subject,
      card.from,
      card.snippet,
      card.unread ? 1 : 0,
      card.inInbox ? 1 : 0,
      card.actionable ? 1 : 0,
      card.category ?? null,
      card.updatedAt
    );
    if (existing?.message_id) await this.updateCustom(channelId, existing.message_id, card);
    return card;
  }

  private threadRow(channelId: string, threadId: string): GmailThreadStateRow | null {
    return (
      (this.sql
        .exec(
          `SELECT * FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`,
          channelId,
          threadId
        )
        .toArray()[0] as unknown as GmailThreadStateRow | undefined) ?? null
    );
  }

  private threadCardFromRow(
    row: GmailThreadStateRow,
    hit?: GmailAttentionHit | null
  ): GmailThreadCardState {
    return {
      threadId: row.thread_id,
      subject: row.subject,
      from: row.from_addr,
      snippet: row.snippet,
      participants: row.from_addr ? [row.from_addr] : [],
      lastSnippet: row.snippet,
      unreadCount: row.unread === 1 ? 1 : 0,
      hasDraft: false,
      status: row.unread === 1 ? "unread" : row.in_inbox === 1 ? "open" : "archived",
      unread: row.unread === 1,
      inInbox: row.in_inbox === 1,
      actionable: row.actionable === 1,
      ...(hit
        ? {
            attention: {
              wake: true,
              directiveId: hit.directiveId,
              directiveName: hit.directiveName,
              reason: hit.reason,
              actions: hit.actions,
            },
          }
        : {}),
      ...(row.category ? { category: row.category } : {}),
      updatedAt: row.updated_at,
    };
  }

  private listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_threads
       WHERE channel_id = ? AND actionable = 1
       ORDER BY updated_at DESC
       LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 25))
      )
      .toArray() as unknown as GmailThreadStateRow[];
    return rows.map((row) =>
      this.threadCardFromRow(row, this.attentionHitForThread(channelId, row.thread_id))
    );
  }

  private async publishOverview(channelId: string, email?: string): Promise<void> {
    const state = this.getChannelState(channelId);
    const attentionRecord = this.getAttentionRulesRecord(channelId);
    const actionable = this.listActionableThreads(channelId, 8);
    const rows =
      this.sql
        .exec(
          `SELECT
        SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) AS inbox
       FROM gmail_threads WHERE channel_id = ?`,
          channelId
        )
        .toArray()[0] ?? {};
    const searchResults = this.parseStoredThreadCards(state.lastSearchJson);
    const payload: GmailInboxState = {
      email: email ?? state.emailAddress,
      unread: Number(rows["unread"] ?? 0),
      inbox: Number(rows["inbox"] ?? 0),
      urgent: actionable.filter((thread) => thread.category === "urgent").length,
      draftCount: 0,
      perCategory: this.categoryCounts(channelId),
      actionable,
      setupStatus: state.setupStatus,
      ...(state.setupSummary ? { setupSummary: state.setupSummary } : {}),
      attentionRules: attentionRecord.ruleSet,
      attentionHits: this.attentionHits(channelId, 8),
      ...(state.lastSearchQuery ? { searchQuery: state.lastSearchQuery } : {}),
      ...(searchResults.length > 0 ? { searchResults } : {}),
      lastSyncedAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : undefined,
      lastError: state.lastError,
    };
    const overviewJson = JSON.stringify(payload);
    if (!state.inboxMessageId) {
      state.inboxMessageId = await this.publishCustom(channelId, "gmail.inbox", payload, "row");
      state.lastOverviewJson = overviewJson;
      this.saveChannelState(state);
    } else if (state.lastOverviewJson !== overviewJson) {
      await this.updateCustom(channelId, state.inboxMessageId, payload);
      state.lastOverviewJson = overviewJson;
      this.saveChannelState(state);
    }
  }

  private parseStoredThreadCards(value: string | undefined): GmailThreadCardState[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is GmailThreadCardState =>
              Boolean(item && typeof item === "object" && typeof record(item)["threadId"] === "string")
          )
        : [];
    } catch {
      return [];
    }
  }

  private async categorize(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; category: string }> {
    const threadId = stringArg(args, "threadId");
    const category = stringArg(args, "category");
    if (!threadId || !category) throw new Error("categorize requires threadId and category");
    this.sql.exec(
      `UPDATE gmail_threads SET category = ?, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
      category,
      Date.now(),
      channelId,
      threadId
    );
    const row = this.threadRow(channelId, threadId);
    if (row?.message_id) {
      await this.updateCustom(
        channelId,
        row.message_id,
        this.threadCardFromRow({ ...row, category, updated_at: Date.now() })
      );
    }
    await this.publishOverview(channelId);
    return { threadId, category };
  }

  private async archiveThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; archived: true }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("archiveThread requires threadId");
    const gmail = this.gmailForChannel(channelId);
    await gmail.modifyLabels({ threadId, removeLabelIds: ["INBOX"] });
    await this.applyLocalThreadFlags(channelId, threadId, {
      inInbox: false,
      actionable: false,
      status: "archived",
    });
    await this.publishOverview(channelId);
    return { threadId, archived: true };
  }

  private async markRead(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; read: true }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("markRead requires threadId");
    const gmail = this.gmailForChannel(channelId);
    await gmail.modifyLabels({ threadId, removeLabelIds: ["UNREAD"] });
    await this.applyLocalThreadFlags(channelId, threadId, {
      unread: false,
      actionable: false,
      status: "open",
    });
    await this.publishOverview(channelId);
    return { threadId, read: true };
  }

  private async applyLocalThreadFlags(
    channelId: string,
    threadId: string,
    flags: {
      unread?: boolean;
      inInbox?: boolean;
      actionable?: boolean;
      status?: GmailThreadCardState["status"];
    }
  ): Promise<void> {
    const existing = this.threadRow(channelId, threadId);
    if (!existing) return;
    const updatedAt = Date.now();
    this.sql.exec(
      `UPDATE gmail_threads
       SET unread = COALESCE(?, unread),
           in_inbox = COALESCE(?, in_inbox),
           actionable = COALESCE(?, actionable),
           updated_at = ?
       WHERE channel_id = ? AND thread_id = ?`,
      typeof flags.unread === "boolean" ? (flags.unread ? 1 : 0) : null,
      typeof flags.inInbox === "boolean" ? (flags.inInbox ? 1 : 0) : null,
      typeof flags.actionable === "boolean" ? (flags.actionable ? 1 : 0) : null,
      updatedAt,
      channelId,
      threadId
    );
    if (existing.message_id) {
      const row = this.threadRow(channelId, threadId);
      if (row) {
        await this.updateCustom(channelId, existing.message_id, {
          ...this.threadCardFromRow(row),
          ...(flags.status ? { status: flags.status } : {}),
        });
      }
    }
  }

  private async clearSearch(channelId: string): Promise<{ cleared: true }> {
    const state = this.getChannelState(channelId);
    state.lastSearchQuery = undefined;
    state.lastSearchJson = undefined;
    this.saveChannelState(state);
    await this.publishOverview(channelId);
    return { cleared: true };
  }

  private categoryCounts(channelId: string): Record<string, number> {
    const rows = this.sql
      .exec(
        `SELECT category, COUNT(*) AS count
       FROM gmail_threads
       WHERE channel_id = ? AND category IS NOT NULL
       GROUP BY category`,
        channelId
      )
      .toArray();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const category = row["category"];
      if (typeof category === "string" && category) counts[category] = Number(row["count"] ?? 0);
    }
    return counts;
  }

  private async publishCategories(channelId: string): Promise<void> {
    const categories = Object.keys(this.categoryCounts(channelId));
    for (const category of categories) {
      const rows = this.sql
        .exec(
          `SELECT * FROM gmail_threads
         WHERE channel_id = ? AND category = ?
         ORDER BY updated_at DESC
         LIMIT 10`,
          channelId,
          category
        )
        .toArray() as unknown as GmailThreadStateRow[];
      const payload = {
        name: category,
        unread: rows.filter((row) => row.unread === 1).length,
        threads: rows.map((row) => ({
          threadId: row.thread_id,
          subject: row.subject,
          unreadCount: row.unread === 1 ? 1 : 0,
        })),
      };
      const existing = this.sql
        .exec(
          `SELECT message_id FROM gmail_categories WHERE channel_id = ? AND category = ?`,
          channelId,
          category
        )
        .toArray()[0]?.["message_id"] as string | undefined;
      if (existing) {
        await this.updateCustom(channelId, existing, payload);
      } else {
        const messageId = await this.publishCustom(channelId, "gmail.category", payload, "row");
        this.sql.exec(
          `INSERT OR REPLACE INTO gmail_categories (channel_id, category, message_id) VALUES (?, ?, ?)`,
          channelId,
          category,
          messageId
        );
      }
    }
  }

  private async compose(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ messageId: string }> {
    const state: GmailComposeState = {
      to: stringArg(args, "to"),
      cc: stringArg(args, "cc"),
      bcc: stringArg(args, "bcc"),
      subject: stringArg(args, "subject"),
      body: stringArg(args, "body"),
      threadId: stringArg(args, "threadId"),
      sourceThreadId: stringArg(args, "sourceThreadId"),
      status: "draft",
    };
    return { messageId: await this.publishCustom(channelId, "gmail.compose", state, "row") };
  }

  private async draftReply(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ messageId: string; body: string }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("draftReply requires threadId");
    const gmail = this.gmailForChannel(channelId);
    const thread = await gmail.getThread(threadId, { format: "full" });
    const latest = latestMessage(thread);
    const subject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const to = header(latest ?? ({} as GmailMessage), "From") ?? "";
    const body = await this.generateDraftReplyBody(channelId, thread);
    const messageId = await this.publishCustom(
      channelId,
      "gmail.compose",
      {
        to,
        subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
        body,
        threadId,
        sourceThreadId: threadId,
        status: "draft",
      } satisfies GmailComposeState,
      "row"
    );
    return { messageId, body };
  }

  private async resolveReplySendArgs(channelId: string, args: Record<string, unknown>): Promise<{
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }> {
    const threadId = stringArg(args, "threadId");
    const explicitTo = stringArg(args, "to");
    const explicitSubject = stringArg(args, "subject");
    if (!threadId) {
      if (!explicitTo || !explicitSubject) throw new Error("send requires to and subject");
      return {
        to: explicitTo,
        ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
        ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
        subject: explicitSubject,
      };
    }
    const gmail = this.gmailForChannel(channelId);
    const thread = await gmail.getThread(threadId, {
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const latest = latestMessage(thread);
    const threadSubject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const subject =
      explicitSubject ?? (threadSubject.startsWith("Re:") ? threadSubject : `Re: ${threadSubject}`);
    const to = explicitTo ?? header(latest ?? ({} as GmailMessage), "From") ?? "";
    if (!to || !subject) throw new Error("send could not resolve reply recipient and subject");
    return {
      to,
      ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
      ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
      subject,
      threadId,
      inReplyTo: header(latest ?? ({} as GmailMessage), "Message-ID"),
      references:
        header(latest ?? ({} as GmailMessage), "References") ??
        header(latest ?? ({} as GmailMessage), "Message-ID"),
    };
  }

  private async send(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ sent: true; id: string }> {
    const messageId = stringArg(args, "messageId");
    if (messageId) await this.updateCustom(channelId, messageId, { status: "sending" });
    try {
      const gmail = this.gmailForChannel(channelId);
      const replyArgs = await this.resolveReplySendArgs(channelId, args);
      const sent = await gmail.sendMessage({
        to: replyArgs.to,
        ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
        ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      });
      for (const email of parseAddressList([replyArgs.to, replyArgs.cc ?? "", replyArgs.bcc ?? ""])) {
        this.recordRepliedSender(channelId, email, email, "send");
      }
      if (messageId) await this.updateCustom(channelId, messageId, { status: "sent" });
      const sourceThreadId = stringArg(args, "sourceThreadId") ?? stringArg(args, "threadId");
      if (sourceThreadId) {
        await gmail
          .modifyLabels({ threadId: sourceThreadId, removeLabelIds: ["INBOX"] })
          .catch(() => undefined);
        await this.refreshThread(
          channelId,
          sourceThreadId,
          this.getChannelState(channelId).emailAddress
        ).catch(() => undefined);
        await this.applyLocalThreadFlags(channelId, sourceThreadId, {
          inInbox: false,
          actionable: false,
          status: "archived",
        });
        if (this.subscriptions.getParticipantId(channelId)) await this.publishOverview(channelId);
      }
      return { sent: true, id: sent.id };
    } catch (err) {
      if (messageId)
        await this.updateCustom(channelId, messageId, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      throw err;
    }
  }

  private async saveDraft(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ saved: true; draftId: string }> {
    const messageId = stringArg(args, "messageId");
    const gmail = this.gmailForChannel(channelId);
    const replyArgs = await this.resolveReplySendArgs(channelId, args);
    const draft = await gmail.createDraft({
      to: replyArgs.to,
      ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
      ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
      subject: replyArgs.subject,
      body: stringArg(args, "body") ?? "",
      ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
      ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
      ...(replyArgs.references ? { references: replyArgs.references } : {}),
    });
    if (messageId) await this.updateCustom(channelId, messageId, { status: "saved", draftId: draft.id });
    return { saved: true, draftId: draft.id };
  }

  private async discardCompose(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ discarded: true }> {
    const messageId = stringArg(args, "messageId");
    if (messageId) await this.updateCustom(channelId, messageId, { status: "discarded" });
    return { discarded: true };
  }

  private async search(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ count: number; query: string }> {
    const q = stringArg(args, "q");
    if (!q) throw new Error("search requires q");
    const gmail = this.gmailForChannel(channelId);
    const result = await gmail.search(q, {
      maxResults: Math.max(1, Math.min(numberArg(args, "limit") ?? 10, 25)),
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const threads: GmailThreadCardState[] = result.messages.map((message) => {
      const labels = new Set(message.labelIds ?? []);
      const unread = labels.has("UNREAD");
      const inInbox = labels.has("INBOX");
      const category = categoryFromLabels(labels);
      return {
        threadId: message.threadId,
        subject: header(message, "Subject") ?? "(no subject)",
        from: header(message, "From") ?? "",
        snippet: message.snippet ?? "",
        participants: [header(message, "From") ?? ""].filter(Boolean),
        lastSnippet: message.snippet ?? "",
        unreadCount: unread ? 1 : 0,
        hasDraft: false,
        status: unread ? "unread" : inInbox ? "open" : "archived",
        unread,
        inInbox,
        actionable: false,
        updatedAt: Number(message.internalDate ?? Date.now()),
        ...(category ? { category } : {}),
      };
    });
    const state = this.getChannelState(channelId);
    state.lastSearchQuery = q;
    state.lastSearchJson = JSON.stringify(threads);
    this.saveChannelState(state);
    await this.publishOverview(channelId);
    return { query: q, count: threads.length };
  }

  private async getThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; messages: Array<Record<string, unknown>> }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("getThread requires threadId");
    const gmail = this.gmailForChannel(channelId);
    const thread = await gmail.getThread(threadId, { format: "full" });
    return {
      threadId,
      messages: (thread.messages ?? []).map((message) => ({
        id: message.id,
        from: header(message, "From") ?? "",
        to: header(message, "To") ?? "",
        date: header(message, "Date") ?? "",
        subject: header(message, "Subject") ?? "",
        snippet: message.snippet ?? "",
        bodyText: textFromPart(message.payload).slice(0, 20_000),
      })),
    };
  }

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`Gmail agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "Gmail",
      metadata: { type: "agent", handle: "gmail", name: "Gmail" },
    };
  }

  private async publishCustom(
    channelId: string,
    typeId: string,
    initialState: unknown,
    displayMode: CustomMessageDisplayMode
  ): Promise<string> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    const messageId = crypto.randomUUID();
    const event: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor,
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        typeId,
        displayMode,
        initialState,
        by: actor,
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `gmail:custom:start:${messageId}`,
      senderMetadata: actor.metadata,
    });
    return messageId;
  }

  private async updateCustom(channelId: string, messageId: string, update: unknown): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    const event: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor,
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        update,
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `gmail:custom:update:${messageId}:${crypto.randomUUID()}`,
      senderMetadata: actor.metadata,
    });
  }
}
