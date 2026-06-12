/**
 * Compact status indicators for the workspace chrome:
 *   - SaveStatus: unflushed / flushed-Ns-ago state of the active doc
 *   - AgentVaultStatus: which vault the resident agents are scoped to
 *   - MentionDeliveryStatus: outcome of the latest @-mention delivery
 *
 * Each is a small dot + label so the header reads at a glance instead of
 * a row of raw sentences.
 */

import { useEffect, useState } from "react";
import { Flex, Text, Tooltip } from "@radix-ui/themes";
import { useAppState } from "../app/context";
import { hasUnflushedChanges } from "../state/fileBuffer";

export function formatTimeAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

/** Re-render every 5s so relative timestamps stay fresh — isolated here
 *  so the tick doesn't touch the rest of the shell. */
export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="spectrolite-status-dot"
      style={{ background: `var(--${color}-9)` }}
      aria-hidden
    />
  );
}

export function SaveStatus() {
  const saveError = useAppState((s) => (s.activePath ? s.saveErrors[s.activePath] : undefined));
  const dirty = useAppState((s) => {
    const buffer = s.activePath ? s.buffers[s.activePath] : undefined;
    return buffer ? hasUnflushedChanges(buffer) : false;
  });
  const flushedAt = useAppState((s) => (s.activePath ? s.lastFlushedAt[s.activePath] : undefined));
  const now = useNowTick();
  if (saveError) {
    return (
      <Flex align="center" gap="1" title={saveError.message} className="spectrolite-chip" data-testid="spectrolite-save-error-chip">
        <Dot color="red" />
        <Text size="1" color="red">save failed</Text>
      </Flex>
    );
  }
  if (dirty) {
    return (
      <Flex align="center" gap="1" title="Unflushed edits — written to disk after a short pause" className="spectrolite-chip">
        <Dot color="amber" />
        <Text size="1" color="amber">unflushed</Text>
      </Flex>
    );
  }
  if (flushedAt) {
    return (
      <Flex align="center" gap="1" title={`Last flushed at ${new Date(flushedAt).toLocaleString()}`} className="spectrolite-chip">
        <Dot color="green" />
        <Text size="1" color="gray">flushed {formatTimeAgo(flushedAt, now)}</Text>
      </Flex>
    );
  }
  return null;
}

export function AgentVaultStatus({ compact = false }: { compact?: boolean }) {
  const notice = useAppState((s) => s.agentVaultNotice);
  if (!notice) return null;
  const vault = notice.repoRoot.replace(/^\//, "");
  const handles = notice.handles.map((handle) => `@${handle}`).join(", ");
  const label = notice.state === "pending"
    ? `Updating agents for ${vault}`
    : notice.state === "failed"
      ? `Agent vault update failed for ${vault}`
      : `Agents using ${vault}`;
  const tooltip = notice.state === "failed" ? notice.error : handles ? `${handles} notified` : label;
  const dotColor = notice.state === "failed" ? "red" : notice.state === "pending" ? "amber" : "grass";
  return (
    <Tooltip content={tooltip}>
      <Flex align="center" gap="1" className="spectrolite-chip" data-testid="spectrolite-agent-vault-status">
        <Dot color={dotColor} />
        <Text size="1" color={notice.state === "failed" ? "red" : "gray"} truncate={compact}>
          {label}
        </Text>
      </Flex>
    </Tooltip>
  );
}

export function MentionDeliveryStatus({ compact = false }: { compact?: boolean }) {
  const notice = useAppState((s) => s.mentionDeliveryNotice);
  if (!notice) return null;
  const handles = notice.handles.map((handle) => `@${handle}`).join(", ");
  const label = notice.state === "failed"
    ? `Agent mention failed for ${notice.path}`
    : `Sent ${handles} edit for ${notice.path}`;
  return (
    <Tooltip content={notice.state === "failed" ? notice.error : `Delivered to ${handles}`}>
      <Flex align="center" gap="1" className="spectrolite-chip" data-testid="spectrolite-mention-delivery-status">
        <Dot color={notice.state === "failed" ? "red" : "iris"} />
        <Text size="1" color={notice.state === "failed" ? "red" : "gray"} truncate={compact}>
          {label}
        </Text>
      </Flex>
    </Tooltip>
  );
}
