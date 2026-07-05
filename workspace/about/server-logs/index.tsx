/**
 * Server Logs — a live tail of the workspace server's own host logs.
 *
 * Shell panel. Seeds from `serverLog.tail`, closes the race gap with
 * `serverLog.query`, then follows the batched `server-log:append` event
 * stream. Records are deduped by `seq`; a change of `serverBootId` inserts a
 * "server restarted" divider and resets the running head.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  IconButton,
  Select,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  MagnifyingGlassIcon,
  Cross2Icon,
  PlayIcon,
  PauseIcon,
  TrashIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";
import { useIsMobile, usePaletteCommands } from "@workspace/react";
import { AboutThemeRoot } from "@workspace/about-shared/ui";

// ---------------------------------------------------------------------------
// Types (mirrors the serverLog backend contract)
// ---------------------------------------------------------------------------

type Level = "verbose" | "info" | "warn" | "error";

interface LogRecord {
  seq: number;
  timestamp: number;
  level: Level;
  tag?: string;
  message: string;
  fields?: unknown[];
  pid: number;
}

interface LogEnvelope {
  records: LogRecord[];
  latestSeq: number;
  workspaceId: string;
  serverBootId: string;
  pid: number;
  startedAt: number;
}

interface LogStats {
  bufferSize: number;
  totalCaptured: number;
  oldestSeq: number;
  latestSeq: number;
  byLevel: Record<Level, number>;
  byTag: Array<{ tag: string; count: number }>;
}

interface AppendEvent {
  payload: { records: LogRecord[] };
}

/** An item in the rendered stream: a log line or a restart divider. */
type StreamItem =
  | { kind: "log"; record: LogRecord }
  | { kind: "restart"; id: string; bootId: string };

const LEVELS: Level[] = ["verbose", "info", "warn", "error"];
const LEVEL_RANK: Record<Level, number> = { verbose: 0, info: 1, warn: 2, error: 3 };

const LEVEL_COLOR: Record<Level, "gray" | "blue" | "amber" | "red"> = {
  verbose: "gray",
  info: "blue",
  warn: "amber",
  error: "red",
};

