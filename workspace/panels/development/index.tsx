import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Dialog,
  Flex,
  Heading,
  ScrollArea,
  Separator,
  Spinner,
  Table,
  Text,
  Theme,
} from "@radix-ui/themes";
import {
  ExclamationTriangleIcon,
  ReloadIcon,
  RocketIcon,
  StopIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { contextId, git, openPanel, rpc, vcs } from "@workspace/runtime";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { createDurableObjectServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
import {
  developmentBuiltinMethods,
  type DevelopmentClientExecutor,
  type DevelopmentRun,
  type DevelopmentRunEvent,
  type DevelopmentSession,
  type DevelopmentTarget,
} from "@vibestudio/service-schemas/development";
import type { GitImportedWorkspaceRepo } from "@vibestudio/service-schemas/gitInterop";
import {
  permissionsMethods,
  type SavedPermissionGrant,
} from "@vibestudio/service-schemas/permissions";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import {
  activeDevelopmentGrants,
  adoptedRepositoryId,
  appendUniquePage,
  dirtyStateLabel,
  IntentLedger,
  instanceSummary,
  knownEffects,
  latestLogLines,
  runSummary,
  sessionStateLabel,
  targetKey,
  targetLabel,
  VIBESTUDIO_PROJECT,
} from "./model.js";

const developmentReceiver = createDurableObjectServiceClient(rpc, "vibestudio.development.v1");
const development = createTypedServiceClient(
  "development",
  developmentBuiltinMethods,
  (_service, method, args) => developmentReceiver.call(method, ...args)
);
const permissions = createTypedServiceClient(
  "permissions",
  permissionsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);

interface DevelopmentPanelArgs {
  repositoryId?: string;
  /** Lets 4B/4D/4E/C launchers hand off the exact source they selected. */
  source?: { repositoryId?: string; repoPath?: string; state?: string; dirty?: boolean };
}

type DevelopmentSessionMode = "semantic" | "native-tool";
type NativeDevelopmentTool = "claude-code" | "system-editor";
interface NativeToolAvailability {
  toolId: NativeDevelopmentTool;
  executorId: string | null;
  available: boolean;
  unavailableReason: string | null;
  interactiveTerminal: boolean;
}
interface SessionCursor {
  createdAt: number;
  sessionId: string;
}
interface RunCursor {
  createdAt: number;
  runId: string;
}
const PAGE_LIMIT = 30;

function targetForKey(targets: readonly DevelopmentTarget[], key: string): DevelopmentTarget {
  return targets.find((target) => targetKey(target) === key) ?? targets[0]!;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function date(value?: number): string {
  return value ? new Date(value).toLocaleString() : "No expiry";
}

function stateRef(state: DevelopmentSession["basis"]["childBaseState"]): string {
  return state.kind === "event" ? state.eventId : state.applicationId;
}

function primaryActionFor(run: DevelopmentRun): "retry" | "stop" | null {
  if (run.state === "failed" && run.repair?.retryable) return "retry";
  return ["accepted", "materializing", "installing", "building", "stopping"].includes(run.state)
    ? "stop"
    : null;
}

export default function DevelopmentPanel() {
  const theme = usePanelTheme();
  const args = useStateArgs<DevelopmentPanelArgs>();
  const routedRepositoryId = args.source?.repositoryId ?? args.repositoryId ?? null;
  const [repositoryId, setRepositoryId] = useState<string | null>(routedRepositoryId);
  const [repositoryResolutionComplete, setRepositoryResolutionComplete] = useState(
    routedRepositoryId !== null
  );
  const [sessions, setSessions] = useState<DevelopmentSession[]>([]);
  const [runs, setRuns] = useState<DevelopmentRun[]>([]);
  const [grants, setGrants] = useState<SavedPermissionGrant[]>([]);
  const [nativeTools, setNativeTools] = useState<NativeToolAvailability[]>([]);
  const [clientExecutors, setClientExecutors] = useState<DevelopmentClientExecutor[]>([]);
  const [events, setEvents] = useState<DevelopmentRunEvent[]>([]);
  const [mode, setMode] = useState<DevelopmentSessionMode>("semantic");
  const [nativeTool, setNativeTool] = useState<NativeDevelopmentTool>("claude-code");
  const [selectedTargetKey, setSelectedTargetKey] = useState("build-only");
  const [terminalText, setTerminalText] = useState("");
  const [terminalOutput, setTerminalOutput] = useState<string | null>(null);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState<"sessions" | "runs" | null>(null);
  const [nextSessionCursor, setNextSessionCursor] = useState<SessionCursor | null>(null);
  const [nextRunCursor, setNextRunCursor] = useState<RunCursor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "destroy-session" | "force-retire" | "force-retire-session";
    id: string;
  } | null>(null);
  const [adoption, setAdoption] = useState<GitImportedWorkspaceRepo | null>(null);
  const intentIds = useRef(new IntentLedger());
  const selectedRunIdRef = useRef<string | null>(null);

  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;
  const selectedSession =
    sessions.find((session) => session.sessionId === selectedRun?.sessionId) ?? sessions[0] ?? null;
  const targets = useMemo<DevelopmentTarget[]>(
    () => [
      { kind: "build-only" },
      { kind: "isolated-host", includeClient: false },
      ...clientExecutors.flatMap<DevelopmentTarget>((executor) => [
        { kind: "client-device", client: "electron", executorId: executor.executorId },
        { kind: "isolated-host", includeClient: true, executorId: executor.executorId },
      ]),
    ],
    [clientExecutors]
  );
  const selectedTarget = targetForKey(targets, selectedTargetKey);
  const selectedNativeTool = nativeTools.find((tool) => tool.toolId === nativeTool) ?? null;
  const confirmedSession =
    confirm?.kind === "force-retire-session"
      ? (sessions.find((session) => session.sessionId === confirm.id) ?? null)
      : null;
  const confirmedRun =
    confirm?.kind === "force-retire"
      ? (runs.find((run) => run.runId === confirm.id) ?? null)
      : null;

  const resolveRepositoryIdentity = useCallback(async () => {
    if (routedRepositoryId) {
      setRepositoryId(routedRepositoryId);
      setRepositoryResolutionComplete(true);
      return;
    }
    try {
      const status = await vcs.status();
      const resolved = await vcs.resolveRepository({
        state: status.workingHead,
        repoPath: VIBESTUDIO_PROJECT.path,
      });
      setRepositoryId(resolved?.repositoryId ?? null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRepositoryResolutionComplete(true);
    }
  }, [routedRepositoryId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSessions, nextRuns, nextGrants, nextNativeTools, nextClientExecutors] =
        await Promise.all([
          development.listSessions({ limit: PAGE_LIMIT }),
          development.list({ limit: PAGE_LIMIT }),
          permissions.list(),
          development.listNativeTools(),
          development.listClientExecutors(),
        ]);
      setSessions(nextSessions.sessions);
      setRuns(nextRuns.runs);
      setGrants(nextGrants);
      setNativeTools(nextNativeTools);
      setClientExecutors(nextClientExecutors);
      setNextSessionCursor(nextSessions.nextCursor);
      setNextRunCursor(nextRuns.nextCursor);
      const nextRunId =
        selectedRunIdRef.current &&
        nextRuns.runs.some((run) => run.runId === selectedRunIdRef.current)
          ? selectedRunIdRef.current
          : (nextRuns.runs[0]?.runId ?? null);
      selectedRunIdRef.current = nextRunId;
      setSelectedRunId(nextRunId);
      if (nextRunId)
        setEvents((await development.events({ runId: nextRunId, after: 0, limit: 200 })).events);
      else setEvents([]);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOlderSessions = useCallback(async () => {
    if (!nextSessionCursor) return;
    setLoadingOlder("sessions");
    setError(null);
    try {
      const page = await development.listSessions({ cursor: nextSessionCursor, limit: PAGE_LIMIT });
      setSessions((current) =>
        appendUniquePage(current, page.sessions, (session) => session.sessionId)
      );
      setNextSessionCursor(page.nextCursor);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoadingOlder(null);
    }
  }, [nextSessionCursor]);

  const loadOlderRuns = useCallback(async () => {
    if (!nextRunCursor) return;
    setLoadingOlder("runs");
    setError(null);
    try {
      const page = await development.list({ cursor: nextRunCursor, limit: PAGE_LIMIT });
      setRuns((current) => appendUniquePage(current, page.runs, (run) => run.runId));
      setNextRunCursor(page.nextCursor);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoadingOlder(null);
    }
  }, [nextRunCursor]);

  const intentId = useCallback((intent: string): string => {
    return intentIds.current.idFor(intent, () => crypto.randomUUID());
  }, []);

  useEffect(() => void load(), [load]);
  useEffect(() => void resolveRepositoryIdentity(), [resolveRepositoryIdentity]);

  useEffect(() => {
    const dispose = rpc.on("development:run-event", ({ payload }) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const event = payload as { runId?: unknown; event?: unknown };
      if (typeof event.runId !== "string" || !event.event || typeof event.event !== "object")
        return;
      if (event.runId !== selectedRunId) return;
      const nextEvent = event.event as DevelopmentRunEvent;
      setEvents((current) =>
        current.some((item) => item.sequence === nextEvent.sequence)
          ? current
          : [...current, nextEvent].sort((left, right) => left.sequence - right.sequence)
      );
      if (nextEvent.kind === "state") {
        void development
          .get({ runId: event.runId })
          .then((run) => {
            if (!run) return;
            setRuns((current) => current.map((item) => (item.runId === run.runId ? run : item)));
          })
          .catch((error) =>
            console.warn(`[development] Failed to refresh run ${event.runId}:`, error)
          );
      }
    });
    return () => dispose();
  }, [selectedRunId]);

  const invoke = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await load();
        // A successful refresh proves the command reached a durable outcome, so
        // the next deliberate click is a new intent. Keep the id on transport
        // ambiguity: the caller can safely replay the exact same operation.
        intentIds.current.settle(key);
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const openSession = () =>
    invoke(`open:${repositoryId ?? VIBESTUDIO_PROJECT.path}`, async () => {
      if (!repositoryId) {
        throw new Error(
          "Vibestudio has not been adopted in this semantic state. Adopt its source first."
        );
      }
      const result = await development.openSession({
        repositoryId,
        mode,
        ...(mode === "native-tool" ? { nativeTool } : {}),
        idempotencyKey: intentId(`open:${repositoryId}`),
      });
      if (result.kind === "repository-not-adopted") {
        setMessage(
          "Vibestudio has not been adopted into this semantic context. Review and explicitly adopt its source below; no source was changed."
        );
        return;
      }
      setMessage(
        `${result.session.mode === "native-tool" ? "Native-tool" : "Semantic"} development session ${result.session.sessionId.slice(0, 16)} is ready.`
      );
    });

  const adoptSource = () =>
    invoke("adopt", async () => {
      const imported = await git.importProject({
        path: VIBESTUDIO_PROJECT.path,
        remote: VIBESTUDIO_PROJECT.remote,
      });
      const importedRepositoryId = adoptedRepositoryId(imported);
      setRepositoryId(importedRepositoryId);
      setRepositoryResolutionComplete(true);
      setAdoption(imported);
      setMessage(
        "Source was imported as a semantic candidate. Integrate it through normal VCS flow before opening a session; nothing was reset or refreshed."
      );
    });

  const start = (session: DevelopmentSession) =>
    invoke(`start:${session.sessionId}`, async () => {
      const recipe = (await development.listRecipes()).find(
        (candidate) =>
          candidate.target.kind === selectedTarget.kind &&
          (candidate.target.kind !== "isolated-host" ||
            (selectedTarget.kind === "isolated-host" &&
              candidate.target.includeClient === selectedTarget.includeClient))
      );
      if (!recipe) throw new Error("No reviewed development recipe is available on this executor.");
      const run = await development.start({
        sessionId: session.sessionId,
        runId: intentId(`start:${session.sessionId}`),
        recipeId: recipe.recipeId,
        target: selectedTarget,
      });
      selectedRunIdRef.current = run.runId;
      setSelectedRunId(run.runId);
    });

  const inspectNative = (session: DevelopmentSession) =>
    invoke(`inspect-native:${session.sessionId}`, () =>
      development.inspectNative({ sessionId: session.sessionId, assessPendingChanges: true })
    );

  const readNativeTerminal = (session: DevelopmentSession) =>
    invoke(`terminal-read:${session.sessionId}`, async () => {
      const terminal = await development.readNativeTerminal({
        sessionId: session.sessionId,
        maxBytes: 128 * 1024,
      });
      setTerminalSessionId(session.sessionId);
      setTerminalOutput(terminal.text || "No terminal output is currently retained.");
    });

  const writeNativeTerminal = (session: DevelopmentSession) =>
    invoke(`terminal-write:${session.sessionId}:${terminalText}`, async () => {
      if (!terminalText) return;
      await development.writeNativeTerminal({
        sessionId: session.sessionId,
        writeId: intentId(`terminal-write:${session.sessionId}:${terminalText}`),
        data: terminalText,
      });
      setTerminalText("");
    });

  const openIntegrationChat = useCallback(
    (input: {
      sourceContextId: string;
      sourceEventId: string;
      targetContextId: string;
      repositoryId: string;
      reason: "source adoption" | "native checkpoint";
    }) =>
      openPanel("panels/chat", {
        focus: true,
        contextId: input.targetContextId,
        title: `Integrate ${input.reason}`,
        stateArgs: {
          initialPrompt: [
            `Integrate the exact ${input.reason} through the ordinary documented semantic VCS workflow.`,
            `Source context: ${input.sourceContextId}.`,
            `Source event: ${input.sourceEventId}.`,
            `Target context: ${input.targetContextId}.`,
            `Repository: ${input.repositoryId}.`,
            "First compare the exact source event with the target, then incrementally account for every effective source change using normal VCS integration. Do not reset, overwrite, or infer from a filesystem projection. Report conflicts or remaining changes instead of claiming completion.",
          ].join(" "),
          forceInitialPrompt: true,
        },
      }),
    []
  );

  const logs = useMemo(() => latestLogLines(events), [events]);
  const devGrants = useMemo(() => activeDevelopmentGrants(grants), [grants]);

  return (
    <Theme appearance={theme} accentColor="blue" grayColor="slate" radius="medium" scaling="100%">
      <Box p="4" style={{ minHeight: "100dvh", background: "var(--color-background)" }}>
        <Flex justify="between" align="center" mb="4" gap="3" wrap="wrap">
          <Box>
            <Heading size="7">Development</Heading>
            <Text color="gray">
              Exact semantic Vibestudio builds — never this server’s checkout.
            </Text>
          </Box>
          <Flex gap="2">
            <Button variant="soft" onClick={() => void load()} disabled={loading}>
              <ReloadIcon /> Refresh
            </Button>
            <Button
              onClick={() => void openSession()}
              loading={busy === `open:${repositoryId ?? VIBESTUDIO_PROJECT.path}`}
              disabled={
                loading ||
                !repositoryId ||
                (mode === "native-tool" && selectedNativeTool?.available !== true)
              }
            >
              <RocketIcon /> Open session
            </Button>
          </Flex>
        </Flex>

        {error && (
          <Callout.Root color="red" mb="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        {message && (
          <Callout.Root color="blue" mb="3">
            <Callout.Text>{message}</Callout.Text>
          </Callout.Root>
        )}

        <Card mb="3">
          <Flex justify="between" gap="3" wrap="wrap">
            <Box>
              <Heading size="4">Source</Heading>
              <Text as="div" color="gray">
                Context <Code>{contextId}</Code> · repository <Code>{repositoryId}</Code>
              </Text>
              <Text as="div" color="gray">
                Canonical upstream <Code>{VIBESTUDIO_PROJECT.remote.url}</Code> ·{" "}
                {VIBESTUDIO_PROJECT.remote.branch}
              </Text>
              <Text as="div" color="gray">
                {dirtyStateLabel(selectedSession, args.source?.dirty)}
              </Text>
              {args.source?.state && (
                <Text as="div" color="gray">
                  Routed exact state <Code>{args.source.state}</Code>
                </Text>
              )}
              {!repositoryId && repositoryResolutionComplete && (
                <Text as="div" color="orange">
                  No repository identity exists at this semantic state. Adopt source to create one.
                </Text>
              )}
            </Box>
            <Button variant="soft" onClick={() => void adoptSource()} loading={busy === "adopt"}>
              Adopt source
            </Button>
          </Flex>
          <Text as="p" size="2" color="gray" mt="2">
            Adoption creates an ordinary semantic import candidate. It never refreshes, resets, or
            discards local semantic work.
          </Text>
          {adoption && (
            <Callout.Root color="green" mt="3">
              <Callout.Text>
                Candidate <Code>{adoption.candidate.eventId}</Code> is ready for normal semantic
                integration.{" "}
                <Button
                  size="1"
                  variant="ghost"
                  onClick={() =>
                    void openPanel("panels/gad-browser", { stateArgs: { gitRepo: adoption.path } })
                  }
                >
                  Inspect integration
                </Button>
                {repositoryId && (
                  <Button
                    size="1"
                    variant="ghost"
                    onClick={() =>
                      void openIntegrationChat({
                        sourceContextId: adoption.candidate.contextId,
                        sourceEventId: adoption.candidate.eventId,
                        targetContextId: contextId,
                        repositoryId,
                        reason: "source adoption",
                      })
                    }
                  >
                    Integrate with agent…
                  </Button>
                )}
              </Callout.Text>
            </Callout.Root>
          )}
          <Flex mt="3" gap="3" align="end" wrap="wrap">
            <label>
              <Text as="div" size="2" weight="bold">
                Session mode
              </Text>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as DevelopmentSessionMode)}
              >
                <option value="semantic">Semantic workspace</option>
                <option value="native-tool">Native tool in owned tree</option>
              </select>
            </label>
            {mode === "native-tool" && (
              <label>
                <Text as="div" size="2" weight="bold">
                  Native tool
                </Text>
                <select
                  value={nativeTool}
                  onChange={(event) => setNativeTool(event.target.value as NativeDevelopmentTool)}
                >
                  {nativeTools.map((tool) => (
                    <option key={tool.toolId} value={tool.toolId} disabled={!tool.available}>
                      {tool.toolId === "claude-code" ? "Claude Code" : "System editor"}
                      {tool.available ? "" : " — unavailable"}
                    </option>
                  ))}
                </select>
                {selectedNativeTool && !selectedNativeTool.available && (
                  <Text as="div" size="1" color="orange">
                    {selectedNativeTool.unavailableReason ?? "No reviewed executor is available."}
                  </Text>
                )}
                {nativeTools.length === 0 && !loading && (
                  <Text as="div" size="1" color="orange">
                    No reviewed native development tool is installed on this executor.
                  </Text>
                )}
                {selectedNativeTool?.available && (
                  <Text as="div" size="1" color="gray">
                    Executor {selectedNativeTool.executorId} ·{" "}
                    {selectedNativeTool.interactiveTerminal
                      ? "interactive terminal"
                      : "non-interactive tool"}
                  </Text>
                )}
              </label>
            )}
            <Text size="2" color="orange" style={{ maxWidth: 520 }}>
              Native tools and project build code execute with this executor’s local OS authority;
              they are not a sandbox. Native edits enter semantic history only through an explicit
              checkpoint.
            </Text>
          </Flex>
        </Card>

        <Flex gap="3" direction={{ initial: "column", md: "row" }}>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Card>
              <Heading size="4" mb="2">
                Sessions
              </Heading>
              <label>
                <Text as="div" size="2" weight="bold">
                  Build target
                </Text>
                <select
                  value={selectedTargetKey}
                  onChange={(event) => setSelectedTargetKey(event.target.value)}
                >
                  {targets.map((target) => (
                    <option key={targetKey(target)} value={targetKey(target)}>
                      {targetLabel(target)}
                    </option>
                  ))}
                </select>
              </label>
              <Text as="p" size="2" color="gray">
                The selected target is paired only with an exact reviewed recipe and executor; no
                command line is editable here.
              </Text>
              {loading && <Spinner />}
              {!loading && sessions.length === 0 && (
                <Text color="gray">
                  No development session yet. Opening one only forks semantic source state.
                </Text>
              )}
              <Flex direction="column" gap="2">
                {sessions.map((session) => (
                  <Card key={session.sessionId} variant="surface">
                    <Flex justify="between" gap="2" wrap="wrap">
                      <Box>
                        <Text weight="bold">{session.repository.repoPath}</Text>
                        <Text as="div" size="2" color="gray">
                          {sessionStateLabel(session)} · exact state{" "}
                          <Code>{stateRef(session.basis.childBaseState)}</Code>
                        </Text>
                        <Text as="div" size="2" color="gray">
                          Parent head <Code>{stateRef(session.basis.parentWorkingHead)}</Code> ·
                          child context <Code>{session.contextId}</Code>
                        </Text>
                      </Box>
                      <Badge color={session.state === "requires-repair" ? "orange" : "blue"}>
                        {sessionStateLabel(session)}
                      </Badge>
                    </Flex>
                    <Flex mt="2" gap="2" wrap="wrap">
                      {session.state === "ready" && (
                        <Button
                          size="1"
                          onClick={() => void start(session)}
                          loading={busy === `start:${session.sessionId}`}
                        >
                          Build exact state
                        </Button>
                      )}
                      <Button
                        size="1"
                        variant="soft"
                        disabled={busy !== null}
                        onClick={() =>
                          void invoke(`close:${session.sessionId}`, () =>
                            development.closeSession({
                              sessionId: session.sessionId,
                              idempotencyKey: intentId(`close:${session.sessionId}`),
                            })
                          )
                        }
                      >
                        Close, retain context
                      </Button>
                      {session.state === "requires-repair" && (
                        <>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy !== null}
                            onClick={() =>
                              void invoke(`keep-session:${session.sessionId}`, () =>
                                development.keepSessionRepair({
                                  sessionId: session.sessionId,
                                  idempotencyKey: intentId(`keep-session:${session.sessionId}`),
                                })
                              )
                            }
                          >
                            Keep
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy !== null}
                            onClick={() =>
                              void invoke(`retry-session:${session.sessionId}`, () =>
                                development.retrySessionCleanup({
                                  sessionId: session.sessionId,
                                  idempotencyKey: intentId(`retry-session:${session.sessionId}`),
                                })
                              )
                            }
                          >
                            Retry cleanup
                          </Button>
                          <Button
                            size="1"
                            color="red"
                            variant="soft"
                            disabled={busy !== null}
                            onClick={() =>
                              setConfirm({ kind: "force-retire-session", id: session.sessionId })
                            }
                          >
                            Force-retire…
                          </Button>
                        </>
                      )}
                      <Button
                        size="1"
                        color="red"
                        variant="soft"
                        onClick={() =>
                          setConfirm({ kind: "destroy-session", id: session.sessionId })
                        }
                      >
                        Destroy context…
                      </Button>
                    </Flex>
                    {session.native && (
                      <Card variant="surface" mt="2">
                        <Flex justify="between" gap="2" wrap="wrap">
                          <Box>
                            <Text weight="bold">{session.native.toolId}</Text>
                            <Text as="div" size="2" color="gray">
                              {session.native.state} · pending changes:{" "}
                              {session.native.pendingChanges}
                            </Text>
                            <Text as="div" size="2" color="gray">
                              Owned root <Code>{session.native.ownedRootId}</Code> · executor{" "}
                              <Code>{session.native.executorId}</Code>
                            </Text>
                            {session.native.lastCheckpoint && (
                              <Text as="div" size="2" color="gray">
                                Last checkpoint{" "}
                                <Code>{session.native.lastCheckpoint.snapshotRevision}</Code>
                              </Text>
                            )}
                          </Box>
                          <Badge
                            color={session.native.pendingChanges === "present" ? "orange" : "blue"}
                          >
                            {session.native.pendingChanges}
                          </Badge>
                        </Flex>
                        <Flex mt="2" gap="2" wrap="wrap">
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy !== null}
                            onClick={() => void inspectNative(session)}
                          >
                            Inspect changes
                          </Button>
                          {session.native.state === "ready" && (
                            <Button
                              size="1"
                              disabled={busy !== null}
                              onClick={() =>
                                void invoke(`checkpoint:${session.sessionId}`, () =>
                                  development.checkpoint({
                                    sessionId: session.sessionId,
                                    idempotencyKey: intentId(`checkpoint:${session.sessionId}`),
                                  })
                                )
                              }
                            >
                              Checkpoint into semantic history
                            </Button>
                          )}
                          {session.native.lastCheckpoint && (
                            <Button
                              size="1"
                              variant="soft"
                              disabled={busy !== null}
                              onClick={() =>
                                void openIntegrationChat({
                                  sourceContextId: session.contextId,
                                  sourceEventId: session.native!.lastCheckpoint!.imported.eventId,
                                  targetContextId: session.parentContextId,
                                  repositoryId: session.repository.repositoryId,
                                  reason: "native checkpoint",
                                })
                              }
                            >
                              Integrate checkpoint…
                            </Button>
                          )}
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy !== null}
                            onClick={() => void readNativeTerminal(session)}
                          >
                            Read terminal
                          </Button>
                          {session.native.process && session.native.state !== "stopped" && (
                            <Button
                              size="1"
                              color="orange"
                              variant="soft"
                              disabled={busy !== null}
                              onClick={() =>
                                void invoke(`stop-native:${session.sessionId}`, () =>
                                  development.stopNativeTool({
                                    sessionId: session.sessionId,
                                    idempotencyKey: intentId(`stop-native:${session.sessionId}`),
                                  })
                                )
                              }
                            >
                              Stop native tool
                            </Button>
                          )}
                        </Flex>
                        {terminalOutput !== null && terminalSessionId === session.sessionId && (
                          <>
                            <ScrollArea
                              type="always"
                              scrollbars="vertical"
                              style={{ height: 140, marginTop: 8 }}
                            >
                              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                                {terminalOutput}
                              </pre>
                            </ScrollArea>
                            {session.native.process && (
                              <Flex mt="2" gap="2">
                                <input
                                  aria-label="Native terminal input"
                                  value={terminalText}
                                  onChange={(event) => setTerminalText(event.target.value)}
                                  style={{ flex: 1 }}
                                />
                                <Button
                                  size="1"
                                  disabled={!terminalText || busy !== null}
                                  onClick={() => void writeNativeTerminal(session)}
                                >
                                  Send
                                </Button>
                              </Flex>
                            )}
                          </>
                        )}
                        {session.native.repair && (
                          <Callout.Root color="orange" mt="2">
                            <Callout.Text>
                              {session.native.repair.phase}: {session.native.repair.primaryError}
                              <br />
                              Native tree: {session.native.repair.knownEffects.nativeTree} ·
                              process: {session.native.repair.knownEffects.process} · imported
                              event: {session.native.repair.knownEffects.importedEvent}
                              <br />
                              Owned root: {session.native.ownedRootId} · process ownership:{" "}
                              {session.native.process?.ownershipToken ?? "no live process receipt"}
                              {session.native.repair.cleanupErrors.map((cleanupError) => (
                                <Text as="div" key={cleanupError}>
                                  Cleanup: {cleanupError}
                                </Text>
                              ))}
                            </Callout.Text>
                          </Callout.Root>
                        )}
                      </Card>
                    )}
                    {session.primaryDiagnostic && (
                      <Callout.Root color="orange" mt="2">
                        <Callout.Text>
                          {session.primaryDiagnostic.code}: {session.primaryDiagnostic.message}
                          <br />
                          Child context: {session.contextId} · context effect:{" "}
                          {session.contextEffect}
                          {session.cleanupDiagnostics.map((diagnostic) => (
                            <Text as="div" key={`${diagnostic.code}:${diagnostic.at}`}>
                              Cleanup {diagnostic.code}: {diagnostic.message}
                            </Text>
                          ))}
                        </Callout.Text>
                      </Callout.Root>
                    )}
                  </Card>
                ))}
              </Flex>
              {nextSessionCursor && (
                <Button
                  mt="3"
                  size="1"
                  variant="soft"
                  loading={loadingOlder === "sessions"}
                  disabled={loadingOlder !== null}
                  onClick={() => void loadOlderSessions()}
                >
                  Load older sessions
                </Button>
              )}
            </Card>
          </Box>

          <Box style={{ flex: 1.25, minWidth: 0 }}>
            <Card>
              <Heading size="4" mb="2">
                Builds and live output
              </Heading>
              {runs.length === 0 ? (
                <Text color="gray">
                  Exact build progress, logs, digests, and repair facts appear here once a build
                  starts.
                </Text>
              ) : (
                <Table.Root variant="surface">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>Run</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>State</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {runs.map((run) => (
                      <Table.Row key={run.runId}>
                        <Table.Cell>
                          <Button
                            variant="ghost"
                            size="1"
                            onClick={() => {
                              selectedRunIdRef.current = run.runId;
                              setSelectedRunId(run.runId);
                              void development
                                .events({ runId: run.runId, after: 0, limit: 200 })
                                .then((page) => setEvents(page.events));
                            }}
                          >
                            <Code>{run.runId.slice(0, 12)}</Code>
                          </Button>
                          <Text as="div" size="1" color="gray">
                            {runSummary(run)}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge
                            color={
                              run.state === "failed" || run.state === "requires-repair"
                                ? "orange"
                                : "blue"
                            }
                          >
                            {run.state}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          {primaryActionFor(run) === "stop" && (
                            <Button
                              size="1"
                              variant="soft"
                              disabled={busy !== null}
                              onClick={() =>
                                void invoke(`stop:${run.runId}`, () =>
                                  development.stop({
                                    runId: run.runId,
                                    idempotencyKey: intentId(`stop:${run.runId}`),
                                  })
                                )
                              }
                            >
                              <StopIcon /> Stop
                            </Button>
                          )}
                          {primaryActionFor(run) === "retry" && (
                            <Button
                              size="1"
                              variant="soft"
                              disabled={busy !== null}
                              onClick={() =>
                                void invoke(`retry:${run.runId}`, () =>
                                  development.retry({
                                    runId: run.runId,
                                    idempotencyKey: intentId(`retry:${run.runId}`),
                                  })
                                )
                              }
                            >
                              Retry
                            </Button>
                          )}
                          {run.state === "requires-repair" && (
                            <Flex gap="1">
                              <Button
                                size="1"
                                variant="soft"
                                disabled={busy !== null}
                                onClick={() =>
                                  void invoke(`keep-run:${run.runId}`, () =>
                                    development.keepRunRepair({
                                      runId: run.runId,
                                      idempotencyKey: intentId(`keep-run:${run.runId}`),
                                    })
                                  )
                                }
                              >
                                Keep
                              </Button>
                              <Button
                                size="1"
                                color="red"
                                variant="soft"
                                disabled={busy !== null}
                                onClick={() => setConfirm({ kind: "force-retire", id: run.runId })}
                              >
                                <TrashIcon /> Force-retire…
                              </Button>
                            </Flex>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
              {nextRunCursor && (
                <Button
                  mt="3"
                  size="1"
                  variant="soft"
                  loading={loadingOlder === "runs"}
                  disabled={loadingOlder !== null}
                  onClick={() => void loadOlderRuns()}
                >
                  Load older runs
                </Button>
              )}
              {selectedRun && (
                <>
                  <Separator my="3" />
                  <Heading size="3">{selectedRun.runId}</Heading>
                  <Text as="div" size="2" color="gray">
                    Snapshot <Code>{selectedRun.snapshot.snapshotDigest}</Code> · source{" "}
                    <Code>{stateRef(selectedRun.snapshot.repositoryState)}</Code>
                  </Text>
                  <Text as="div" size="2" color="gray">
                    Recipe <Code>{selectedRun.recipe.recipeId}</Code> · lockfiles{" "}
                    <Code>{selectedRun.snapshot.lockfileDigest}</Code>
                  </Text>
                  <Text as="div" size="2" color="gray">
                    Toolchain node {selectedRun.snapshot.toolchain.node.version} / pnpm{" "}
                    {selectedRun.snapshot.toolchain.pnpm.version} · commit point{" "}
                    {selectedRun.commitPoint}
                  </Text>
                  <Text as="div" size="2" color="gray">
                    Target {targetLabel(selectedRun.target)}
                  </Text>
                  {selectedRun.artifact && (
                    <>
                      <Text as="div" size="2" color="gray">
                        Execution digest <Code>{selectedRun.artifact.executionDigest}</Code>
                      </Text>
                      <Text as="div" size="2" color="gray">
                        Artifact <Code>{selectedRun.artifact.artifactDigest}</Code> · build key{" "}
                        <Code>{selectedRun.artifact.buildKey}</Code>
                      </Text>
                    </>
                  )}
                  <Text as="div" size="2" color="gray">
                    {instanceSummary(selectedRun.instance)}
                  </Text>
                  {selectedRun.instance && (
                    <Text as="div" size="2" color="gray">
                      Server build <Code>{selectedRun.instance.serverBuildId}</Code> · execution{" "}
                      <Code>{selectedRun.instance.executionDigest}</Code>
                    </Text>
                  )}
                  {selectedRun.hostReadiness && (
                    <Text as="div" size="2" color="gray">
                      Host readiness <Badge>{selectedRun.hostReadiness}</Badge>
                    </Text>
                  )}
                  {selectedRun.client && (
                    <Card variant="surface" mt="2">
                      <Text weight="bold">Electron client: {selectedRun.client.state}</Text>
                      <Text as="div" size="2" color="gray">
                        Provider <Code>{selectedRun.client.providerId}</Code> · request{" "}
                        <Code>{selectedRun.client.requestId}</Code>
                      </Text>
                      <Text as="div" size="2" color="gray">
                        Execution <Code>{selectedRun.client.executionDigest}</Code>
                      </Text>
                      {selectedRun.client.childRuntimeId && (
                        <Text as="div" size="2" color="gray">
                          Attested runtime <Code>{selectedRun.client.childRuntimeId}</Code>
                          {selectedRun.client.childPid
                            ? ` · child process ${selectedRun.client.childPid}`
                            : ""}
                        </Text>
                      )}
                      <Text as="div" size="1" color="gray">
                        Requested {date(selectedRun.client.requestedAt)}
                        {selectedRun.client.launchedAt
                          ? ` · launched ${date(selectedRun.client.launchedAt)}`
                          : ""}
                        {selectedRun.client.attestedAt
                          ? ` · attested ${date(selectedRun.client.attestedAt)}`
                          : ""}
                        {selectedRun.client.stoppedAt
                          ? ` · exited/stopped ${date(selectedRun.client.stoppedAt)}`
                          : ""}
                      </Text>
                      {selectedRun.client.failure && (
                        <Callout.Root color="orange" mt="2">
                          <Callout.Text>
                            {selectedRun.client.failure.code}: {selectedRun.client.failure.message}
                          </Callout.Text>
                        </Callout.Root>
                      )}
                    </Card>
                  )}
                  {selectedRun.attachedHost && (
                    <Card variant="surface" mt="2">
                      <Text weight="bold">
                        Attached host route: {selectedRun.attachedHost.state}
                      </Text>
                      <Text as="div" size="2" color="gray">
                        Session <Code>{selectedRun.attachedHost.sessionId}</Code> · child generation{" "}
                        <Code>{selectedRun.attachedHost.childGenerationId}</Code>
                      </Text>
                      <Text as="div" size="2" color="gray">
                        Authority ceiling{" "}
                        <Code>{selectedRun.attachedHost.authorityCeilingDigest}</Code>
                        {` · expires ${date(selectedRun.attachedHost.expiresAt)}`}
                      </Text>
                    </Card>
                  )}
                  {selectedRun.repair && (
                    <Callout.Root color="orange" mt="2">
                      <Callout.Text>
                        <Text weight="bold">Repair: {selectedRun.repair.phase}</Text>
                        <br />
                        {selectedRun.repair.primaryError.message}
                        <br />
                        Known effects: {knownEffects(selectedRun).join(", ")}
                        <br />
                        Execution content root: {selectedRun.snapshot.contentRoot}
                        {selectedRun.artifact && (
                          <Text as="div">
                            Retained artifact: {selectedRun.artifact.artifactDigest} · execution:{" "}
                            {selectedRun.artifact.executionDigest}
                          </Text>
                        )}
                        {selectedRun.instance && (
                          <Text as="div">
                            Instance: {selectedRun.instance.instanceId} · generation:{" "}
                            {selectedRun.instance.generationId}
                          </Text>
                        )}
                        {selectedRun.client && (
                          <Text as="div">
                            Client request: {selectedRun.client.requestId} · provider:{" "}
                            {selectedRun.client.providerId}
                          </Text>
                        )}
                        {selectedRun.attachedHost && (
                          <Text as="div">Attached route: {selectedRun.attachedHost.sessionId}</Text>
                        )}
                        {selectedRun.repair.cleanupErrors.map((diagnostic) => (
                          <Text as="div" key={`${diagnostic.code}:${diagnostic.at}`}>
                            Cleanup {diagnostic.code}: {diagnostic.message}
                          </Text>
                        ))}
                      </Callout.Text>
                    </Callout.Root>
                  )}
                  <ScrollArea
                    type="always"
                    scrollbars="vertical"
                    style={{ height: 180, marginTop: 12 }}
                  >
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                      {logs.length ? logs.join("\n") : "No persisted log lines for this run."}
                    </pre>
                  </ScrollArea>
                </>
              )}
            </Card>
          </Box>
        </Flex>

        <Card mt="3">
          <Heading size="4">Development permissions</Heading>
          <Text as="p" size="2" color="gray">
            Standing grants are canonical Permissions records. Source-only descendant edits retain
            scope; executor, recipe, lockfile, network, context, or expiry changes do not.
          </Text>
          {devGrants.length === 0 ? (
            <Text color="gray">No active standing development grant.</Text>
          ) : (
            <Flex direction="column" gap="2">
              {devGrants.map((grant) => (
                <Flex key={grant.id} justify="between" align="center" gap="2" wrap="wrap">
                  <Text>
                    <Text weight="bold">{grant.scopeLabel}</Text> · expires {date(grant.expiresAt)}
                    <Text as="div" size="1" color="gray">
                      {grant.why}
                    </Text>
                  </Text>
                  <Button
                    color="red"
                    variant="soft"
                    size="1"
                    disabled={busy !== null}
                    onClick={() =>
                      void invoke(`revoke:${grant.id}`, () =>
                        permissions.revoke({ kind: grant.kind, id: grant.id })
                      )
                    }
                  >
                    Revoke
                  </Button>
                </Flex>
              ))}
            </Flex>
          )}
        </Card>
      </Box>
      <Dialog.Root open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <Dialog.Content maxWidth="480px">
          <Dialog.Title>
            {confirm?.kind === "destroy-session"
              ? "Destroy semantic child context?"
              : "Force-retire development work?"}
          </Dialog.Title>
          <Dialog.Description size="2" mb="3">
            This only attempts cleanup for effects the service can prove it owns. Any unknown
            process, root, or imported event remains visible in the repair record.
          </Dialog.Description>
          {confirmedSession?.native && (
            <Callout.Root
              color={confirmedSession.native.pendingChanges === "none" ? "blue" : "orange"}
              mb="3"
            >
              <Callout.Text>
                Native pending changes: {confirmedSession.native.pendingChanges}. Force-retire
                abandons the owned native tree; changes not present in the last explicit checkpoint
                will not enter semantic history.
              </Callout.Text>
            </Callout.Root>
          )}
          {confirmedRun && (
            <Callout.Root color="orange" mb="3">
              <Callout.Text>
                Run {confirmedRun.runId} · content root {confirmedRun.snapshot.contentRoot}
                {confirmedRun.artifact
                  ? ` · artifact ${confirmedRun.artifact.artifactDigest} · execution ${confirmedRun.artifact.executionDigest}`
                  : ""}
                {confirmedRun.instance
                  ? ` · instance ${confirmedRun.instance.instanceId}/${confirmedRun.instance.generationId}`
                  : ""}
                {confirmedRun.client ? ` · client request ${confirmedRun.client.requestId}` : ""}
                {confirmedRun.attachedHost
                  ? ` · attached route ${confirmedRun.attachedHost.sessionId}`
                  : ""}
              </Callout.Text>
            </Callout.Root>
          )}
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft">Cancel</Button>
            </Dialog.Close>
            {confirmedSession?.native?.state === "ready" &&
              confirmedSession.native.pendingChanges !== "none" && (
                <Button
                  variant="soft"
                  disabled={busy !== null}
                  onClick={() => {
                    const sessionId = confirmedSession.sessionId;
                    setConfirm(null);
                    void invoke(`checkpoint:${sessionId}`, () =>
                      development.checkpoint({
                        sessionId,
                        idempotencyKey: intentId(`checkpoint:${sessionId}`),
                      })
                    );
                  }}
                >
                  Checkpoint first
                </Button>
              )}
            <Button
              color="red"
              disabled={busy !== null}
              onClick={() => {
                const value = confirm;
                setConfirm(null);
                if (!value) return;
                const key = `${value.kind}:${value.id}`;
                const action =
                  value.kind === "destroy-session"
                    ? () =>
                        development.destroySession({
                          sessionId: value.id,
                          idempotencyKey: intentId(key),
                        })
                    : value.kind === "force-retire-session"
                      ? () =>
                          development.forceRetireSession({
                            sessionId: value.id,
                            idempotencyKey: intentId(key),
                          })
                      : () =>
                          development.forceRetire({
                            runId: value.id,
                            idempotencyKey: intentId(key),
                          });
                void invoke(key, action);
              }}
            >
              Confirm
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Theme>
  );
}
