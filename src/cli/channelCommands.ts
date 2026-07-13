/**
 * `vibestudio channel ...` — messaging surface for humans and agents (plan §6.3).
 *
 * The CLI is a thin device client: it resolves the channel Durable Object
 * (protocol `vibestudio.channel.v1`, objectKey = channelId) via
 * `workers.resolveService` and relays to it with `callTarget`, exactly like
 * `vibestudio vcs log` relays `vcsLog`. The host never imports workspace code;
 * the channel DO holds all semantics.
 *
 *   channel list                       enumerate the workspace's channels
 *   channel history <id> [--after N]   durable log read (paged, client-capped)
 *   channel send <id> --text ...       publish a durable message as the caller
 *   channel tail <id>                  live follow over the WS push transport
 *   channel roster <id>                current participants
 */

import type {
  ChannelHistoryEntry,
  ChannelRosterEntry,
  ChannelSendResult,
  ChannelSummary,
} from "@vibestudio/shared/serviceSchemas/channel";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { CliError, jsonMode, printError, printResult, UsageError } from "./output.js";
import { resolveSessionScope, SCOPE_FLAGS } from "./agent/sessionContext.js";
import type { RpcClient } from "./rpcClient.js";

const CHANNEL_PROTOCOL = "vibestudio.channel.v1";
const VCS_PROTOCOL = "vibestudio.vcs.v1";

interface ResolvedService {
  kind: string;
  targetId?: string;
}

/** Resolve a userland DO service to its `do:...` relay target id. */
async function resolveTargetId(
  client: RpcClient,
  protocol: string,
  objectKey: string | null
): Promise<string> {
  const service = await client.call<ResolvedService>("workers.resolveService", [
    protocol,
    objectKey,
  ]);
  if (service.kind !== "durable-object" || !service.targetId) {
    throw new CliError(`service ${protocol} is not a durable-object service`);
  }
  return service.targetId;
}

// ── shared shapes of the raw DO relay ───────────────────────────────────────

interface ServerLogEvent {
  id: number;
  messageId: string;
  type: string;
  payload: unknown;
  senderId?: string | null;
  senderMetadata?: Record<string, unknown> | null;
  ts: number;
}
interface ReplayEnvelope {
  logEvents: ServerLogEvent[];
  ready: {
    replayToId?: number;
    snapshotLastSeq?: number;
    hasMoreAfter?: boolean;
  };
}
interface RosterMember {
  participantId: string;
  metadata: Record<string, unknown>;
  transport: string;
}