const MAX_ROWS = 2000;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtUptime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${two(h)}:${two(m)}:${two(sec)}`;
  return `${two(h)}:${two(m)}:${two(sec)}`;
}

function shortBoot(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function prettyFields(fields: unknown[]): string {
  try {
    return fields
      .map((f) =>
        typeof f === "string" ? f : JSON.stringify(f, null, 2)
      )
      .join("\n");
  } catch {
    return String(fields);
  }
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function LevelChip({ level }: { level: Level }) {
  return (
    <Badge
      color={LEVEL_COLOR[level]}
      variant="soft"
      radius="full"
      style={{
        fontFamily: "var(--code-font-family, monospace)",
        fontSize: 10,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        minWidth: 52,
        justifyContent: "center",
      }}
    >
      {level}
    </Badge>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <Flex direction="column" gap="0" style={{ minWidth: 0 }}>
      <Text size="1" color="gray" style={{ letterSpacing: 0.3 }}>
        {label}
      </Text>
      <Text
        size="2"
        weight="medium"
        style={{
          fontFamily: "var(--code-font-family, monospace)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </Text>
    </Flex>
  );
}

/** A single log row. Rows with `fields` are click-to-expand. */
function LogRow({
  record,
  expanded,
  onToggle,
}: {
  record: LogRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasFields = !!record.fields && record.fields.length > 0;
  const tint =
    record.level === "error"
      ? "var(--red-a2)"
      : record.level === "warn"
      ? "var(--amber-a2)"
      : "transparent";
  const accent =
    record.level === "error"
      ? "var(--red-9)"
      : record.level === "warn"
      ? "var(--amber-9)"
      : "transparent";

  return (
    <Box
      onClick={hasFields ? onToggle : undefined}
      style={{
        background: tint,
        borderLeft: `2px solid ${accent}`,
        cursor: hasFields ? "pointer" : "default",
        padding: "2px 10px 2px 8px",
        borderBottom: "1px solid var(--gray-a3)",
        fontFamily: "var(--code-font-family, monospace)",
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <Flex align="baseline" gap="2" style={{ minWidth: 0 }}>
        <Box style={{ width: 12, flexShrink: 0, opacity: 0.5 }}>
          {hasFields ? (
            expanded ? (
              <ChevronDownIcon width={12} height={12} />
            ) : (
              <ChevronRightIcon width={12} height={12} />
            )
          ) : null}
        </Box>
        <Text
          style={{
            color: "var(--gray-10)",
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtTime(record.timestamp)}
        </Text>
        <Box style={{ flexShrink: 0 }}>
          <LevelChip level={record.level} />
        </Box>
        {record.tag && (
          <Text
            style={{
              flexShrink: 0,
              color: "var(--accent-11)",
              background: "var(--accent-a3)",
              borderRadius: 4,
              padding: "0 6px",
              fontSize: 11,
            }}
          >
            {record.tag}
          </Text>
        )}
        <Text
          style={{
            color: "var(--gray-12)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            minWidth: 0,
          }}
        >
          {record.message}
        </Text>
      </Flex>
      {hasFields && expanded && record.fields && (
        <Box
          style={{
            marginLeft: 26,
            marginTop: 4,
            marginBottom: 4,
            padding: "8px 10px",
            background: "var(--gray-a3)",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--gray-11)",
            fontSize: 11.5,
          }}
        >
          {prettyFields(record.fields)}
        </Box>
      )}
    </Box>
  );
}

function RestartDivider({ bootId }: { bootId: string }) {
  return (
    <Flex align="center" gap="3" py="2" px="3" style={{ userSelect: "none" }}>
      <Box style={{ flex: 1, height: 1, background: "var(--amber-a6)" }} />
      <Text
        size="1"
        weight="medium"
        style={{
          color: "var(--amber-11)",
          fontFamily: "var(--code-font-family, monospace)",
          whiteSpace: "nowrap",
        }}
      >
        server restarted — boot {shortBoot(bootId)}
      </Text>
      <Box style={{ flex: 1, height: 1, background: "var(--amber-a6)" }} />
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

function ServerLogsPage() {
  const isMobile = useIsMobile();

  const [items, setItems] = useState<StreamItem[]>([]);
  const [meta, setMeta] = useState<LogEnvelope | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Controls
  const [search, setSearch] = useState("");
  const [minLevel, setMinLevel] = useState<Level>("verbose");
  const [tagFilter, setTagFilter] = useState<string>("__all__");
  const [follow, setFollow] = useState(true);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [pendingCount, setPendingCount] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Refs that must not trigger re-subscription.
  const lastSeqRef = useRef<number>(0);
  const bootIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const followRef = useRef(follow);
  followRef.current = follow;

  // -- Ingestion ------------------------------------------------------------

  const ingest = useCallback(
    (records: LogRecord[], bootId?: string, restartFirst?: boolean) => {
      if (bootId && bootIdRef.current && bootId !== bootIdRef.current) {
        // Server restarted: insert a divider and reset the running head.
        lastSeqRef.current = 0;
        bootIdRef.current = bootId;
        setItems((prev) => {
          const divider: StreamItem = {
            kind: "restart",
            id: `restart-${bootId}-${Date.now()}`,
            bootId,
          };
          const next = [...prev, divider];
          const freshRecords = records.filter((r) => r.seq > lastSeqRef.current);
          if (freshRecords.length > 0) {
            lastSeqRef.current = freshRecords[freshRecords.length - 1]!.seq;
          }
          const fresh = freshRecords.map<StreamItem>((record) => ({ kind: "log", record }));
          return trimItems([...next, ...fresh]);
        });
        return;
      }
      if (bootId && !bootIdRef.current) bootIdRef.current = bootId;

      const fresh = records.filter((r) => r.seq > lastSeqRef.current);
      if (fresh.length === 0) return;
      lastSeqRef.current = fresh[fresh.length - 1]!.seq;

      setItems((prev) => {
        const additions = fresh.map<StreamItem>((record) => ({ kind: "log", record }));
        const combined = restartFirst ? additions : [...prev, ...additions];
        return trimItems(combined);
      });

      // If not pinned to bottom, surface a "new logs" pill.
      if (!(followRef.current && atBottomRef.current)) {
        setPendingCount((c) => c + fresh.length);
      }
    },
    []
  );

  // -- Mount: subscribe, seed, close race gap ------------------------------

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | null = null;

    const handleAppend = (ev: AppendEvent) => {
      const recs = ev?.payload?.records;
      if (Array.isArray(recs) && recs.length > 0) ingest(recs);
    };

    async function boot() {
      try {
        // 1. Subscribe first so nothing is missed between seed and stream.
        off = rpc.on("event:server-log:append", handleAppend as (ev: unknown) => void);
        await rpc.call("main", "events.subscribe", ["server-log:append"]);

        // 2. Seed with the recent buffer.
        const seed = await rpc.call<LogEnvelope>("main", "serverLog.tail", [500]);
        if (cancelled) return;
        bootIdRef.current = seed.serverBootId;
        setMeta(seed);
        lastSeqRef.current = 0;
        ingest(seed.records, seed.serverBootId, true);

        // 3. Close any race gap between the seed snapshot and the live stream.
        const gap = await rpc.call<LogEnvelope>("main", "serverLog.query", [
          { sinceSeq: lastSeqRef.current },
        ]);
        if (cancelled) return;
        if (gap.serverBootId !== bootIdRef.current) {
          ingest(gap.records, gap.serverBootId);
        } else if (gap.records.length > 0) {
          ingest(gap.records, gap.serverBootId);
        }
        setMeta((m) => m ?? gap);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void boot();

    return () => {
      cancelled = true;
      if (off) off();
      void rpc.call("main", "events.unsubscribe", ["server-log:append"]).catch(() => {});
    };
  }, [ingest]);

  // -- Stats polling --------------------------------------------------------

  const loadStats = useCallback(() => {
    rpc
      .call<LogStats>("main", "serverLog.stats", [])
      .then((s) => setStats(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStats();
    const t = setInterval(loadStats, 4000);
    return () => clearInterval(t);
  }, [loadStats]);

  // -- Uptime ticker --------------------------------------------------------

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // -- Autoscroll -----------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setPendingCount(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = dist < 24;
    atBottomRef.current = bottom;
    if (bottom && pendingCount !== 0) setPendingCount(0);
  }, [pendingCount]);

  // Pin to bottom after new content, only when following and already at bottom.
  useEffect(() => {
    if (follow && atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (pendingCount !== 0) setPendingCount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, follow]);

  // -- Derived filtered view ------------------------------------------------

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (it.kind === "restart") return true;
      const r = it.record;
      if (LEVEL_RANK[r.level] < LEVEL_RANK[minLevel]) return false;
      if (tagFilter !== "__all__" && r.tag !== tagFilter) return false;
      if (q) {
        const hay = `${r.message} ${r.tag ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, minLevel, tagFilter, q]);

  const logCount = useMemo(
    () => filtered.reduce((n, it) => n + (it.kind === "log" ? 1 : 0), 0),
    [filtered]
  );

  // Search the server buffer for older matches of the current query.
  const searchServer = useCallback(async () => {
    if (!q) return;
    try {
      const res = await rpc.call<LogEnvelope>("main", "serverLog.query", [
        { contains: search.trim(), level: minLevel, limit: 1000 },
      ]);
      if (res.serverBootId !== bootIdRef.current) {
        // Different boot; just reseed head bookkeeping.
        bootIdRef.current = res.serverBootId;
      }
      // Merge results (dedupe handled by ingest via seq), then jump to bottom.
      const existing = new Set(
        items.flatMap((i) => (i.kind === "log" ? [i.record.seq] : []))
      );
      const additions = res.records
        .filter((r) => !existing.has(r.seq))
        .map<StreamItem>((record) => ({ kind: "log", record }));
      if (additions.length > 0) {
        setItems((prev) =>
          trimItems(
            [...prev, ...additions].sort((a, b) => seqOf(a) - seqOf(b))
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [q, search, minLevel, items]);

  const toggleExpand = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const clearView = useCallback(() => {
    setItems([]);
    setExpanded(new Set());
    setPendingCount(0);
  }, []);

  const toggleFollow = useCallback(() => {
    setFollow((f) => {
      const nf = !f;
      if (nf) {
        // Resuming: jump to bottom next frame.
        requestAnimationFrame(() => scrollToBottom());
      }
      return nf;
    });
  }, [scrollToBottom]);

  // Palette command.
  const paletteCommands = useMemo(
    () => [
      { id: "server-logs-follow", label: "Server Logs: toggle follow", section: "Server Logs" },
      { id: "server-logs-clear", label: "Server Logs: clear view", section: "Server Logs" },
    ],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "server-logs-follow") toggleFollow();
    else if (id === "server-logs-clear") clearView();
  });

  // -- Render ---------------------------------------------------------------

  const uptime = meta ? fmtUptime(now - meta.startedAt) : "—";
  const following = follow && atBottomRef.current;

  return (
    <Flex
      direction="column"
      style={{
        height: "100dvh",
        boxSizing: "border-box",
        background: "var(--color-panel-solid)",
      }}
    >
      {/* Header */}
      <Box
        px={isMobile ? "3" : "4"}
        py="3"
        style={{ borderBottom: "1px solid var(--gray-a5)" }}
      >
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="3" style={{ minWidth: 0 }}>
            <Flex align="center" gap="2">
              <Box
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: following ? "var(--grass-9)" : "var(--gray-8)",
                  boxShadow: following ? "0 0 0 0 var(--grass-a7)" : "none",
                  animation: following ? "sl-pulse 1.6s ease-out infinite" : "none",
                }}
              />
              <Text size="4" weight="bold" style={{ letterSpacing: -0.2 }}>
                Server Logs
              </Text>
              <Badge
                color={following ? "grass" : "gray"}
                variant="soft"
                radius="full"
                size="1"
              >
                {following ? "LIVE" : follow ? "follow" : "paused"}
              </Badge>
            </Flex>
          </Flex>

          <Flex align="center" gap={isMobile ? "3" : "5"} wrap="wrap">
            <HeaderStat label="workspace" value={meta?.workspaceId ?? "—"} />
            <HeaderStat label="boot" value={meta ? shortBoot(meta.serverBootId) : "—"} />
            <HeaderStat label="pid" value={meta ? String(meta.pid) : "—"} />
            <HeaderStat label="uptime" value={uptime} />
          </Flex>
        </Flex>

        {/* Buffer stats + level counts */}
        <Flex align="center" gap="3" mt="2" wrap="wrap">
          <Text size="1" color="gray">
            {stats
              ? `${stats.bufferSize.toLocaleString()} buffered · ${stats.totalCaptured.toLocaleString()} captured`
              : "…"}
          </Text>
          {stats && (
            <Flex gap="1" align="center">
              {LEVELS.map((lvl) => (
                <LevelCountBadge key={lvl} level={lvl} count={stats.byLevel[lvl] ?? 0} />
              ))}
            </Flex>
          )}
        </Flex>
      </Box>

      {/* Controls */}
      <Flex
        px={isMobile ? "3" : "4"}
        py="2"
        gap="2"
        align="center"
        wrap="wrap"
        style={{ borderBottom: "1px solid var(--gray-a5)" }}
      >
        <TextField.Root
          placeholder="Filter loaded logs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void searchServer();
          }}
          style={{ flex: isMobile ? "1 1 100%" : "1 1 220px", minWidth: 140 }}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
          {search && (
            <TextField.Slot>
              <IconButton size="1" variant="ghost" color="gray" onClick={() => setSearch("")}>
                <Cross2Icon />
              </IconButton>
            </TextField.Slot>
          )}
        </TextField.Root>

        <Tooltip content="Search the full server buffer for this text">
          <Button
            size="2"
            variant="soft"
            color="gray"
            disabled={!q}
            onClick={() => void searchServer()}
          >
            Search server
          </Button>
        </Tooltip>

        <Select.Root value={minLevel} onValueChange={(v) => setMinLevel(v as Level)}>
          <Select.Trigger variant="soft" color="gray" aria-label="Minimum level" />
          <Select.Content>
            <Select.Group>
              <Select.Label>Min level</Select.Label>
              {LEVELS.map((lvl) => (
                <Select.Item key={lvl} value={lvl}>
                  {lvl}
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Content>
        </Select.Root>

        <Select.Root value={tagFilter} onValueChange={setTagFilter}>
          <Select.Trigger variant="soft" color="gray" aria-label="Tag filter" />
          <Select.Content>
            <Select.Group>
              <Select.Label>Subsystem</Select.Label>
              <Select.Item value="__all__">all tags</Select.Item>
              {(stats?.byTag ?? []).map((t) => (
                <Select.Item key={t.tag} value={t.tag}>
                  {t.tag} ({t.count})
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Content>
        </Select.Root>

        <Box style={{ flex: "1 0 0" }} />

        <Button
          size="2"
          variant={follow ? "solid" : "soft"}
          color={follow ? "grass" : "gray"}
          onClick={toggleFollow}
        >
          {follow ? <PauseIcon /> : <PlayIcon />}
          {follow ? "Following" : "Follow"}
        </Button>

        <Tooltip content="Clear view (server buffer untouched)">
          <IconButton size="2" variant="soft" color="gray" onClick={clearView}>
            <TrashIcon />
          </IconButton>
        </Tooltip>
      </Flex>

      {/* Log list */}
      <Box style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <Box
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            position: "absolute",
            inset: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {error && (
            <Box p="4">
              <Text color="red" size="2">
                {error}
              </Text>
            </Box>
          )}
          {!error && logCount === 0 && (
            <Flex
              align="center"
              justify="center"
              direction="column"
              gap="2"
              style={{ height: "100%", minHeight: 200 }}
            >
              <Text size="2" color="gray">
                {items.length === 0
                  ? "Waiting for the server to speak…"
                  : "No records match the current filters"}
              </Text>
              {items.length > 0 && (q || minLevel !== "verbose" || tagFilter !== "__all__") && (
                <Button
                  size="1"
                  variant="ghost"
                  onClick={() => {
                    setSearch("");
                    setMinLevel("verbose");
                    setTagFilter("__all__");
                  }}
                >
                  Reset filters
                </Button>
              )}
            </Flex>
          )}
          {filtered.map((it) =>
            it.kind === "restart" ? (
              <RestartDivider key={it.id} bootId={it.bootId} />
            ) : (
              <LogRow
                key={it.record.seq}
                record={it.record}
                expanded={expanded.has(it.record.seq)}
                onToggle={() => toggleExpand(it.record.seq)}
              />
            )
          )}
        </Box>

        {/* New logs pill */}
        {pendingCount > 0 && (
          <Box
            style={{
              position: "absolute",
              bottom: 14,
              left: "50%",
              transform: "translateX(-50%)",
            }}
          >
            <Button
              size="1"
              variant="solid"
              color="grass"
              radius="full"
              onClick={() => {
                setFollow(true);
                scrollToBottom();
              }}
            >
              <ArrowDownIcon />
              {pendingCount} new{pendingCount === 1 ? " log" : " logs"}
            </Button>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Flex
        px={isMobile ? "3" : "4"}
        py="1"
        align="center"
        justify="between"
        style={{ borderTop: "1px solid var(--gray-a5)" }}
      >
        <Text
          size="1"
          color="gray"
          style={{ fontFamily: "var(--code-font-family, monospace)" }}
        >
          {logCount.toLocaleString()} shown / {items.length.toLocaleString()} loaded
          {items.length >= MAX_ROWS ? ` (capped ${MAX_ROWS})` : ""}
        </Text>
        <Text size="1" color="gray">
          seq {lastSeqRef.current.toLocaleString()}
        </Text>
      </Flex>

      <style>{`
        @keyframes sl-pulse {
          0%   { box-shadow: 0 0 0 0 var(--grass-a7); }
          70%  { box-shadow: 0 0 0 6px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
      `}</style>
    </Flex>
  );
}

/** Header level-count badge (single letter + tabular count). */
function LevelCountBadge({ level, count }: { level: Level; count: number }) {
  return (
    <Tooltip content={`${count.toLocaleString()} ${level}`}>
      <Badge
        color={LEVEL_COLOR[level]}
        variant="soft"
        radius="full"
        style={{ fontVariantNumeric: "tabular-nums", fontSize: 11 }}
      >
        {level.charAt(0).toUpperCase()} {count.toLocaleString()}
      </Badge>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function seqOf(it: StreamItem): number {
  return it.kind === "log" ? it.record.seq : -1;
}

/** Keep the in-memory list bounded, dropping the oldest entries. */
function trimItems(list: StreamItem[]): StreamItem[] {
  let logs = 0;
  for (const it of list) if (it.kind === "log") logs++;
  if (logs <= MAX_ROWS) return list;
  let toDrop = logs - MAX_ROWS;
  let i = 0;
  while (toDrop > 0 && i < list.length) {
    if (list[i]!.kind === "log") toDrop--;
    i++;
  }
  return list.slice(i);
}

export default function ServerLogsPanelRoot() {
  return (
    <AboutThemeRoot>
      <ServerLogsPage />
    </AboutThemeRoot>
  );
}
