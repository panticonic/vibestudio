/**
 * Local Models panel (design docs/local-models-extension-design.md §9): the
 * "why isn't it working" destination and model manager for the local-models
 * extension. Every supervisor state has a visible, actionable representation
 * here; defaults are computed, details are expandable, and nothing requires
 * knowing what a "quant" is.
 */

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
  IconButton,
  Progress,
  ScrollArea,
  Separator,
  Spinner,
  Table,
  Text,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  DownloadIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ReloadIcon,
  RocketIcon,
  TrashIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import { useAppTheme } from "@workspace/ui/panel";
import { extensions } from "@workspace/runtime";

const EXTENSION = "@workspace-extensions/local-models";
const POLL_MS = 2500;

// ── extension wire types (structural mirrors of extension types.ts) ─────────

interface GpuInfo {
  vendor: string;
  name: string;
  vramMB: number;
  backend: string;
  discrete: boolean;
}

interface HardwareProfile {
  os: string;
  arch: string;
  gpus: GpuInfo[];
  cpu: { cores: number; features: string[] };
  ramMB: number;
  chosenBackend: string;
  chosenGpu: GpuInfo | null;
  tier: string;
  notes: string[];
}

interface EngineState {
  pin: { buildTag: string };
  cpu: { buildTag: string; backend: string } | null;
  gpu: { buildTag: string; backend: string } | null;
  degradedReason: string | null;
}

type ServerState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; loadedModels: string[]; uptimeMs: number }
  | { state: "backoff"; attempt: number; nextRetryMs: number }
  | { state: "error"; message: string; logTail: string[] };

interface DownloadJob {
  id: string;
  slug: string;
  hfRepo: string;
  file: string;
  totalBytes: number | null;
  receivedBytes: number;
  phase: "active" | "queued" | "paused";
  error: string | null;
}

interface LocalModelsStatus {
  role: "owner" | "attached";
  hardware: HardwareProfile | null;
  engine: EngineState | null;
  servers: { utility: ServerState; main: ServerState };
  fallback: { ready: boolean; warm: boolean; modelRef: string; reason: string | null };
  downloads: DownloadJob[];
  storageRoot: string;
  diskFreeBytes: number;
}

interface LocalModelEntry {
  slug: string;
  displayName: string;
  server: "utility" | "main";
  contextWindow: number;
  toolsCapable: boolean;
  fit: { fit: string; estTokensPerSec: number | null; notes: string[] };
  state: "ready" | "startable" | "downloading" | "error";
  downloadProgress: number | null;
  errorMessage: string | null;
}

