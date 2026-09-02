/**
 * Terminal startup E2E test.
 *
 * The standalone "terminal boots without console errors" check is ported
 * in-system to @workspace/testkit
 * (workspace/packages/testkit/src/suites/terminal.ts). Here the console-error
 * diagnostics assertion is interwoven with the pty/approval startup flow
 * (shell-level approval prompts cannot run in-system), so this spec stays.
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
  callTerminalPanel,
  clickPanelSelector,
  clickPanelText,
  createManagedTestWorkspace,
  executePanelScript,
  getElectronClipboardText,
  getFocusedPanelWebContentsId,
  getPanelDiagnostics,
  getPanelHtml,
  isPanelReady,
  launchTestApp,
  reloadPanel,
  removeManagedTestWorkspace,
  setElectronClipboardText,
  startPanelDiagnostics,
  type PanelDiagnostic,
  typePanelText,
  type TestApp,
} from "../../setup/electronSetup";
import {
  pressTerminalShortcutThroughNativeInput,
  typeTerminalThroughNativeInput,
} from "../../setup/nativeInput";
import { hasOwnedX11Display } from "../../setup/ownedXvfb";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PendingApproval = {
  approvalId: string;
  kind: string;
  title?: string;
  capability?: string;
  resource?: unknown;
  allowedDecisions?: Array<
    "once" | "session" | "task" | "mission" | "agent" | "version" | "lock" | "deny"
  >;
  mode?: "install" | "update" | "adopt-root" | "part-changed";
  parts?: Array<{
    identityKey: string;
    change?: string;
    notableRows?: Array<{ key: string; selectable: boolean; selectedByDefault: boolean }>;
    everydayRows?: Array<{ key: string; selectable: boolean; selectedByDefault: boolean }>;
  }>;
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

async function getTerminalPanelId(
  app: ElectronApplication,
  window: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<string> {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await resolvePendingTerminalWork(app, window, resolvedApprovals);
      const id = await app.evaluate(() => {
        type PanelNode = {
          id: string;
          source?: string;
          snapshot?: { source?: string };
          children?: unknown[];
        };

        const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
        if (!testApi) return "";
        const panels = testApi.getPanelTree() as PanelNode[];
        const walk = (nodes: unknown[]): PanelNode[] => {
          const out: PanelNode[] = [];
          for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            const candidate = node as PanelNode;
            if (typeof candidate.id === "string") out.push(candidate);
            const children = Array.isArray(candidate.children) ? candidate.children : [];
            out.push(...walk(children));
          }
          return out;
        };
        const terminal = walk(panels).find((panel) => {
          const source = panel.snapshot?.source ?? panel.source;
          return source === "panels/terminal";
        });
        return terminal?.id ?? "";
      });
      if (id) return id;
      lastError = new Error("Terminal panel not yet discoverable");
      await delay(250);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for terminal panel");
}

async function clickLaunchApprovalButton(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    async ({ webContents }, source) => {
      const candidates = webContents
        .getAllWebContents()
        .filter((contents) => {
          if (contents.isDestroyed()) return false;
          const title = contents.getTitle();
          return title === "@workspace-apps/shell" || title === "Vibestudio Launch";
        })
        .sort((left, right) =>
          left.getTitle() === "Vibestudio Launch"
            ? -1
            : right.getTitle() === "Vibestudio Launch"
              ? 1
              : 0
        );
      for (const contents of candidates) {
        if (contents.isDestroyed()) continue;
        try {
          const clicked = await Promise.race([
            contents.executeJavaScript(
              `(() => {
                const pattern = new RegExp(${JSON.stringify(source)}, "i");
                const buttons = Array.from(document.querySelectorAll("button"));
                const button = buttons.find((item) => pattern.test((item.textContent ?? "").trim()));
                if (!button) return false;
                button.click();
                return true;
              })()`,
              true
            ),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
          ]);
          if (clicked) return true;
        } catch {
          // The shell can navigate while startup authority is being committed.
        }
      }
      return false;
    },
    /^(Trust and (start|connect)|Approve and (start|connect)|Approve all|Approve|Allow|Continue|Run)$/i
      .source
  );
}

async function resolvePendingTerminalWork(
  app: ElectronApplication,
  window?: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<void> {
  await approvePendingTerminalWork(app, window, resolvedApprovals);
  await clickLaunchApprovalButton(app).catch(() => false);
}

async function waitForTerminalPanel(
  app: ElectronApplication,
  window: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<string> {
  await resolvePendingTerminalWork(app, window, resolvedApprovals);
  const panelId = await getTerminalPanelId(app, window, resolvedApprovals);
  await expect
    .poll(
      async () => {
        await approvePendingTerminalWork(app, window, resolvedApprovals).catch(() => {});
        return isPanelReady(app, panelId).catch(() => false);
      },
      { timeout: 30_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return panelId;
}

async function listPendingApprovals(app: ElectronApplication): Promise<PendingApproval[]> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const pending = (await testApi.rpcCall("shellApproval", "listPending", [])) as Array<{
      approvalId: string;
      kind: string;
      title?: string;
      capability?: unknown;
      resource?: unknown;
      allowedDecisions?: string[];
      mode?: string;
      parts?: Array<{
        identityKey: unknown;
        change?: unknown;
        notableRows?: Array<{ key: unknown; selectable: unknown; selectedByDefault: unknown }>;
        everydayRows?: Array<{ key: unknown; selectable: unknown; selectedByDefault: unknown }>;
      }>;
      options?: Array<{
        value: unknown;
        tone?: unknown;
        label?: unknown;
      }>;
    }>;
    return pending.map((approval) => ({
      approvalId: approval.approvalId,
      kind: approval.kind,
      title: approval.title,
      capability: typeof approval.capability === "string" ? approval.capability : undefined,
      resource: approval.resource,
      allowedDecisions: Array.isArray(approval.allowedDecisions)
        ? approval.allowedDecisions.filter(
            (decision): decision is NonNullable<PendingApproval["allowedDecisions"]>[number] =>
              decision === "once" ||
              decision === "session" ||
              decision === "task" ||
              decision === "mission" ||
              decision === "agent" ||
              decision === "version" ||
              decision === "lock" ||
              decision === "deny"
          )
        : undefined,
      mode:
        approval.mode === "install" ||
        approval.mode === "update" ||
        approval.mode === "adopt-root" ||
        approval.mode === "part-changed"
          ? approval.mode
          : undefined,
      parts: Array.isArray(approval.parts)
        ? approval.parts.map((part) => ({
            identityKey: String(part.identityKey),
            change: typeof part.change === "string" ? part.change : undefined,
            notableRows: Array.isArray(part.notableRows)
              ? part.notableRows.map((row) => ({
                  key: String(row.key),
                  selectable: row.selectable === true,
                  selectedByDefault: row.selectedByDefault === true,
                }))
              : [],
            everydayRows: Array.isArray(part.everydayRows)
              ? part.everydayRows.map((row) => ({
                  key: String(row.key),
                  selectable: row.selectable === true,
                  selectedByDefault: row.selectedByDefault === true,
                }))
              : [],
          }))
        : undefined,
      options: Array.isArray(approval.options)
        ? approval.options.map((option) => ({
            value: String(option.value),
            tone: typeof option.tone === "string" ? option.tone : undefined,
            label: typeof option.label === "string" ? option.label : undefined,
          }))
        : undefined,
    }));
  });
}

async function resolveApproval(app: ElectronApplication, approval: PendingApproval): Promise<void> {
  await app.evaluate(async (_electron, pending) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    if (pending.kind === "userland") {
      const choice =
        pending.options?.find((option) => option.tone === "primary")?.value ??
        pending.options?.find((option) => option.tone !== "danger")?.value ??
        pending.options?.[0]?.value;
      if (!choice) {
        throw new Error(`Userland approval ${pending.approvalId} did not include any options`);
      }
      await testApi.rpcCall("shellApproval", "resolveUserland", [pending.approvalId, choice]);
      return;
    }
    if (pending.kind === "unit-install-review") {
      const decision =
        pending.mode === "update"
          ? "update"
          : pending.mode === "adopt-root"
            ? "adopt-root"
            : "install";
      const allowNow = (pending.parts ?? [])
        .filter((part) => part.change !== "removed")
        .map((part) => ({
          identityKey: part.identityKey,
          permissions: [...(part.notableRows ?? []), ...(part.everydayRows ?? [])]
            .filter((row) => row.selectable && row.selectedByDefault)
            .map((row) => row.key),
        }));
      await testApi.rpcCall("shellApproval", "resolveInstallReview", [
        pending.approvalId,
        { decision, allowNow },
      ]);
      return;
    }
    const decision = pending.allowedDecisions?.find((candidate) => candidate !== "deny") ?? "once";
    await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, decision]);
  }, approval);
}

async function approvePendingTerminalWork(
  app: ElectronApplication,
  window?: Page,
  resolved?: PendingApproval[]
): Promise<void> {
  const pending = await listPendingApprovals(app);
  for (const approval of pending) {
    await resolveApproval(app, approval);
    resolved?.push(approval);
  }
  if (window) {
    await window
      .getByRole("button", {
        name: /Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start|Approve all|Approve push|Approve|Dev session|Install and run|Allow|Run once|Allow for session|Use this session/i,
      })
      .click({ timeout: 250 })
      .catch(() => {});
  }
}

async function callTerminalPanelWithApprovals<T>(
  app: ElectronApplication,
  window: Page,
  panelId: string,
  method: string,
  args?: unknown
): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  void callTerminalPanel<T>(app, panelId, method, args)
    .then((result) => {
      value = result;
    })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      settled = true;
    });

  await expect
    .poll(
      async () => {
        await approvePendingTerminalWork(app, window);
        return settled;
      },
      { timeout: 30_000, intervals: [100, 250, 500, 1000] }
    )
    .toBe(true);
  if (failure !== undefined) throw failure;
  return value as T;
}

function configureTerminalOnlySource(sourceRoot: string): void {
  const configPath = path.join(sourceRoot, "meta", "template.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  config.initPanels = [{ source: "panels/terminal" }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

function createTerminalOnlyWorkspace(): Promise<string> {
  return createManagedTestWorkspace({ configureSource: configureTerminalOnlySource });
}

type TerminalSession = {
  sessionId: string;
  alive?: boolean;
  cols?: number;
  rows?: number;
  detectedPorts?: number[];
  detectedUrls?: string[];
  meta?: Record<string, unknown>;
};

type TerminalSessionRef = {
  sessionId: string;
};

async function listTerminalSessions(
  app: ElectronApplication,
  panelId: string
): Promise<TerminalSession[]> {
  return callTerminalPanel<TerminalSession[]>(app, panelId, "listSessions");
}

async function ensureUsableTerminalSessionId(
  app: ElectronApplication,
  panelId: string,
  session: string | TerminalSessionRef,
  window?: Page
): Promise<string> {
  const currentSessionId = typeof session === "string" ? session : session.sessionId;
  const sessions = await listTerminalSessions(app, panelId).catch(() => []);
  const alive = sessions.find(
    (item) => item.sessionId === currentSessionId && item.alive !== false
  );
  if (alive?.sessionId) return alive.sessionId;

  const next = await waitForUsableTerminalSession(app, panelId, window);
  if (typeof session !== "string") {
    session.sessionId = next.sessionId;
  }
  return next.sessionId;
}

async function sendTerminalText(
  app: ElectronApplication,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string,
  window?: Page
): Promise<void> {
  const sessionId = await ensureUsableTerminalSessionId(app, panelId, session, window);
  await callTerminalPanel(app, panelId, "sendText", {
    sessionId,
    text,
  });
}

async function requestTerminalSession(
  app: ElectronApplication,
  panelId: string
): Promise<string | undefined> {
  const result = await callTerminalPanel<{ sessionId?: string }>(app, panelId, "openSession");
  return result.sessionId;
}

async function terminalAuthorityRequests(
  app: ElectronApplication,
  panelId: string
): Promise<Array<{ capability: string; resource: unknown }>> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const slot = (await testApi.rpcCall("workspace-state", "slot.get", [id])) as {
      current_entity_id?: string | null;
    } | null;
    const runtimeEntityId = slot?.current_entity_id;
    if (!runtimeEntityId) throw new Error(`Terminal panel ${id} has no active runtime entity`);
    const entity = (await testApi.rpcCall("workspace-state", "entity.resolveActive", [
      runtimeEntityId,
    ])) as {
      activeAuthority?: {
        requests?: Array<{ capability: string; resource: unknown }>;
      };
    } | null;
    return entity?.activeAuthority?.requests ?? [];
  }, panelId);
}

async function terminalNativeAuthorityRequests(
  app: ElectronApplication,
  panelId: string
): Promise<Array<{ capability: string; resource: unknown }>> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          getPanelCodeIdentity: (panelId: string) => {
            requested?: Array<{ capability: string; resource: unknown }>;
          } | null;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.getPanelCodeIdentity(id)?.requested ?? [];
  }, panelId);
}

async function waitForUsableTerminalSession(
  app: ElectronApplication,
  panelId: string,
  window?: Page
): Promise<TerminalSession> {
  const startedAt = Date.now();
  let lastOpenRequestAt = 0;
  let lastOpenErrorMessage = "";
  let lastPanelText = "";
  let lastPanelHtml = "";
  try {
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, window);
          // The panel may mount before the approved shell extension's first build
          // finishes. Once approvals are resolved, drive its explicit recovery
          // action so the same panel instance reconnects instead of waiting for a
          // manual click forever.
          await clickPanelText(app, panelId, "button", "Retry").catch(() => false);
          let sessions = await listTerminalSessions(app, panelId).catch(() => []);
          const alive = sessions.find((session) => session.alive !== false)?.sessionId;
          if (alive) return alive;

          const now = Date.now();
          if (now - startedAt > 5_000 && now - lastOpenRequestAt > 5_000) {
            lastOpenRequestAt = now;
            let openError: unknown;
            const opened = await requestTerminalSession(app, panelId).catch((error: unknown) => {
              openError = error;
              return undefined;
            });
            await approvePendingTerminalWork(app, window);
            if (opened) return opened;
            const openErrorMessage = openError instanceof Error ? openError.message : "";
            const panelHtml = await getPanelHtml(app, panelId).catch(() => "");
            lastOpenErrorMessage = openErrorMessage;
            lastPanelHtml = panelHtml;
            lastPanelText = await app
              .evaluate(async (_electron, id) => {
                const testApi = (
                  globalThis as {
                    __testApi?: { getPanelText: (panelId: string) => Promise<string> };
                  }
                ).__testApi;
                return testApi ? await testApi.getPanelText(id) : "";
              }, panelId)
              .catch(() => "");
            if (
              openErrorMessage.includes("did not request") ||
              panelHtml.includes("did not request")
            ) {
              const nativeRequests = await terminalNativeAuthorityRequests(app, panelId);
              throw new Error(
                `Terminal authority failed with native requests ${JSON.stringify(nativeRequests)}: ${
                  openErrorMessage || panelHtml
                }`
              );
            }
            sessions = await listTerminalSessions(app, panelId).catch(() => []);
          }
          return sessions.find((session) => session.alive !== false)?.sessionId ?? "";
        },
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .not.toBe("");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Terminal startup snapshot: openError=${JSON.stringify(lastOpenErrorMessage)}\n` +
        `panelText=${JSON.stringify(lastPanelText.slice(0, 2000))}\n` +
        `panelHtml=${JSON.stringify(lastPanelHtml.slice(0, 4000))}`
    );
  }

  const sessions = await listTerminalSessions(app, panelId);
  const session = sessions.find((item) => item.alive !== false);
  if (!session) throw new Error("No usable terminal session");
  return session;
}

async function waitForAutomaticallyResumedTerminalSession(
  app: ElectronApplication,
  panelId: string,
  window: Page,
  resolvedApprovals: PendingApproval[]
): Promise<TerminalSession> {
  let lastPanelText = "";
  let lastPanelHtml = "";
  try {
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, window, resolvedApprovals);
          const sessions = await listTerminalSessions(app, panelId).catch(() => []);
          const alive = sessions.find((session) => session.alive !== false);
          if (alive) return alive.sessionId;
          lastPanelHtml = await getPanelHtml(app, panelId).catch(() => "");
          lastPanelText = await app
            .evaluate(async (_electron, id) => {
              const testApi = (
                globalThis as {
                  __testApi?: { getPanelText: (panelId: string) => Promise<string> };
                }
              ).__testApi;
              return testApi ? await testApi.getPanelText(id) : "";
            }, panelId)
            .catch(() => "");
          return "";
        },
        { timeout: 120_000, intervals: [250, 500, 1000, 2000] }
      )
      .not.toBe("");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "The initial terminal invocation did not resume after its approval. " +
        "This assertion intentionally does not click Retry or issue another openSession call.\n" +
        `resolvedApprovals=${JSON.stringify(
          resolvedApprovals.map(({ approvalId, kind, capability, title }) => ({
            approvalId,
            kind,
            capability,
            title,
          }))
        )}\n` +
        `panelText=${JSON.stringify(lastPanelText.slice(0, 2000))}\n` +
        `panelHtml=${JSON.stringify(lastPanelHtml.slice(0, 4000))}`
    );
  }

  const sessions = await listTerminalSessions(app, panelId);
  const session = sessions.find((item) => item.alive !== false);
  if (!session) throw new Error("No automatically resumed terminal session");
  return session;
}

function severePanelDiagnostics(items: PanelDiagnostic[]): PanelDiagnostic[] {
  return items.filter((item) => {
    if (item.type === "render-process-gone" || item.type === "unresponsive") return true;
    if (item.type === "did-fail-load") return !item.message.includes("(-3)");
    if (item.type !== "console") return false;
    const level = String(item.level ?? "").toLowerCase();
    return (
      level === "2" ||
      level === "3" ||
      level === "error" ||
      /\b(uncaught|typeerror|referenceerror|renderservice|onrequestredraw)\b/i.test(item.message)
    );
  });
}

async function expectScrollbackToContain(
  app: ElectronApplication,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const sessionId = await ensureUsableTerminalSessionId(app, panelId, session);
        let activeSessionId = sessionId;
        let scrollback: { text: string } | null = null;
        try {
          scrollback = await callTerminalPanel<{ text: string }>(app, panelId, "getScrollback", {
            sessionId: activeSessionId,
            maxBytes: 1024 * 1024,
          });
        } catch (error) {
          const message = String((error as Error | undefined)?.message ?? error);
          if (/unknown session/i.test(message)) {
            const refreshed = await ensureUsableTerminalSessionId(app, panelId, session);
            if (refreshed !== activeSessionId) {
              activeSessionId = refreshed;
              const reloaded = await callTerminalPanel<{ text: string }>(
                app,
                panelId,
                "getScrollback",
                { sessionId: activeSessionId, maxBytes: 1024 * 1024 }
              );
              scrollback = reloaded;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
        return scrollback.text;
      },
      {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      }
    )
    .toContain(text);
}

async function scrollbackContains(
  app: ElectronApplication,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string
): Promise<boolean> {
  const sessionId = await ensureUsableTerminalSessionId(app, panelId, session);
  let activeSessionId = sessionId;
  let scrollback: { text: string };
  try {
    scrollback = await callTerminalPanel<{ text: string }>(app, panelId, "getScrollback", {
      sessionId: activeSessionId,
      maxBytes: 1024 * 1024,
    });
  } catch (error) {
    const message = String((error as Error | undefined)?.message ?? error);
    if (!/unknown session/i.test(message)) throw error;
    const refreshed = await ensureUsableTerminalSessionId(app, panelId, session);
    if (refreshed === activeSessionId) throw error;
    activeSessionId = refreshed;
    scrollback = await callTerminalPanel<{ text: string }>(app, panelId, "getScrollback", {
      sessionId: activeSessionId,
      maxBytes: 1024 * 1024,
    });
  }
  return scrollback.text.includes(text);
}

async function expectRenderedToContain(
  app: ElectronApplication,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const sessionId = await ensureUsableTerminalSessionId(app, panelId, session);
          return callTerminalPanel<string>(app, panelId, "getRenderedText", {
            sessionId,
          });
        } catch (error) {
          const message = String((error as Error | undefined)?.message ?? error);
          if (!/unknown session/i.test(message)) throw error;
          const refreshed = await ensureUsableTerminalSessionId(app, panelId, session);
          return callTerminalPanel<string>(app, panelId, "getRenderedText", {
            sessionId: refreshed,
          });
        }
      },
      {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      }
    )
    .toContain(text);
}

async function clickTerminalThroughWindow(testApp: TestApp, panelId: string): Promise<void> {
  expect(await clickPanelSelector(testApp.app, panelId, ".xterm")).toBe(true);
  await expect
    .poll(async () => getFocusedPanelWebContentsId(testApp.app), {
      timeout: 5_000,
      intervals: [100, 250, 500],
    })
    .toBe(panelId);
}

async function panelTreeTitle(app: ElectronApplication, panelId: string): Promise<string | null> {
  return app.evaluate((_electron, id) => {
    type PanelNode = { id: string; title?: string; children?: PanelNode[] };
    const tree = (
      globalThis as { __testApi?: { getPanelTree: () => PanelNode[] } }
    ).__testApi?.getPanelTree();
    const visit = (nodes: PanelNode[]): string | null => {
      for (const node of nodes) {
        if (node.id === id) return node.title ?? null;
        const nested = visit(node.children ?? []);
        if (nested !== null) return nested;
      }
      return null;
    };
    return visit(tree ?? []);
  }, panelId);
}

function shortcut(key: string): string {
  return process.platform === "darwin" ? `Meta+${key}` : `Control+Shift+${key}`;
}

test.describe("Terminal Startup", () => {
  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    if (testApp) await testApp.cleanup();
    else if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("opens one usable terminal after required approvals are resolved", async () => {
    test.setTimeout(240_000);
    workspacePath = await createTerminalOnlyWorkspace();
    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 90_000 });
    const { app } = testApp;
    const resolvedApprovals: PendingApproval[] = [];
    let terminalPanelId = await waitForTerminalPanel(app, testApp.window, resolvedApprovals);
    await startPanelDiagnostics(app, terminalPanelId);
    expect(await terminalAuthorityRequests(app, terminalPanelId)).toContainEqual(
      expect.objectContaining({
        capability: "userland:extensions/shell/native.shell.execute#*",
        resource: {
          kind: "exact",
          key: "native.shell:extension:@workspace-extensions/shell",
        },
      })
    );
    await expect
      .poll(async () => terminalNativeAuthorityRequests(app, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toContainEqual(
        expect.objectContaining({
          capability: "userland:extensions/shell/native.shell.execute#*",
          resource: {
            kind: "exact",
            key: "native.shell:extension:@workspace-extensions/shell",
          },
        })
      );

    const session = await waitForAutomaticallyResumedTerminalSession(
      app,
      terminalPanelId,
      testApp.window,
      resolvedApprovals
    );
    expect(
      resolvedApprovals.some(
        (approval) =>
          approval.kind === "capability" &&
          approval.capability?.includes("native.shell.execute") === true
      ),
      `Expected terminal startup to exercise its native-shell approval, observed ${JSON.stringify(
        resolvedApprovals.map(({ kind, capability, title }) => ({ kind, capability, title }))
      )}`
    ).toBe(true);
    const sessionRef: TerminalSessionRef = { sessionId: session.sessionId };

    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toMatch(/aria-label="Terminal input"/);

    await sendTerminalText(
      app,
      terminalPanelId,
      sessionRef,
      "echo vibestudio-e2e-input\r",
      testApp.window
    );
    await expectScrollbackToContain(app, terminalPanelId, sessionRef, "vibestudio-e2e-input");

    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toContain("xterm");

    const initialChrome = await executePanelScript<{
      title: string;
      sessionLabel: string | undefined;
      settingsInHeader: boolean;
      horizontalOverflow: number;
    }>(
      app,
      terminalPanelId,
      `(() => {
        const viewport = document.querySelector('.xterm-viewport');
        const settings = document.querySelector('[aria-label="Terminal settings"]');
        const label = document.querySelector('.terminal-pane-header__identity');
        return {
          title: document.title,
          sessionLabel: label?.textContent?.trim() || undefined,
          settingsInHeader: Boolean(settings?.closest('.terminal-pane-header')),
          horizontalOverflow: viewport
            ? Math.max(0, viewport.scrollWidth - viewport.clientWidth)
            : Number.POSITIVE_INFINITY,
        };
      })()`
    );
    expect(initialChrome).toMatchObject({
      title: "Terminal",
      settingsInHeader: true,
      horizontalOverflow: 0,
    });
    expect(initialChrome.sessionLabel).not.toContain("shellIntegration-bash.sh");

    expect(await clickPanelSelector(app, terminalPanelId, '[aria-label="Terminal settings"]')).toBe(
      true
    );
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            app,
            terminalPanelId,
            `Boolean(document.querySelector('[aria-label="Panel name"]'))`
          ),
        { timeout: 5_000, intervals: [100, 250, 500] }
      )
      .toBe(true);
    await executePanelScript(
      app,
      terminalPanelId,
      `(() => {
        const input = document.querySelector('[aria-label="Panel name"]');
        if (!(input instanceof HTMLInputElement)) throw new Error('Panel name input not found');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'Project terminal');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
    await expect
      .poll(() => executePanelScript<string>(app, terminalPanelId, "document.title"), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");
    expect(await clickPanelSelector(app, terminalPanelId, '[aria-label="Terminal settings"]')).toBe(
      true
    );
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            app,
            terminalPanelId,
            `!document.querySelector('[aria-label="Panel name"]') &&
              document.activeElement?.getAttribute('aria-label') !== 'Panel name'`
          ),
        { timeout: 5_000, intervals: [100, 250, 500] }
      )
      .toBe(true);
    await expect
      .poll(() => panelTreeTitle(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");

    await executePanelScript(
      app,
      terminalPanelId,
      `(() => {
        const samples = [document.documentElement.clientWidth];
        const observer = new ResizeObserver(() => samples.push(document.documentElement.clientWidth));
        observer.observe(document.documentElement);
        window.__terminalPanelWidthProbe = { samples, observer };
      })()`
    );
    expect(await clickPanelSelector(app, terminalPanelId, ".xterm")).toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(app), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await delay(500);
    const clickWidths = await executePanelScript<number[]>(
      app,
      terminalPanelId,
      `(() => {
        const probe = window.__terminalPanelWidthProbe;
        probe?.observer?.disconnect();
        return probe?.samples ?? [];
      })()`
    );
    expect(new Set(clickWidths).size).toBe(1);
    await typePanelText(app, terminalPanelId, "\u0015printf 'vibestudio-keyboard-input\\n'\r");
    await expectScrollbackToContain(app, terminalPanelId, sessionRef, "vibestudio-keyboard-input");
    await expectRenderedToContain(app, terminalPanelId, sessionRef, "vibestudio-keyboard-input");

    if (hasOwnedX11Display()) {
      await typeTerminalThroughNativeInput(
        app,
        terminalPanelId,
        "printf 'vibestudio-os-keyboard-input\\n'"
      );
    } else {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(app, terminalPanelId, "\u0015printf 'vibestudio-os-keyboard-input\\n'\r");
    }
    await expectScrollbackToContain(
      app,
      terminalPanelId,
      sessionRef,
      "vibestudio-os-keyboard-input"
    );
    await expectRenderedToContain(app, terminalPanelId, sessionRef, "vibestudio-os-keyboard-input");

    await setElectronClipboardText(app, "printf 'vibestudio-paste-input\\n'\n");
    if (hasOwnedX11Display()) {
      await pressTerminalShortcutThroughNativeInput(app, terminalPanelId, "v");
    } else {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(app, terminalPanelId, "\u0015printf 'vibestudio-paste-input\\n'\r");
    }
    await expectScrollbackToContain(app, terminalPanelId, sessionRef, "vibestudio-paste-input");
    await expectRenderedToContain(app, terminalPanelId, sessionRef, "vibestudio-paste-input");
    await expect
      .poll(() => executePanelScript<string>(app, terminalPanelId, "document.title"), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");
    await expect
      .poll(() => panelTreeTitle(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");

    await clickPanelSelector(app, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Copy all");
    await setElectronClipboardText(app, "vibestudio-copy-sentinel");
    expect(await clickPanelText(app, terminalPanelId, "[role='menuitem']", "Copy all")).toBe(true);
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, testApp.window);
          return getElectronClipboardText(app);
        },
        {
          timeout: 5_000,
          intervals: [100, 250, 500],
        }
      )
      .toContain("vibestudio-paste-input");

    await clickPanelSelector(app, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Find");
    expect(await clickPanelText(app, terminalPanelId, "[role='menuitem']", "Find")).toBe(true);
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain('placeholder="Find"');
    expect(await clickPanelSelector(app, terminalPanelId, "input[placeholder='Find']")).toBe(true);
    await executePanelScript(
      app,
      terminalPanelId,
      `(() => {
        const input = document.querySelector("input[placeholder='Find']");
        if (!(input instanceof HTMLInputElement)) throw new Error("Find input not found");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "vibestudio-paste-input");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`
    );
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toMatch(/[1-9]\d* of \d+/);
    await clickPanelSelector(app, terminalPanelId, "[aria-label='Close find']");

    const split = await callTerminalPanelWithApprovals<{ sessionId: string | undefined }>(
      app,
      testApp.window,
      terminalPanelId,
      "splitPane",
      { direction: "right" }
    );
    expect(split.sessionId).toBeTruthy();
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: split.sessionId,
      text: "printf 'vibestudio-split-input\\n'\r",
    });
    await expectScrollbackToContain(
      app,
      terminalPanelId,
      split.sessionId!,
      "vibestudio-split-input"
    );
    await expectRenderedToContain(app, terminalPanelId, split.sessionId!, "vibestudio-split-input");

    const tab = await callTerminalPanelWithApprovals<{ sessionId: string | undefined }>(
      app,
      testApp.window,
      terminalPanelId,
      "openSession",
      {}
    );
    expect(tab.sessionId).toBeTruthy();
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: tab.sessionId,
      text: "printf 'vibestudio-tab-input\\n'\r",
    });
    await expectScrollbackToContain(app, terminalPanelId, tab.sessionId!, "vibestudio-tab-input");

    const focusSessionId = await ensureUsableTerminalSessionId(
      app,
      terminalPanelId,
      sessionRef,
      testApp.window
    );
    sessionRef.sessionId = focusSessionId;
    await callTerminalPanel(app, terminalPanelId, "focusSession", { sessionId: focusSessionId });
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: focusSessionId,
      text: "printf 'http://localhost:43210\\n'\r",
    });
    await expect
      .poll(
        async () => {
          const sessions = await listTerminalSessions(app, terminalPanelId);
          const current = sessions.find((item) => item.sessionId === sessionRef.sessionId);
          return {
            ports: current?.detectedPorts ?? [],
            urls: current?.detectedUrls ?? [],
          };
        },
        {
          timeout: 10_000,
          intervals: [250, 500, 1000],
        }
      )
      .toMatchObject({
        ports: expect.arrayContaining([43210]),
        urls: expect.arrayContaining(["http://localhost:43210"]),
      });

    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: sessionRef.sessionId,
      text: "printf '\\033]633;E;vibestudio-shell-integration\\007\\033]633;C\\007\\033]633;D;0\\007'\r",
    });
    await expect
      .poll(
        async () => {
          const sessions = await listTerminalSessions(app, terminalPanelId);
          return sessions.find((item) => item.sessionId === sessionRef.sessionId)?.meta?.[
            "vscodeShellIntegration"
          ];
        },
        {
          timeout: 10_000,
          intervals: [250, 500, 1000],
        }
      )
      .toMatchObject({
        status: "vscode",
        commandLine: "vibestudio-shell-integration",
        commandRunning: false,
        lastExitCode: 0,
      });

    const beforeResize = (await listTerminalSessions(app, terminalPanelId)).find(
      (item) => item.sessionId === sessionRef.sessionId
    );
    await testApp.app.evaluate(({ BaseWindow, BrowserWindow }) => {
      const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
      const bounds = win?.getBounds();
      if (win && bounds)
        win.setBounds({ ...bounds, width: bounds.width + 180, height: bounds.height + 120 });
    });
    await expect
      .poll(
        async () => {
          const sessions = await listTerminalSessions(app, terminalPanelId);
          const current = sessions.find((item) => item.sessionId === sessionRef.sessionId);
          return `${current?.cols ?? 0}x${current?.rows ?? 0}`;
        },
        {
          timeout: 10_000,
          intervals: [250, 500, 1000],
        }
      )
      .not.toBe(`${beforeResize?.cols ?? 0}x${beforeResize?.rows ?? 0}`);

    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, testApp.window);
          const stateArgs = await app.evaluate(async (_electron, panelId) => {
            const testApi = (
              globalThis as {
                __testApi?: {
                  rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
                };
              }
            ).__testApi;
            if (!testApi) throw new Error("Test API not available");
            const detail = (await testApi.rpcCall("workspace-state", "panelTree.detail", [
              panelId,
            ])) as { currentHistory?: { state_args?: string | null } } | null;
            return detail?.currentHistory?.state_args ?? null;
          }, terminalPanelId);
          if (!stateArgs) return { leaves: 0, focusedSessionId: null };
          const state = JSON.parse(stateArgs) as {
            tree?: { kind: string; sessionId?: string; a?: unknown; b?: unknown };
            focusedSessionId?: string;
          };
          const countLeaves = (node: typeof state.tree): number => {
            if (!node) return 0;
            if (node.kind === "leaf") return 1;
            return (
              countLeaves(node.a as typeof state.tree) + countLeaves(node.b as typeof state.tree)
            );
          };
          return {
            leaves: countLeaves(state.tree),
            focusedSessionId: state.focusedSessionId ?? null,
          };
        },
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toEqual({ leaves: 3, focusedSessionId: sessionRef.sessionId });

    const preReloadPanelId = terminalPanelId;
    await reloadPanel(app, preReloadPanelId);
    terminalPanelId = await waitForTerminalPanel(app, testApp.window);
    if (terminalPanelId !== preReloadPanelId) {
      await startPanelDiagnostics(app, terminalPanelId);
    }
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, testApp.window).catch(() => {});
          return getPanelHtml(app, terminalPanelId).catch(() => "");
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toContain("xterm");

    const reloadedSessionId = await ensureUsableTerminalSessionId(
      app,
      terminalPanelId,
      sessionRef,
      testApp.window
    );
    await callTerminalPanel(app, terminalPanelId, "focusSession", {
      sessionId: reloadedSessionId,
    }).catch(() => undefined);
    await expect
      .poll(
        async () =>
          (await clickPanelSelector(app, terminalPanelId, '[data-focused="true"] .xterm').catch(
            () => false
          )) ||
          (await clickPanelSelector(
            app,
            terminalPanelId,
            '[data-focused="true"] .xterm-helper-textarea'
          ).catch(() => false)),
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(app), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await typePanelText(
      app,
      terminalPanelId,
      "\u0003\u0015printf 'vibestudio-reloaded-keyboard-input\\n'\r"
    );
    await expectScrollbackToContain(
      app,
      terminalPanelId,
      reloadedSessionId,
      "vibestudio-reloaded-keyboard-input"
    );
    await expectRenderedToContain(
      app,
      terminalPanelId,
      reloadedSessionId,
      "vibestudio-reloaded-keyboard-input"
    );

    expect(severePanelDiagnostics(await getPanelDiagnostics(app, terminalPanelId))).toEqual([]);
  });
});