/** Flatten an agentic message payload into plain text (best effort). */
function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const inner = (payload as { payload?: unknown }).payload;
  const blocks = (inner as { blocks?: unknown } | undefined)?.blocks;
  if (Array.isArray(blocks)) {
    const parts = blocks
      .map((b) =>
        b && typeof b === "object" && typeof (b as { content?: unknown }).content === "string"
          ? (b as { content: string }).content
          : null
      )
      .filter((s): s is string => s !== null);
    if (parts.length > 0) return parts.join("");
  }
  const content = (payload as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function handleOf(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  for (const key of ["handle", "name"]) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function toHistoryEntry(event: ServerLogEvent): ChannelHistoryEntry {
  return {
    seq: event.id,
    messageId: event.messageId,
    type: event.type,
    senderId: event.senderId ?? null,
    senderHandle: handleOf(event.senderMetadata),
    text: extractText(event.payload),
    ts: event.ts,
  };
}

// ── commands ────────────────────────────────────────────────────────────────

async function list(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, contextId } = resolveSessionScope(inv);
    const showAll = inv.flags["all"] === true;
    const vcsTarget = await resolveTargetId(client, VCS_PROTOCOL, null);
    const logs = await client.callTarget<
      Array<{ channelId: string; logId: string; createdAt: number | null }>
    >(vcsTarget, "listChannelLogs", []);

    // Annotate each channel with its bound context (best effort; a channel whose
    // DO can't be resolved or read is left contextId: null).
    const summaries: ChannelSummary[] = [];
    for (const log of logs) {
      let ctx: string | null = null;
      try {
        const target = await resolveTargetId(client, CHANNEL_PROTOCOL, log.channelId);
        ctx = await client.callTarget<string | null>(target, "getContextId", []);
      } catch {
        ctx = null;
      }
      summaries.push({
        channelId: log.channelId,
        logId: log.logId,
        createdAt: log.createdAt,
        contextId: ctx,
      });
    }
    const filtered = showAll ? summaries : summaries.filter((s) => s.contextId === contextId);

    printResult(filtered, {
      json,
      human: () => {
        if (filtered.length === 0) {
          console.log(
            showAll
              ? "no channels in this workspace"
              : `no channels bound to context ${contextId} (use --all to list every channel)`
          );
          return;
        }
        for (const s of filtered) {
          const here = s.contextId === contextId ? " *" : "";
          console.log(`${s.channelId}${here}\tcontext=${s.contextId ?? "?"}`);
        }
        if (!showAll) console.log("\n(* = current context; --all lists every channel)");
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function history(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const channelId = requireChannelId(inv);
    const after = intFlag(inv, "after") ?? 0;
    const limit = intFlag(inv, "limit") ?? 50;
    if (limit < 1) throw new UsageError("--limit must be a positive integer");
    const { client } = resolveSessionScope(inv);
    const target = await resolveTargetId(client, CHANNEL_PROTOCOL, channelId);
    const events: ServerLogEvent[] = [];
    let cursor = after;
    let throughSeq: number | undefined;
    while (events.length < limit) {
      const envelope = await client.callTarget<ReplayEnvelope>(target, "getReplayAfter", [
        {
          after: cursor,
          limit: Math.min(500, limit - events.length),
          ...(throughSeq !== undefined ? { throughSeq } : {}),
        },
      ]);
      events.push(...envelope.logEvents);
      throughSeq ??= envelope.ready.snapshotLastSeq;
      if (!envelope.ready.hasMoreAfter) break;
      const next = envelope.ready.replayToId;
      if (next === undefined || next <= cursor || throughSeq === undefined) {
        throw new CliError("channel replay did not return a valid continuation cursor");
      }
      cursor = next;
    }
    const entries = events.map(toHistoryEntry);
    printResult(entries, {
      json,
      human: () => {
        if (entries.length === 0) {
          console.log(`no messages after #${after}`);
          return;
        }
        for (const e of entries) {
          const who = e.senderHandle ?? e.senderId ?? "?";
          const when = new Date(e.ts).toISOString();
          const body = e.text ?? `(${e.type})`;
          console.log(`#${e.seq}\t${when}\t${who}\t${body}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function send(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const channelId = requireChannelId(inv);
    const text = typeof inv.flags["text"] === "string" ? inv.flags["text"] : undefined;
    if (!text) throw new UsageError("missing message — pass --text '...'");
    const opts: {
      handle?: string;
      to?: Array<{ kind: "all" | "role" | "participant"; role?: string; participantId?: string }>;
      mentions?: string[];
    } = {};
    if (typeof inv.flags["as"] === "string") opts.handle = inv.flags["as"];
    const to = inv.flagsMulti("to");
    if (to.length > 0) {
      const handles = to.map((h) => (h.startsWith("@") ? h.slice(1) : h));
      opts.mentions = handles;
      opts.to = handles.map((participantId) => ({ kind: "participant", participantId }));
    }
    const { client } = resolveSessionScope(inv);
    const target = await resolveTargetId(client, CHANNEL_PROTOCOL, channelId);
    const result = await client.callTarget<ChannelSendResult>(target, "sendAsCaller", [text, opts]);
    printResult(result, {
      json,
      human: () => console.log(`sent (#${result.id ?? "?"}) ${result.messageId}`),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function roster(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const channelId = requireChannelId(inv);
    const { client } = resolveSessionScope(inv);
    const target = await resolveTargetId(client, CHANNEL_PROTOCOL, channelId);
    const members = await client.callTarget<RosterMember[]>(target, "getParticipants", []);
    const entries: ChannelRosterEntry[] = members.map((m) => ({
      participantId: m.participantId,
      handle: handleOf(m.metadata),
      transport: m.transport,
      kind: typeof m.metadata["kind"] === "string" ? (m.metadata["kind"] as string) : null,
    }));
    printResult(entries, {
      json,
      human: () => {
        if (entries.length === 0) {
          console.log("no participants");
          return;
        }
        for (const e of entries) {
          console.log(`${e.handle ?? e.participantId}\t[${e.transport}]\t${e.participantId}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function tail(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const channelId = requireChannelId(inv);
    const { client, callerId } = resolveSessionScope(inv);
    const target = await resolveTargetId(client, CHANNEL_PROTOCOL, channelId);

    let lastRenderedSeq = 0;
    const render = (event: ServerLogEvent): void => {
      if (event.id <= lastRenderedSeq) return;
      lastRenderedSeq = event.id;
      const entry = toHistoryEntry(event);
      if (json) {
        console.log(JSON.stringify(entry));
        return;
      }
      const who = entry.senderHandle ?? entry.senderId ?? "?";
      const body = entry.text ?? `(${entry.type})`;
      console.log(`#${entry.seq}\t${who}\t${body}`);
    };

    // Subscribe under the connection's own principal so `channel:message` emits
    // route back to us. Register the listener before subscribing so no live
    // event slips between the initial replay and the push stream.
    const off = await client.onEvent("channel:message", (payload) => {
      const p = payload as {
        channelId?: string;
        message?: { kind?: string; event?: ServerLogEvent };
      };
      if (p.channelId !== channelId) return;
      if (p.message?.kind === "log" && p.message.event) render(p.message.event);
    });

    const handle = `cli-${callerId.slice(-8)}`;
    const subscribe = async (): Promise<void> => {
      const result = await client.callTargetPush<{ envelope?: ReplayEnvelope }>(
        target,
        "subscribe",
        [
          callerId,
          { handle, receivesChannelEnvelopes: false, replay: true, replayMessageLimit: 10 },
        ]
      );
      for (const event of result.envelope?.logEvents ?? []) render(event);
    };
    const offRecovery = await client.onRecovery(async () => {
      await subscribe();
    });
    await subscribe();
    if (!json) console.error(`tailing ${channelId} (Ctrl-C to stop)…`);

    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    offRecovery();
    off();
    await client.callTargetPush(target, "unsubscribe", [callerId]).catch(() => undefined);
    await client.close();
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

// ── flag helpers ─────────────────────────────────────────────────────────────

function requireChannelId(inv: ParsedInvocation): string {
  const id = inv.positionals[0] ?? process.env["VIBESTUDIO_CHANNEL_ID"];
  if (!id) {
    throw new UsageError(
      "missing channel id — run `vibestudio channel list`, or set VIBESTUDIO_CHANNEL_ID"
    );
  }
  return id;
}

function intFlag(inv: ParsedInvocation, name: string): number | undefined {
  const raw = inv.flags[name];
  if (typeof raw !== "string") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return value;
}

const AFTER_FLAG: FlagSpec = {
  name: "after",
  takesValue: true,
  description: "Only events with seq greater than N",
};
const LIMIT_FLAG: FlagSpec = {
  name: "limit",
  takesValue: true,
  description: "Cap the number of entries (default 50)",
};
const TEXT_FLAG: FlagSpec = { name: "text", takesValue: true, description: "Message body" };
const TO_FLAG: FlagSpec = {
  name: "to",
  takesValue: true,
  multiple: true,
  description: "Address/mention a participant handle (e.g. @alice); repeatable",
};
const AS_FLAG: FlagSpec = {
  name: "as",
  takesValue: true,
  description: "Display handle to send under (default: your caller id)",
};
const ALL_FLAG: FlagSpec = {
  name: "all",
  takesValue: false,
  description: "List every channel, not just the current context's",
};

export const channelCommands: CliCommand[] = [
  {
    group: "channel",
    name: "list",
    summary: "List the workspace's channels (bound to your context, or --all)",
    usage: "vibestudio channel list [--all]",
    flags: [ALL_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: list,
  },
  {
    group: "channel",
    name: "history",
    summary: "Read a channel's durable message log (paged)",
    usage: "vibestudio channel history [id] [--after N] [--limit N]",
    flags: [AFTER_FLAG, LIMIT_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: history,
  },
  {
    group: "channel",
    name: "send",
    summary: "Publish a durable message on a channel as yourself",
    usage: "vibestudio channel send [id] --text '...' [--to @handle] [--as NAME]",
    flags: [TEXT_FLAG, TO_FLAG, AS_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: send,
  },
  {
    group: "channel",
    name: "tail",
    summary: "Follow a channel live over the WS push transport",
    usage: "vibestudio channel tail [id]",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: tail,
  },
  {
    group: "channel",
    name: "roster",
    summary: "List a channel's current participants",
    usage: "vibestudio channel roster [id]",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: roster,
  },
];