interface CuratedModel {
  slug: string;
  displayName: string;
  hfRepo: string;
  quantByTier: Record<string, string>;
  toolsCapable: boolean;
  blurb: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function invoke<T>(method: string, args: unknown[] = []): Promise<T> {
  return extensions.invoke(EXTENSION, method, args) as Promise<T>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fitBadge(fit: string) {
  switch (fit) {
    case "full-gpu":
      return (
        <Badge color="green" variant="soft">
          ● full GPU
        </Badge>
      );
    case "partial-offload":
      return (
        <Badge color="amber" variant="soft">
          ◐ partial offload
        </Badge>
      );
    case "cpu-only":
      return (
        <Badge color="gray" variant="soft">
          CPU
        </Badge>
      );
    default:
      return (
        <Badge color="red" variant="soft">
          too big
        </Badge>
      );
  }
}

function serverBadge(state: ServerState) {
  switch (state.state) {
    case "running":
      return (
        <Badge color="green" variant="soft">
          <CheckCircledIcon /> running · port {state.port} · {formatUptime(state.uptimeMs)}
        </Badge>
      );
    case "starting":
      return (
        <Badge color="amber" variant="soft">
          <Spinner size="1" /> starting
        </Badge>
      );
    case "backoff":
      return (
        <Badge color="amber" variant="soft">
          <UpdateIcon /> restarting (attempt {state.attempt})
        </Badge>
      );
    case "error":
      return (
        <Tooltip content={state.message}>
          <Badge color="red" variant="soft">
            <CrossCircledIcon /> error
          </Badge>
        </Tooltip>
      );
    default:
      return (
        <Badge color="gray" variant="soft">
          stopped
        </Badge>
      );
  }
}

// ── panel ───────────────────────────────────────────────────────────────────

export default function LocalModelsPanel() {
  const theme = usePanelTheme();
  const appTheme = useAppTheme();
  const [status, setStatus] = useState<LocalModelsStatus | null>(null);
  const [models, setModels] = useState<LocalModelEntry[]>([]);
  const [catalog, setCatalog] = useState<CuratedModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LocalModelEntry | null>(null);
  const [importPath, setImportPath] = useState("");
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logKind, setLogKind] = useState<"utility" | "main">("utility");
  const pollRef = useRef<number>(0);

  // Deep-link target (design §6, item 6): the model picker's red error dot
  // opens this panel with `{ openLog: "utility" | "main" }` so the user lands
  // directly on the failing server's log instead of hunting for it.
  const stateArgs = useStateArgs<{ openLog?: "utility" | "main" }>();
  const openLogHandledRef = useRef(false);
  useEffect(() => {
    const kind = stateArgs.openLog;
    if (!kind || openLogHandledRef.current) return;
    openLogHandledRef.current = true;
    setLogKind(kind);
    setLogError(null);
    setLogLines([]);
    void invoke<string[]>("tailServerLogLines", [kind, 200])
      .then((lines) => setLogLines(lines))
      .catch((err) => setLogError(err instanceof Error ? err.message : String(err)));
  }, [stateArgs.openLog]);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextModels] = await Promise.all([
        invoke<LocalModelsStatus>("status"),
        invoke<LocalModelEntry[]>("listModels"),
      ]);
      setStatus(nextStatus);
      setModels(nextModels);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await invoke<CuratedModel[]>("searchCatalog"));
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadCatalog();
    pollRef.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(pollRef.current);
  }, [refresh, loadCatalog]);

  const act = useCallback(
    async (label: string, run: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await run();
        await refresh();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const installedSlugs = useMemo(() => new Set(models.map((m) => m.slug)), [models]);
  const hardware = status?.hardware ?? null;
  const engine = status?.engine ?? null;
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    const notInstalled = catalog.filter((c) => !installedSlugs.has(c.slug));
    if (!q) return notInstalled;
    return notInstalled.filter(
      (c) => c.displayName.toLowerCase().includes(q) || c.hfRepo.toLowerCase().includes(q)
    );
  }, [catalog, installedSlugs, query]);

  return (
    <Theme appearance={theme} {...appTheme}>
      <ScrollArea type="auto" scrollbars="vertical" style={{ height: "100vh" }}>
        <Flex direction="column" gap="4" p="4" style={{ maxWidth: 860, margin: "0 auto" }}>
          {/* ── hardware header ─────────────────────────────────────────── */}
          <Card size="2">
            <Flex justify="between" align="start" gap="3" wrap="wrap">
              <Box>
                <Heading size="4">Local models</Heading>
                {hardware ? (
                  <Text size="2" color="gray" as="p" mt="1">
                    Optimized for{" "}
                    <Text weight="medium" color="gray">
                      {hardware.chosenGpu
                        ? `${hardware.chosenGpu.name} (${Math.round(hardware.chosenGpu.vramMB / 1024)} GB VRAM)`
                        : `${hardware.cpu.cores}-core CPU`}
                    </Text>
                    {" · "}
                    {hardware.chosenBackend}
                    {" · "}
                    {Math.round(hardware.ramMB / 1024)} GB RAM
                    {engine ? ` · llama.cpp ${engine.pin.buildTag}` : ""}
                  </Text>
                ) : error ? (
                  <Flex direction="column" align="start" gap="2" mt="1">
                    <Text size="2" color="red">
                      Can't reach the local-models extension.
                    </Text>
                    <Text size="1" color="gray">
                      Check that the extension is installed and enabled, then retry.
                    </Text>
                    <Button size="1" variant="soft" color="red" onClick={() => void refresh()}>
                      <ReloadIcon /> Retry
                    </Button>
                  </Flex>
                ) : (
                  <Flex align="center" gap="2" mt="1">
                    <Spinner size="1" />
                    <Text size="2" color="gray">
                      Detecting hardware…
                    </Text>
                  </Flex>
                )}
                {engine?.degradedReason && (
                  <Callout.Root color="amber" size="1" mt="2">
                    <Callout.Icon>
                      <ExclamationTriangleIcon />
                    </Callout.Icon>
                    <Callout.Text>GPU backend degraded: {engine.degradedReason}</Callout.Text>
                  </Callout.Root>
                )}
              </Box>
              <Flex gap="2" align="center">
                {status && (
                  <Badge color={status.role === "owner" ? "blue" : "gray"} variant="soft">
                    {status.role}
                  </Badge>
                )}
                <Button
                  size="1"
                  variant="soft"
                  disabled={busy !== null}
                  onClick={() => act("re-detect", () => invoke("getHardwareProfile", [true]))}
                >
                  <ReloadIcon /> Re-detect
                </Button>
              </Flex>
            </Flex>
          </Card>

          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Icon>
                <CrossCircledIcon />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          {/* ── fallback card ───────────────────────────────────────────── */}
          {/* Lazy floor (design §5): the fallback is loaded on demand, never
              kept warm. The card reflects three states — warm (serving now),
              ready (downloaded, loads instantly on first use), and cold
              (installs on first use). */}
          <Card size="2">
            <Flex justify="between" align="center" gap="3" wrap="wrap">
              <Flex align="center" gap="3">
                {status?.fallback.warm ? (
                  <CheckCircledIcon color="var(--green-9)" width={22} height={22} />
                ) : status?.fallback.ready ? (
                  <CheckCircledIcon color="var(--gray-8)" width={22} height={22} />
                ) : (
                  <DownloadIcon color="var(--gray-8)" width={22} height={22} />
                )}
                <Box>
                  <Text size="2" weight="medium" as="p">
                    {status?.fallback.warm
                      ? "Fallback model — loaded"
                      : status?.fallback.ready
                        ? "Fallback model — ready on demand"
                        : "Fallback model — installs on demand"}
                  </Text>
                  <Text size="1" color="gray" as="p">
                    {status?.fallback.modelRef ?? "local:lfm2.5-1.2b"}
                    {status?.fallback.warm
                      ? " · serving now · answers with zero cloud providers"
                      : status?.fallback.ready
                        ? " · CPU · loads on first use, no cloud needed"
                        : ` · ${status?.fallback.reason ?? "downloads on first use"}`}
                  </Text>
                </Box>
              </Flex>
              <Flex gap="2" align="center">
                {status && serverBadge(status.servers.utility)}
              </Flex>
            </Flex>
          </Card>

          {/* ── downloads in flight ─────────────────────────────────────── */}
          {status && status.downloads.length > 0 && (
            <Card size="2">
              <Heading size="2" mb="2">
                Downloads
              </Heading>
              <Flex direction="column" gap="2">
                {status.downloads.map((job) => {
                  const progress = job.totalBytes ? (job.receivedBytes / job.totalBytes) * 100 : 0;
                  return (
                    <Flex key={job.id} align="center" gap="3">
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Flex justify="between" gap="2">
                          <Text size="1" truncate>
                            {job.slug}
                            {job.phase !== "active" ? ` · ${job.phase}` : ""}
                          </Text>
                          <Text size="1" color="gray">
                            {formatBytes(job.receivedBytes)}
                            {job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}
                          </Text>
                        </Flex>
                        <Progress value={progress} size="1" mt="1" />
                        {job.error && (
                          <Text size="1" color="red">
                            {job.error}
                          </Text>
                        )}
                      </Box>
                      {job.phase === "active" ? (
                        <IconButton
                          size="1"
                          variant="soft"
                          onClick={() => act("pause", () => invoke("pauseDownload", [job.id]))}
                        >
                          <PauseIcon />
                        </IconButton>
                      ) : (
                        <IconButton
                          size="1"
                          variant="soft"
                          onClick={() => act("resume", () => invoke("resumeDownload", [job.id]))}
                        >
                          <PlayIcon />
                        </IconButton>
                      )}
                      <IconButton
                        size="1"
                        variant="soft"
                        color="red"
                        onClick={() => act("cancel", () => invoke("cancelDownload", [job.id]))}
                      >
                        <Cross2Icon />
                      </IconButton>
                    </Flex>
                  );
                })}
              </Flex>
            </Card>
          )}

          {/* ── model library ───────────────────────────────────────────── */}
          <Card size="2">
            <Flex justify="between" align="center" mb="2">
              <Heading size="2">Model library</Heading>
              {status && (
                <Text size="1" color="gray">
                  {status.storageRoot} · {formatBytes(status.diskFreeBytes)} free
                </Text>
              )}
            </Flex>
            {models.length === 0 ? (
              <Text size="2" color="gray">
                No models yet — the fallback model installs automatically; add more below.
              </Text>
            ) : (
              <Table.Root size="1">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Model</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Fit</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Context</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Tools</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>State</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {models.map((model) => (
                    <Table.Row key={model.slug} align="center">
                      <Table.Cell>
                        <Text size="2" weight="medium">
                          {model.displayName}
                        </Text>
                        <Text size="1" color="gray" as="p">
                          local:{model.slug}
                          {model.slug === "lfm2.5-1.2b" ? " · fallback" : ""}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>{fitBadge(model.fit.fit)}</Table.Cell>
                      <Table.Cell>
                        <Text size="1">{Math.round(model.contextWindow / 1024)}K</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="1">{model.toolsCapable ? "✓" : "—"}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        {model.state === "ready" && (
                          <Badge color="green" variant="soft">
                            loaded
                          </Badge>
                        )}
                        {model.state === "startable" && (
                          <Badge color="amber" variant="soft">
                            loads on use
                          </Badge>
                        )}
                        {model.state === "downloading" && (
                          <Badge color="blue" variant="soft">
                            downloading{" "}
                            {model.downloadProgress !== null
                              ? `${Math.round(model.downloadProgress * 100)}%`
                              : ""}
                          </Badge>
                        )}
                        {model.state === "error" && (
                          <Tooltip content={model.errorMessage ?? "error"}>
                            <Badge color="red" variant="soft">
                              error
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Flex gap="1" justify="end">
                          {model.state === "startable" && (
                            <Tooltip content="Load now">
                              <IconButton
                                size="1"
                                variant="soft"
                                disabled={busy !== null}
                                onClick={() =>
                                  act("load", () => invoke("ensureLoaded", [model.slug]))
                                }
                              >
                                <RocketIcon />
                              </IconButton>
                            </Tooltip>
                          )}
                          {model.slug !== "lfm2.5-1.2b" && (
                            <Tooltip content="Delete model">
                              <IconButton
                                size="1"
                                variant="soft"
                                color="red"
                                disabled={busy !== null}
                                onClick={() => setRemoveTarget(model)}
                              >
                                <TrashIcon />
                              </IconButton>
                            </Tooltip>
                          )}
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Card>

          {/* ── add models ──────────────────────────────────────────────── */}
          <Card size="2">
            <Heading size="2" mb="2">
              Add models
            </Heading>
            <TextField.Root
              placeholder="Search the catalog…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              mb="2"
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
            <Flex direction="column" gap="2">
              {filteredCatalog.map((entry) => {
                const quant = hardware ? entry.quantByTier[hardware.tier] : undefined;
                return (
                  <Flex key={entry.slug} justify="between" align="center" gap="3">
                    <Box style={{ minWidth: 0 }}>
                      <Text size="2" weight="medium" as="p" truncate>
                        {entry.displayName}
                        {quant ? (
                          <Text size="1" color="gray">
                            {" "}
                            · {quant} recommended for your hardware
                          </Text>
                        ) : null}
                      </Text>
                      <Text size="1" color="gray" as="p" truncate>
                        {entry.blurb}
                      </Text>
                    </Box>
                    <Tooltip
                      content={
                        quant
                          ? "Download this model"
                          : "No compatible build is available for your detected hardware tier"
                      }
                    >
                      <Button
                        size="1"
                        variant="soft"
                        disabled={busy !== null || !quant}
                        onClick={() =>
                          act("download", async () => {
                            // File naming follows the HF convention the curated
                            // catalog pins: <repo-basename>-<QUANT>.gguf.
                            const repoBase = entry.hfRepo.split("/")[1] ?? entry.slug;
                            const file = `${repoBase.replace(/-GGUF$/iu, "")}-${quant}.gguf`;
                            await invoke("startDownloadJob", [
                              {
                                hfRepo: entry.hfRepo,
                                file,
                                displayName: entry.displayName,
                                slug: entry.slug,
                              },
                            ]);
                          })
                        }
                      >
                        <DownloadIcon /> Get
                      </Button>
                    </Tooltip>
                  </Flex>
                );
              })}
              {catalogLoading ? (
                <Flex align="center" gap="2">
                  <Spinner size="1" />
                  <Text size="1" color="gray">
                    Loading catalog…
                  </Text>
                </Flex>
              ) : null}
              {catalogError ? (
                <Callout.Root color="red" size="1">
                  <Callout.Text>
                    <Flex align="center" gap="2">
                      Couldn't load the model catalog: {catalogError}
                      <Button
                        size="1"
                        variant="soft"
                        color="red"
                        onClick={() => void loadCatalog()}
                      >
                        Retry
                      </Button>
                    </Flex>
                  </Callout.Text>
                </Callout.Root>
              ) : null}
              {!catalogLoading && !catalogError && filteredCatalog.length === 0 && (
                <Text size="1" color="gray">
                  Nothing matching — every curated model for this hardware tier is installed.
                </Text>
              )}
            </Flex>
            <Separator size="4" my="3" />
            <Flex gap="2" align="center">
              <input
                type="file"
                // Chromium/Electron directory picker; the runtime import API needs the folder path.
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                aria-label="Choose a folder of GGUF files"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] as
                    | (File & { path?: string })
                    | undefined;
                  const path = file?.path;
                  if (path) setImportPath(path.replace(/[\\/][^\\/]+$/, ""));
                  else
                    setError(
                      "The selected folder path was unavailable. Enter its absolute path instead."
                    );
                }}
                style={{ maxWidth: 190 }}
              />
              <TextField.Root
                placeholder="Import a folder of GGUF files (absolute path)…"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                style={{ flex: 1 }}
              />
              <Button
                size="1"
                variant="soft"
                disabled={busy !== null || !importPath.trim()}
                onClick={() =>
                  act("import", async () => {
                    await invoke("importDir", [importPath.trim()]);
                    setImportPath("");
                  })
                }
              >
                <PlusIcon /> Import
              </Button>
            </Flex>
          </Card>

          {/* ── servers (advanced) ──────────────────────────────────────── */}
          <Card size="2">
            <Heading size="2" mb="2">
              Servers
            </Heading>
            <Flex direction="column" gap="2">
              {(["utility", "main"] as const).map((kind) => (
                <Flex key={kind} justify="between" align="center" gap="3">
                  <Box>
                    <Text size="2" weight="medium">
                      {kind === "utility" ? "Utility (fallback, CPU)" : "Main (library)"}
                    </Text>
                    <Box mt="1">
                      {status ? serverBadge(status.servers[kind]) : <Spinner size="1" />}
                    </Box>
                  </Box>
                  <Flex gap="2">
                    <Button
                      size="1"
                      variant="soft"
                      disabled={busy !== null}
                      onClick={() => act("restart", () => invoke("restartServer", [kind]))}
                    >
                      <ReloadIcon /> Restart
                    </Button>
                    <Button
                      size="1"
                      variant="ghost"
                      color="gray"
                      onClick={() =>
                        act("logs", async () => {
                          setLogKind(kind);
                          setLogError(null);
                          setLogLines([]);
                          setLogLines(await invoke<string[]>("tailServerLogLines", [kind, 200]));
                        })
                      }
                    >
                      Logs
                    </Button>
                  </Flex>
                </Flex>
              ))}
            </Flex>
          </Card>
        </Flex>
      </ScrollArea>

      {/* ── delete confirm ────────────────────────────────────────────── */}
      <Dialog.Root
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <Dialog.Content maxWidth="380px">
          <Dialog.Title>Delete {removeTarget?.displayName}?</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Frees the model's disk space. Agents configured to use it will fall back the next time
            they run.
          </Dialog.Description>
          <Flex gap="2" justify="end" mt="3">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              color="red"
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) void act("remove", () => invoke("removeModel", [target.slug]));
              }}
            >
              <TrashIcon /> Delete
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ── log viewer ────────────────────────────────────────────────── */}
      <Dialog.Root open={logLines !== null} onOpenChange={(open) => !open && setLogLines(null)}>
        <Dialog.Content maxWidth="720px">
          <Dialog.Title>{logKind === "utility" ? "Utility" : "Main"} server log</Dialog.Title>
          <ScrollArea type="auto" scrollbars="both" style={{ maxHeight: 420 }}>
            <Code size="1" style={{ whiteSpace: "pre", display: "block", padding: 8 }}>
              {logError
                ? `Couldn't read the log: ${logError}`
                : (logLines ?? []).join("\n") || "(log empty)"}
            </Code>
          </ScrollArea>
        </Dialog.Content>
      </Dialog.Root>
    </Theme>
  );
}
