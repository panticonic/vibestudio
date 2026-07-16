import { SilentAgentWorker } from "../silent-agent-worker/index.js";
import { installMessageTypes, type AgentToolExecutionContext } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import { defaultPolicies } from "@workspace/agent-loop";
import type { RespondPolicy, StepPolicy } from "@workspace/agent-loop";
import { rpc } from "@workspace/runtime/worker";
import { rpcErrorDataOf } from "@vibestudio/rpc";
import type {
  VcsCompareResult,
  VcsIntegrateResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import { EXPLORER_SYSTEM_PROMPT, SCHEDULED_SWEEP_PROMPT } from "./prompts.js";
import {
  buildCardState,
  findingsCardKey,
  findingsFilePath,
  renderFindingsFile,
  FINDINGS_KEY_PREFIX,
  FINDINGS_MESSAGE_TYPES,
  FINDINGS_TYPE_ID,
  FINDINGS_UI_IMPORTS,
  FINDINGS_UI_INSTALL_VERSION,
  type FindingClass,
  type FindingDetail,
  type FindingSeverity,
} from "./findings-card.js";

const FINDING_CLASSES: readonly FindingClass[] = ["BUG", "DOC-MISMATCH", "SURPRISING"];
const SEVERITIES: readonly FindingSeverity[] = ["low", "medium", "high"];

type FindingOpPhase = "prepared" | "authored" | "committed" | "published" | "finalized";
interface FindingOpRow {
  toolCallId: string;
  channelId: string;
  runId: string;
  detail: FindingDetail;
  filePath: string;
  fileText: string;
  summary: string;
  phase: FindingOpPhase;
  expectedWorkingHead:
    | { kind: "event"; eventId: string }
    | { kind: "application"; applicationId: string }
    | null;
  expectedMainEventId: string;
  committedEventId: string | null;
  publishedEventId: string | null;
  publishedMainEventId: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The explorer agent: a silent agent variant that agentically tests the workspace's
 * own capability surface. It inherits silence + the `say` tool from
 * `SilentAgentWorker`, and adds (a) the explorer system prompt (the oracle loop —
 * full methodology in `workers/explorer-agent/SKILL.md`), (b) a recurring
 * autonomous sweep driven by the `vibestudio.yml recurring:` registry, and (c)
 * a `report_finding` tool that durably logs findings (commit + push) and
 * aggregates them into a findings card in the connected chat panel.
 *
 * Runs as a `do` caller with the full `services.*` surface (NOT read-only) — the
 * sandbox is the safety boundary.
 */
export class ExplorerAgentWorker extends SilentAgentWorker {
  static override schemaVersion = SilentAgentWorker.schemaVersion;

  /** Channels whose findings message-type has been installed this lifetime. */
  private readonly installedUi = new Set<string>();

  constructor(ctx: ConstructorParameters<typeof SilentAgentWorker>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Explorer");
    // Source of truth for both the per-run findings file AND the findings card.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS explorer_findings (
         channel_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
         id TEXT NOT NULL, ts TEXT NOT NULL, cls TEXT NOT NULL, surface TEXT NOT NULL,
         title TEXT NOT NULL, severity TEXT NOT NULL, expected TEXT NOT NULL,
         actual TEXT NOT NULL, repro TEXT,
         PRIMARY KEY (channel_id, run_id, seq))`
    );
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS explorer_findings_invocation
         ON explorer_findings (channel_id, run_id, id)`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS explorer_finding_ops (
         tool_call_id TEXT PRIMARY KEY,
         channel_id TEXT NOT NULL,
         run_id TEXT NOT NULL,
         detail_json TEXT NOT NULL,
         file_path TEXT NOT NULL,
         file_text TEXT NOT NULL,
         summary TEXT NOT NULL,
         phase TEXT NOT NULL,
         expected_working_head_json TEXT,
         expected_main_event_id TEXT NOT NULL,
         committed_event_id TEXT,
         published_event_id TEXT,
         published_main_event_id TEXT,
         updated_at INTEGER NOT NULL)`
    );
  }

  protected override getParticipantInfo(
    channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const base = super.getParticipantInfo(channelId, config);
    return { ...base, handle: "explorer", name: "Explorer" };
  }

  protected override getAgentPrompt(_channelId: string): string {
    return EXPLORER_SYSTEM_PROMPT;
  }

  /**
   * Stay silent in conversation: only run a turn when explicitly addressed (@explorer)
   * or following up our own message. Scheduled sweeps use `submitAgentInitiatedTurn`,
   * which bypasses this gate. AgentWorkerBase defaults to `"all"` (respond to every
   * message) — which would pile a concurrent explorer turn onto every channel message
   * alongside other agents, diverging the channel log (GAD id-collision/replay-mismatch).
   */
  protected override getDefaultRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }

  /**
   * Visible when it responds. "Stays quiet unless addressed" is enforced by the respond
   * policy above — NOT by suppressing output. SilentAgentWorker's silent step policy hid
   * the ENTIRE turn (speak-only-via-`say`), which made an addressed explorer look
   * unresponsive even when it ran. Drop it so an addressed (or scheduled) run SHOWS its
   * work; findings still go to the committed file + the findings card.
   */
  protected override getStepPolicies(_channelId: string): StepPolicy[] {
    return defaultPolicies();
  }

  protected override getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): AgentTool[] {
    return [
      ...super.getLoopTools(channelId, execution),
      this.createReportFindingTool(channelId, execution?.rpc ?? this.rpc),
    ];
  }

  /**
   * Recurring autonomous sweep: kick a self-initiated turn in every subscribed
   * channel so the agent runs its loop without a user message. Wired via the
   * `vibestudio.yml recurring:` registry (server/harness caller only).
   */
  @rpc({ callers: ["server"] })
  async runScheduledJob(_args: unknown): Promise<{ ok: boolean; channels: number }> {
    const channelIds = this.subscriptions.listChannelIds();
    for (const channelId of channelIds) {
      if (!this.subscriptions.getParticipantId(channelId)) continue;
      await this.submitAgentInitiatedTurn(
        channelId,
        { content: SCHEDULED_SWEEP_PROMPT },
        { mode: "sequential", steeringId: `explorer-sweep:${channelId}:${Date.now()}` }
      );
    }
    return { ok: true, channels: channelIds.length };
  }

  // ── report_finding ────────────────────────────────────────────────────────

  private createReportFindingTool(
    channelId: string,
    toolRpc: AgentToolExecutionContext["rpc"]
  ): AgentTool<any> {
    return {
      name: "report_finding",
      label: "report_finding",
      description:
        "Record one discrepancy found while exploring. Appends it to this run's findings " +
        "file (committed + pushed for a durable, searchable history) and aggregates it into " +
        "the findings card in the connected chat panel. Call once per finding; group a run's " +
        "findings under a stable `runId`.",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description:
              'Stable id grouping this run\'s findings into one file + card, e.g. "2026-06-22-blobstore".',
          },
          class: {
            type: "string",
            enum: [...FINDING_CLASSES],
            description:
              "BUG = violates the contract/an invariant; DOC-MISMATCH = docs wrong/incomplete/misleading; SURPRISING = works but unexpected.",
          },
          surface: {
            type: "string",
            description: "The catalog id, e.g. service:blobstore.putText or runtime:vcs.",
          },
          title: { type: "string", description: "One-line summary of the finding." },
          expected: {
            type: "string",
            description: "What you expected (from the docs/contract) BEFORE the call.",
          },
          actual: { type: "string", description: "What actually happened." },
          repro: { type: "string", description: "Optional minimal steps/code to reproduce." },
          severity: {
            type: "string",
            enum: [...SEVERITIES],
            description: "Impact severity (default medium).",
          },
        },
        required: ["runId", "class", "surface", "title", "expected", "actual"],
      } as never,
      execute: async (toolCallId, params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const runId = str(p["runId"]).trim();
        const cls = str(p["class"]) as FindingClass;
        const surface = str(p["surface"]).trim();
        const title = str(p["title"]).trim();
        const expected = str(p["expected"]).trim();
        const actual = str(p["actual"]).trim();
        const repro = str(p["repro"]).trim() || undefined;
        const severityRaw = str(p["severity"]) as FindingSeverity;
        const severity: FindingSeverity = SEVERITIES.includes(severityRaw) ? severityRaw : "medium";

        if (!runId) throw new Error("report_finding requires a runId");
        if (!FINDING_CLASSES.includes(cls)) {
          throw new Error(`report_finding class must be one of ${FINDING_CLASSES.join(", ")}`);
        }
        if (!surface || !title || !expected || !actual) {
          throw new Error("report_finding requires surface, title, expected, and actual");
        }

        const contextId = this.subscriptions.getContextId(channelId);
        if (!contextId) throw new Error(`report_finding has no context for channel ${channelId}`);
        const command = (operation: string, basis: string) =>
          `explorer:${operation}:${toolCallId}:${basis}`;
        let op = this.loadFindingOp(toolCallId);
        if (!op) {
          const detail: FindingDetail = {
            id: toolCallId,
            ts: new Date().toISOString(),
            cls,
            surface,
            title,
            severity,
            expected,
            actual,
            ...(repro ? { repro } : {}),
          };
          const rows = [...this.loadFindings(channelId, runId), detail];
          const before = await toolRpc.call<{
            clean: boolean;
            workingHead:
              | { kind: "event"; eventId: string }
              | { kind: "application"; applicationId: string };
            mainEventId: string;
          }>("main", "vcs.status", [{ contextId }]);
          if (!before.clean) {
            throw new Error(
              "report_finding requires a clean explorer context; commit or discard unrelated work first"
            );
          }
          this.sql.exec(
            `INSERT INTO explorer_finding_ops
               (tool_call_id, channel_id, run_id, detail_json, file_path, file_text,
                summary, phase, expected_main_event_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
            toolCallId,
            channelId,
            runId,
            JSON.stringify(detail),
            findingsFilePath(runId),
            renderFindingsFile(runId, rows),
            `explorer: ${cls} on ${surface} (${runId})`,
            before.mainEventId,
            Date.now()
          );
          op = this.loadFindingOp(toolCallId)!;
        } else if (
          op.channelId !== channelId ||
          op.runId !== runId ||
          op.detail.cls !== cls ||
          op.detail.surface !== surface ||
          op.detail.title !== title ||
          op.detail.severity !== severity ||
          op.detail.expected !== expected ||
          op.detail.actual !== actual ||
          (op.detail.repro ?? undefined) !== repro
        ) {
          throw new Error(
            `report_finding invocation ${toolCallId} was reused with different input`
          );
        }

        if (op.phase === "prepared") {
          await toolRpc.call("main", "fs.writeFile", [op.filePath, op.fileText]);
          const authored = await toolRpc.call<{
            clean: boolean;
            workingHead:
              | { kind: "event"; eventId: string }
              | { kind: "application"; applicationId: string };
          }>("main", "vcs.status", [{ contextId }]);
          if (authored.clean) throw new Error("Managed findings write produced no semantic change");
          this.updateFindingOp(toolCallId, "authored", {
            expectedWorkingHead: authored.workingHead,
          });
          op = this.loadFindingOp(toolCallId)!;
        }
        if (op.phase === "authored") {
          if (!op.expectedWorkingHead) throw new Error("finding operation lost its authored head");
          const committed = await toolRpc.call<{ event: { kind: "event"; eventId: string } }>(
            "main",
            "vcs.commit",
            [
              {
                commandId: command("commit", op.expectedMainEventId),
                contextId,
                expectedWorkingHead: op.expectedWorkingHead,
                message: op.summary,
              },
            ]
          );
          this.updateFindingOp(toolCallId, "committed", {
            committedEventId: committed.event.eventId,
          });
          op = this.loadFindingOp(toolCallId)!;
        }
        if (op.phase === "committed") {
          if (!op.committedEventId) throw new Error("finding operation lost its committed event");
          let push: { eventId: string; mainEventId: string };
          try {
            push = await this.pushFinding(toolRpc, contextId, op, command);
          } catch (error) {
            if (!isRevisionChanged(error)) throw error;
            const recovered = await this.integrateLatestMain(toolRpc, contextId, op, command);
            if (recovered.alreadyPublished) {
              push = {
                eventId: recovered.committedEventId,
                mainEventId: recovered.mainEventId,
              };
            } else {
              op = this.loadFindingOp(toolCallId)!;
              push = await this.pushFinding(toolRpc, contextId, op, command);
            }
          }
          this.updateFindingOp(toolCallId, "published", {
            publishedEventId: push.eventId,
            publishedMainEventId: push.mainEventId,
          });
          op = this.loadFindingOp(toolCallId)!;
        }
        if (op.phase === "published") {
          this.ctx.storage.transactionSync(() => {
            this.persistFinding(channelId, runId, op!.detail);
            this.updateFindingOp(toolCallId, "finalized");
          });
          op = this.loadFindingOp(toolCallId)!;
        }

        const rows = this.loadFindings(channelId, runId);
        try {
          await this.ensureFindingsUi(channelId);
          await this.publishFindingsCard(
            channelId,
            runId,
            buildCardState(runId, op.filePath, rows, op.detail.ts)
          );
        } catch (error) {
          console.warn(
            "[Explorer] findings card projection failed after durable publication:",
            error
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `recorded ${op.detail.cls} on ${op.detail.surface} — ${rows.length} finding(s) in ${op.filePath} (main: ${op.publishedMainEventId})`,
            },
          ],
          details: {
            id: op.detail.id,
            filePath: op.filePath,
            total: rows.length,
            eventId: op.publishedEventId,
            mainEventId: op.publishedMainEventId,
          },
        };
      },
    };
  }

  private loadFindingOp(toolCallId: string): FindingOpRow | null {
    const row = this.sql
      .exec(`SELECT * FROM explorer_finding_ops WHERE tool_call_id = ?`, toolCallId)
      .toArray()[0];
    if (!row) return null;
    return {
      toolCallId: String(row["tool_call_id"]),
      channelId: String(row["channel_id"]),
      runId: String(row["run_id"]),
      detail: JSON.parse(String(row["detail_json"])) as FindingDetail,
      filePath: String(row["file_path"]),
      fileText: String(row["file_text"]),
      summary: String(row["summary"]),
      phase: String(row["phase"]) as FindingOpPhase,
      expectedWorkingHead:
        row["expected_working_head_json"] == null
          ? null
          : (JSON.parse(
              String(row["expected_working_head_json"])
            ) as FindingOpRow["expectedWorkingHead"]),
      expectedMainEventId: String(row["expected_main_event_id"]),
      committedEventId:
        row["committed_event_id"] == null ? null : String(row["committed_event_id"]),
      publishedEventId:
        row["published_event_id"] == null ? null : String(row["published_event_id"]),
      publishedMainEventId:
        row["published_main_event_id"] == null ? null : String(row["published_main_event_id"]),
    };
  }

  private pushFinding(
    toolRpc: AgentToolExecutionContext["rpc"],
    contextId: string,
    op: FindingOpRow,
    command: (operation: string, basis: string) => string
  ): Promise<{ eventId: string; mainEventId: string }> {
    if (!op.committedEventId) throw new Error("finding operation lost its committed event");
    return toolRpc.call("main", "vcs.push", [
      {
        commandId: command("publish", op.expectedMainEventId),
        contextId,
        expectedCommittedEventId: op.committedEventId,
        expectedMainEventId: op.expectedMainEventId,
      },
    ]);
  }

  /** Rebase a committed finding onto a concurrently advanced protected main.
   * Only mechanically safe semantic dispositions are accepted; conflicts stay
   * visible instead of inventing a content-resolution policy. */
  private async integrateLatestMain(
    toolRpc: AgentToolExecutionContext["rpc"],
    contextId: string,
    op: FindingOpRow,
    command: (operation: string, basis: string) => string
  ): Promise<{ alreadyPublished: boolean; committedEventId: string; mainEventId: string }> {
    if (!op.committedEventId) throw new Error("finding operation lost its committed event");
    const status = await toolRpc.call<VcsStatusResult>("main", "vcs.status", [{ contextId }]);
    if (!status.clean || status.committed.kind !== "event") {
      throw new Error("finding publication recovery requires its clean committed context");
    }
    if (status.committed.eventId !== op.committedEventId) {
      throw new Error("finding publication recovery found unrelated committed context work");
    }
    if (status.mainEventId === op.committedEventId) {
      return {
        alreadyPublished: true,
        committedEventId: op.committedEventId,
        mainEventId: status.mainEventId,
      };
    }

    const sourceEventId = status.mainEventId;
    let workingHead: VcsStateNodeRef = status.workingHead;
    for (;;) {
      const changes: VcsCompareResult["changes"] = [];
      let cursor: string | undefined;
      do {
        const page = await toolRpc.call<VcsCompareResult>("main", "vcs.compare", [
          {
            target: workingHead,
            sourceEventId,
            view: "changes",
            limit: 500,
            ...(cursor ? { cursor } : {}),
          },
        ]);
        changes.push(...page.changes);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const applicable = changes.find(
        (change) =>
          change.disposition.status === "actionable" &&
          change.disposition.applicability === "applicable"
      );
      if (applicable) {
        const integrated = await toolRpc.call<VcsIntegrateResult>("main", "vcs.integrate", [
          {
            commandId: command("integrate", `${sourceEventId}:${applicable.changeId}`),
            contextId,
            expectedWorkingHead: workingHead,
            sourceEventId,
            decision: { kind: "adopted", sourceChangeIds: [applicable.changeId] },
          },
        ]);
        workingHead = integrated.workingHead;
        continue;
      }
      const satisfied = changes.find(
        (change) => change.disposition.status === "already-satisfied"
      );
      if (satisfied && satisfied.disposition.status === "already-satisfied") {
        const integrated = await toolRpc.call<VcsIntegrateResult>("main", "vcs.integrate", [
          {
            commandId: command("reconcile", `${sourceEventId}:${satisfied.changeId}`),
            contextId,
            expectedWorkingHead: workingHead,
            sourceEventId,
            decision: {
              kind: "reconciled",
              sourceChangeIds: [satisfied.changeId],
              evidence: satisfied.disposition.evidence,
              rationale: "The finding context already satisfies this published change.",
            },
          },
        ]);
        workingHead = integrated.workingHead;
        continue;
      }
      const unresolved = changes.filter(
        (change) =>
          change.disposition.status === "actionable" ||
          change.disposition.status === "already-satisfied"
      );
      if (unresolved.length > 0) {
        throw new Error(
          `finding publication cannot safely integrate protected main changes: ${unresolved
            .map((change) => change.changeId)
            .join(", ")}`
        );
      }
      break;
    }

    const committed = await toolRpc.call<{ event: { kind: "event"; eventId: string } }>(
      "main",
      "vcs.commit",
      [
        {
          commandId: command("commit-integration", sourceEventId),
          contextId,
          expectedWorkingHead: workingHead,
          integratesEventId: sourceEventId,
          message: `${op.summary}; integrate protected main`,
        },
      ]
    );
    this.updateFindingOp(op.toolCallId, "committed", {
      expectedMainEventId: sourceEventId,
      committedEventId: committed.event.eventId,
    });
    return {
      alreadyPublished: false,
      committedEventId: committed.event.eventId,
      mainEventId: sourceEventId,
    };
  }

  private updateFindingOp(
    toolCallId: string,
    phase: FindingOpPhase,
    fields: {
      expectedWorkingHead?: FindingOpRow["expectedWorkingHead"];
      expectedMainEventId?: string;
      committedEventId?: string;
      publishedEventId?: string;
      publishedMainEventId?: string;
    } = {}
  ): void {
    this.sql.exec(
      `UPDATE explorer_finding_ops SET
         phase = ?,
         expected_working_head_json = COALESCE(?, expected_working_head_json),
         expected_main_event_id = COALESCE(?, expected_main_event_id),
         committed_event_id = COALESCE(?, committed_event_id),
         published_event_id = COALESCE(?, published_event_id),
         published_main_event_id = COALESCE(?, published_main_event_id),
         updated_at = ?
       WHERE tool_call_id = ?`,
      phase,
      fields.expectedWorkingHead ? JSON.stringify(fields.expectedWorkingHead) : null,
      fields.expectedMainEventId ?? null,
      fields.committedEventId ?? null,
      fields.publishedEventId ?? null,
      fields.publishedMainEventId ?? null,
      Date.now(),
      toolCallId
    );
  }

  private persistFinding(channelId: string, runId: string, detail: FindingDetail): void {
    const exists = this.sql
      .exec(
        `SELECT 1 FROM explorer_findings WHERE channel_id = ? AND run_id = ? AND id = ?`,
        channelId,
        runId,
        detail.id
      )
      .toArray();
    if (exists.length > 0) return;
    const prev = this.sql
      .exec(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM explorer_findings WHERE channel_id = ? AND run_id = ?`,
        channelId,
        runId
      )
      .toArray()[0];
    const seq = Number(prev?.["m"] ?? 0) + 1;
    this.sql.exec(
      `INSERT INTO explorer_findings
         (channel_id, run_id, seq, id, ts, cls, surface, title, severity, expected, actual, repro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      runId,
      seq,
      detail.id,
      detail.ts,
      detail.cls,
      detail.surface,
      detail.title,
      detail.severity,
      detail.expected,
      detail.actual,
      detail.repro ?? null
    );
  }

  private loadFindings(channelId: string, runId: string): FindingDetail[] {
    return this.sql
      .exec(
        `SELECT * FROM explorer_findings WHERE channel_id = ? AND run_id = ? ORDER BY seq`,
        channelId,
        runId
      )
      .toArray()
      .map((r) => ({
        id: String(r["id"]),
        ts: String(r["ts"]),
        cls: String(r["cls"]) as FindingClass,
        surface: String(r["surface"]),
        title: String(r["title"]),
        severity: String(r["severity"]) as FindingSeverity,
        expected: String(r["expected"]),
        actual: String(r["actual"]),
        ...(r["repro"] == null ? {} : { repro: String(r["repro"]) }),
      }));
  }

  private async ensureFindingsUi(channelId: string): Promise<void> {
    if (this.installedUi.has(channelId)) return;
    await installMessageTypes({
      channel: this.createChannelClient(channelId),
      actor: { kind: "agent", id: this.participantId(), participantId: this.participantId() },
      specs: FINDINGS_MESSAGE_TYPES,
      imports: FINDINGS_UI_IMPORTS,
      version: FINDINGS_UI_INSTALL_VERSION,
      keyPrefix: FINDINGS_KEY_PREFIX,
      cards: this.cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await this.rpc.call<unknown>("main", "fs.readFile", [path, "utf8"]);
          return typeof raw === "string" ? raw : null;
        } catch {
          return null;
        }
      },
    });
    this.installedUi.add(channelId);
  }

  private async publishFindingsCard(
    channelId: string,
    runId: string,
    state: ReturnType<typeof buildCardState>
  ): Promise<void> {
    const key = findingsCardKey(runId);
    const existing = this.cards.find(channelId, key);
    if (existing) {
      await existing.update(state);
      return;
    }
    await this.cards.getOrCreate(channelId, FINDINGS_TYPE_ID, key, state, {
      displayMode: "inline",
    });
  }
}

function isRevisionChanged(error: unknown): boolean {
  const data = rpcErrorDataOf(error);
  if (data && typeof data === "object" && "code" in data && data.code === "RevisionChanged") {
    return true;
  }
  return (error as { code?: unknown } | null)?.code === "RevisionChanged";
}

export default {
  fetch(_req: Request) {
    return new Response("explorer-agent DO service");
  },
};
