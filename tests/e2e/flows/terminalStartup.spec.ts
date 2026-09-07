/**
 * Terminal startup E2E test.
 *
 * The standalone "terminal boots without console errors" check is ported
 * in-system to @workspace/testkit
 * (workspace/packages/testkit/src/suites/terminal.ts). Here the console-error
 * diagnostics assertion is interwoven with the pty/approval startup flow
 * (shell-level approval prompts cannot run in-system), so this spec stays.
 */
import { expect, test, type Page } from "@playwright/test";
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
  workspaceId: string;
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
  owner: TestApp,
  window: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<string> {
  const { app } = owner;
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await resolvePendingTerminalWork(owner, window, resolvedApprovals);
      const id = await app.evaluate(
        async (_electron, { workspaceId }) => {
          type PanelNode = {
            id: string;
            source?: string;
            snapshot?: { source?: string };
            children?: unknown[];
          };

          const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
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
        },
        { workspaceId: owner.workspaceId }
      );
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

async function clickLaunchApprovalButton(owner: TestApp): Promise<boolean> {
  const { app } = owner;
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
  owner: TestApp,
  window?: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<void> {
  await approvePendingTerminalWork(owner, window, resolvedApprovals);
  await clickLaunchApprovalButton(owner).catch(() => false);
}

async function waitForTerminalPanel(
  owner: TestApp,
  window: Page,
  resolvedApprovals?: PendingApproval[]
): Promise<string> {
  await resolvePendingTerminalWork(owner, window, resolvedApprovals);
  const panelId = await getTerminalPanelId(owner, window, resolvedApprovals);
  await expect
    .poll(
      async () => {
        await approvePendingTerminalWork(owner, window, resolvedApprovals).catch(() => {});
        return isPanelReady(owner, panelId).catch(() => false);
      },
      { timeout: 30_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return panelId;
}

async function listPendingApprovals(owner: TestApp): Promise<PendingApproval[]> {
  const { app } = owner;
  const queues = await Promise.all(
    [...new Set([owner.systemWorkspaceId, owner.workspaceId])].map((workspaceId) =>
      app.evaluate(
        async (_electron, { workspaceId }) => {
          const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
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
              notableRows?: Array<{
                key: unknown;
                selectable: unknown;
                selectedByDefault: unknown;
              }>;
              everydayRows?: Array<{
                key: unknown;
                selectable: unknown;
                selectedByDefault: unknown;
              }>;
            }>;
            options?: Array<{
              value: unknown;
              tone?: unknown;
              label?: unknown;
            }>;
          }>;
          return pending.map(
            (approval): PendingApproval => ({
              workspaceId,
              approvalId: approval.approvalId,
              kind: approval.kind,
              title: approval.title,
              capability: typeof approval.capability === "string" ? approval.capability : undefined,
              resource: approval.resource,
              allowedDecisions: Array.isArray(approval.allowedDecisions)
                ? approval.allowedDecisions.filter(
                    (
                      decision
                    ): decision is NonNullable<PendingApproval["allowedDecisions"]>[number] =>
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
            })
          );
        },
        { workspaceId }
      )
    )
  );
  return queues.flat();
}

async function resolveApproval(owner: TestApp, approval: PendingApproval): Promise<void> {
  const { app } = owner;
  await app.evaluate(
    async (_electron, { workspaceId, payload: pending }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
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
      const decision =
        pending.allowedDecisions?.find((candidate) => candidate !== "deny") ?? "once";
      await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, decision]);
    },
    { workspaceId: approval.workspaceId, payload: approval }
  );
}

async function approvePendingTerminalWork(
  owner: TestApp,
  window?: Page,
  resolved?: PendingApproval[]
): Promise<void> {
  const pending = await listPendingApprovals(owner);
  for (const approval of pending) {
    await resolveApproval(owner, approval);
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
  owner: TestApp,
  window: Page,
  panelId: string,
  method: string,
  args?: unknown
): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  void callTerminalPanel<T>(owner, panelId, method, args)
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
        await approvePendingTerminalWork(owner, window);
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
  config["initPanels"] = [{ source: "panels/terminal" }];
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

async function listTerminalSessions(owner: TestApp, panelId: string): Promise<TerminalSession[]> {
  return callTerminalPanel<TerminalSession[]>(owner, panelId, "listSessions");
}

async function ensureUsableTerminalSessionId(
  owner: TestApp,
  panelId: string,
  session: string | TerminalSessionRef,
  window?: Page
): Promise<string> {
  const currentSessionId = typeof session === "string" ? session : session.sessionId;
  const sessions = await listTerminalSessions(owner, panelId).catch(() => []);
  const alive = sessions.find(
    (item) => item.sessionId === currentSessionId && item.alive !== false
  );
  if (alive?.sessionId) return alive.sessionId;

  const next = await waitForUsableTerminalSession(owner, panelId, window);
  if (typeof session !== "string") {
    session.sessionId = next.sessionId;
  }
  return next.sessionId;
}

async function sendTerminalText(
  owner: TestApp,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string,
  window?: Page
): Promise<void> {
  const sessionId = await ensureUsableTerminalSessionId(owner, panelId, session, window);
  await callTerminalPanel(owner, panelId, "sendText", {
    sessionId,
    text,
  });
}

async function requestTerminalSession(
  owner: TestApp,
  panelId: string
): Promise<string | undefined> {
  const result = await callTerminalPanel<{ sessionId?: string }>(owner, panelId, "openSession");
  return result.sessionId;
}

async function terminalAuthorityRequests(
  owner: TestApp,
  panelId: string
): Promise<Array<{ capability: string; resource: unknown }>> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId, payload: id }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
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
    },
    { workspaceId: owner.workspaceId, payload: panelId }
  );
}

async function terminalNativeAuthorityRequests(
  owner: TestApp,
  panelId: string
): Promise<Array<{ capability: string; resource: unknown }>> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId, payload: id }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      return [...(testApi.getPanelCodeIdentity(id)?.requested ?? [])];
    },
    { workspaceId: owner.workspaceId, payload: panelId }
  );
}

async function waitForUsableTerminalSession(
  owner: TestApp,
  panelId: string,
  window?: Page
): Promise<TerminalSession> {
  const { app } = owner;
  const startedAt = Date.now();
  let lastOpenRequestAt = 0;
  let lastOpenErrorMessage = "";
  let lastPanelText = "";
  let lastPanelHtml = "";
  try {
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(owner, window);
          // The panel may mount before the approved shell extension's first build
          // finishes. Once approvals are resolved, drive its explicit recovery
          // action so the same panel instance reconnects instead of waiting for a
          // manual click forever.
          await clickPanelText(owner, panelId, "button", "Retry").catch(() => false);
          let sessions = await listTerminalSessions(owner, panelId).catch(() => []);
          const alive = sessions.find((session) => session.alive !== false)?.sessionId;
          if (alive) return alive;

          const now = Date.now();
          if (now - startedAt > 5_000 && now - lastOpenRequestAt > 5_000) {
            lastOpenRequestAt = now;
            let openError: unknown;
            const opened = await requestTerminalSession(owner, panelId).catch((error: unknown) => {
              openError = error;
              return undefined;
            });
            await approvePendingTerminalWork(owner, window);
            if (opened) return opened;
            const openErrorMessage = openError instanceof Error ? openError.message : "";
            const panelHtml = await getPanelHtml(owner, panelId).catch(() => "");
            lastOpenErrorMessage = openErrorMessage;
            lastPanelHtml = panelHtml;
            lastPanelText = await app
              .evaluate(
                async (_electron, { workspaceId, payload: id }) => {
                  const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
                  return testApi ? await testApi.getPanelText(id) : "";
                },
                { workspaceId: owner.workspaceId, payload: panelId }
              )
              .catch(() => "");
            if (
              openErrorMessage.includes("did not request") ||
              panelHtml.includes("did not request")
            ) {
              const nativeRequests = await terminalNativeAuthorityRequests(owner, panelId);
              throw new Error(
                `Terminal authority failed with native requests ${JSON.stringify(nativeRequests)}: ${
                  openErrorMessage || panelHtml
                }`
              );
            }
            sessions = await listTerminalSessions(owner, panelId).catch(() => []);
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

  const sessions = await listTerminalSessions(owner, panelId);
  const session = sessions.find((item) => item.alive !== false);
  if (!session) throw new Error("No usable terminal session");
  return session;
}

async function waitForAutomaticallyResumedTerminalSession(
  owner: TestApp,
  panelId: string,
  window: Page,
  resolvedApprovals: PendingApproval[]
): Promise<TerminalSession> {
  const { app } = owner;
  let lastPanelText = "";
  let lastPanelHtml = "";
  try {
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(owner, window, resolvedApprovals);
          const sessions = await listTerminalSessions(owner, panelId).catch(() => []);
          const alive = sessions.find((session) => session.alive !== false);
          if (alive) return alive.sessionId;
          lastPanelHtml = await getPanelHtml(owner, panelId).catch(() => "");
          lastPanelText = await app
            .evaluate(
              async (_electron, { workspaceId, payload: id }) => {
                const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
                return testApi ? await testApi.getPanelText(id) : "";
              },
              { workspaceId: owner.workspaceId, payload: panelId }
            )
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

  const sessions = await listTerminalSessions(owner, panelId);
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
  owner: TestApp,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const sessionId = await ensureUsableTerminalSessionId(owner, panelId, session);
        let activeSessionId = sessionId;
        let scrollback: { text: string } | null = null;
        try {
          scrollback = await callTerminalPanel<{ text: string }>(owner, panelId, "getScrollback", {
            sessionId: activeSessionId,
            maxBytes: 1024 * 1024,
          });
        } catch (error) {
          const message = String((error as Error | undefined)?.message ?? error);
          if (/unknown session/i.test(message)) {
            const refreshed = await ensureUsableTerminalSessionId(owner, panelId, session);
            if (refreshed !== activeSessionId) {
              activeSessionId = refreshed;
              const reloaded = await callTerminalPanel<{ text: string }>(
                owner,
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

async function expectRenderedToContain(
  owner: TestApp,
  panelId: string,
  session: string | TerminalSessionRef,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const sessionId = await ensureUsableTerminalSessionId(owner, panelId, session);
          return callTerminalPanel<string>(owner, panelId, "getRenderedText", {
            sessionId,
          });
        } catch (error) {
          const message = String((error as Error | undefined)?.message ?? error);
          if (!/unknown session/i.test(message)) throw error;
          const refreshed = await ensureUsableTerminalSessionId(owner, panelId, session);
          return callTerminalPanel<string>(owner, panelId, "getRenderedText", {
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
  expect(await clickPanelSelector(testApp, panelId, ".xterm")).toBe(true);
  await expect
    .poll(async () => getFocusedPanelWebContentsId(testApp), {
      timeout: 5_000,
      intervals: [100, 250, 500],
    })
    .toBe(panelId);
}

async function panelTreeTitle(owner: TestApp, panelId: string): Promise<string | null> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId, payload: id }) => {
      type PanelNode = { id: string; title?: string; children?: PanelNode[] };
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");
      const tree = testApi.getPanelTree() as PanelNode[];
      const visit = (nodes: PanelNode[]): string | null => {
        for (const node of nodes) {
          if (node.id === id) return node.title ?? null;
          const nested = visit(node.children ?? []);
          if (nested !== null) return nested;
        }
        return null;
      };
      return visit(tree ?? []);
    },
    { workspaceId: owner.workspaceId, payload: panelId }
  );
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
    let terminalPanelId = await waitForTerminalPanel(testApp, testApp.window, resolvedApprovals);
    await startPanelDiagnostics(testApp, terminalPanelId);
    expect(await terminalAuthorityRequests(testApp, terminalPanelId)).toContainEqual(
      expect.objectContaining({
        capability: "userland:extensions/shell/native.shell.execute#*",
        resource: {
          kind: "exact",
          key: "native.shell:extension:@workspace-extensions/shell",
        },
      })
    );
    await expect
      .poll(async () => terminalNativeAuthorityRequests(testApp!, terminalPanelId), {
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
      testApp,
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
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toMatch(/aria-label="Terminal input"/);

    await sendTerminalText(
      testApp,
      terminalPanelId,
      sessionRef,
      "echo vibestudio-e2e-input\r",
      testApp.window
    );
    await expectScrollbackToContain(testApp, terminalPanelId, sessionRef, "vibestudio-e2e-input");

    await expect
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
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
      testApp,
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

    expect(
      await clickPanelSelector(testApp, terminalPanelId, '[aria-label="Terminal settings"]')
    ).toBe(true);
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            testApp!,
            terminalPanelId,
            `Boolean(document.querySelector('[aria-label="Panel name"]'))`
          ),
        { timeout: 5_000, intervals: [100, 250, 500] }
      )
      .toBe(true);
    await executePanelScript(
      testApp,
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
      .poll(() => executePanelScript<string>(testApp!, terminalPanelId, "document.title"), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");
    expect(
      await clickPanelSelector(testApp, terminalPanelId, '[aria-label="Terminal settings"]')
    ).toBe(true);
    await expect
      .poll(
        () =>
          executePanelScript<boolean>(
            testApp!,
            terminalPanelId,
            `!document.querySelector('[aria-label="Panel name"]') &&
              document.activeElement?.getAttribute('aria-label') !== 'Panel name'`
          ),
        { timeout: 5_000, intervals: [100, 250, 500] }
      )
      .toBe(true);
    await expect
      .poll(() => panelTreeTitle(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");

    await executePanelScript(
      testApp,
      terminalPanelId,
      `(() => {
        const samples = [document.documentElement.clientWidth];
        const observer = new ResizeObserver(() => samples.push(document.documentElement.clientWidth));
        observer.observe(document.documentElement);
        window.__terminalPanelWidthProbe = { samples, observer };
      })()`
    );
    expect(await clickPanelSelector(testApp, terminalPanelId, ".xterm")).toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(testApp!), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await delay(500);
    const clickWidths = await executePanelScript<number[]>(
      testApp,
      terminalPanelId,
      `(() => {
        const probe = window.__terminalPanelWidthProbe;
        probe?.observer?.disconnect();
        return probe?.samples ?? [];
      })()`
    );
    expect(new Set(clickWidths).size).toBe(1);
    await typePanelText(testApp, terminalPanelId, "\u0015printf 'vibestudio-keyboard-input\\n'\r");
    await expectScrollbackToContain(
      testApp,
      terminalPanelId,
      sessionRef,
      "vibestudio-keyboard-input"
    );
    await expectRenderedToContain(
      testApp,
      terminalPanelId,
      sessionRef,
      "vibestudio-keyboard-input"
    );

    if (hasOwnedX11Display()) {
      await typeTerminalThroughNativeInput(
        testApp,
        terminalPanelId,
        "printf 'vibestudio-os-keyboard-input\\n'"
      );
    } else {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(
        testApp,
        terminalPanelId,
        "\u0015printf 'vibestudio-os-keyboard-input\\n'\r"
      );
    }
    await expectScrollbackToContain(
      testApp,
      terminalPanelId,
      sessionRef,
      "vibestudio-os-keyboard-input"
    );
    await expectRenderedToContain(
      testApp,
      terminalPanelId,
      sessionRef,
      "vibestudio-os-keyboard-input"
    );

    await setElectronClipboardText(app, "printf 'vibestudio-paste-input\\n'\n");
    if (hasOwnedX11Display()) {
      await pressTerminalShortcutThroughNativeInput(testApp, terminalPanelId, "v");
    } else {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(testApp, terminalPanelId, "\u0015printf 'vibestudio-paste-input\\n'\r");
    }
    await expectScrollbackToContain(testApp, terminalPanelId, sessionRef, "vibestudio-paste-input");
    await expectRenderedToContain(testApp, terminalPanelId, sessionRef, "vibestudio-paste-input");
    await expect
      .poll(() => executePanelScript<string>(testApp!, terminalPanelId, "document.title"), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");
    await expect
      .poll(() => panelTreeTitle(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe("Project terminal");

    await clickPanelSelector(testApp, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Copy all");
    await setElectronClipboardText(app, "vibestudio-copy-sentinel");
    expect(await clickPanelText(testApp, terminalPanelId, "[role='menuitem']", "Copy all")).toBe(
      true
    );
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(testApp!, testApp!.window);
          return getElectronClipboardText(app);
        },
        {
          timeout: 5_000,
          intervals: [100, 250, 500],
        }
      )
      .toContain("vibestudio-paste-input");

    await clickPanelSelector(testApp, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Find");
    expect(await clickPanelText(testApp, terminalPanelId, "[role='menuitem']", "Find")).toBe(true);
    await expect
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain('placeholder="Find"');
    expect(await clickPanelSelector(testApp, terminalPanelId, "input[placeholder='Find']")).toBe(
      true
    );
    await executePanelScript(
      testApp,
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
      .poll(async () => getPanelHtml(testApp!, terminalPanelId), {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toMatch(/[1-9]\d* of \d+/);
    await clickPanelSelector(testApp, terminalPanelId, "[aria-label='Close find']");

    const split = await callTerminalPanelWithApprovals<{ sessionId: string | undefined }>(
      testApp,
      testApp.window,
      terminalPanelId,
      "splitPane",
      { direction: "right" }
    );
    expect(split.sessionId).toBeTruthy();
    await callTerminalPanel(testApp, terminalPanelId, "sendText", {
      sessionId: split.sessionId,
      text: "printf 'vibestudio-split-input\\n'\r",
    });
    await expectScrollbackToContain(
      testApp,
      terminalPanelId,
      split.sessionId!,
      "vibestudio-split-input"
    );
    await expectRenderedToContain(
      testApp,
      terminalPanelId,
      split.sessionId!,
      "vibestudio-split-input"
    );

    const tab = await callTerminalPanelWithApprovals<{ sessionId: string | undefined }>(
      testApp,
      testApp.window,
      terminalPanelId,
      "openSession",
      {}
    );
    expect(tab.sessionId).toBeTruthy();
    await callTerminalPanel(testApp, terminalPanelId, "sendText", {
      sessionId: tab.sessionId,
      text: "printf 'vibestudio-tab-input\\n'\r",
    });
    await expectScrollbackToContain(
      testApp,
      terminalPanelId,
      tab.sessionId!,
      "vibestudio-tab-input"
    );

    const focusSessionId = await ensureUsableTerminalSessionId(
      testApp,
      terminalPanelId,
      sessionRef,
      testApp.window
    );
    sessionRef.sessionId = focusSessionId;
    await callTerminalPanel(testApp, terminalPanelId, "focusSession", {
      sessionId: focusSessionId,
    });
    await callTerminalPanel(testApp, terminalPanelId, "sendText", {
      sessionId: focusSessionId,
      text: "printf 'http://localhost:43210\\n'\r",
    });
    await expect
      .poll(
        async () => {
          const sessions = await listTerminalSessions(testApp!, terminalPanelId);
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

    await callTerminalPanel(testApp, terminalPanelId, "sendText", {
      sessionId: sessionRef.sessionId,
      text: "printf '\\033]633;E;vibestudio-shell-integration\\007\\033]633;C\\007\\033]633;D;0\\007'\r",
    });
    await expect
      .poll(
        async () => {
          const sessions = await listTerminalSessions(testApp!, terminalPanelId);
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

    const beforeResize = (await listTerminalSessions(testApp, terminalPanelId)).find(
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
          const sessions = await listTerminalSessions(testApp!, terminalPanelId);
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
          await approvePendingTerminalWork(testApp!, testApp!.window);
          const stateArgs = await app.evaluate(
            async (_electron, { workspaceId, payload: panelId }) => {
              const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
              if (!testApi) throw new Error("Test API not available");
              const detail = (await testApi.rpcCall("workspace-state", "panelTree.detail", [
                panelId,
              ])) as { currentHistory?: { state_args?: string | null } } | null;
              return detail?.currentHistory?.state_args ?? null;
            },
            { workspaceId: testApp!.workspaceId, payload: terminalPanelId }
          );
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
    await reloadPanel(testApp, preReloadPanelId);
    terminalPanelId = await waitForTerminalPanel(testApp, testApp.window);
    if (terminalPanelId !== preReloadPanelId) {
      await startPanelDiagnostics(testApp, terminalPanelId);
    }
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(testApp!, testApp!.window).catch(() => {});
          return getPanelHtml(testApp!, terminalPanelId).catch(() => "");
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toContain("xterm");

    const reloadedSessionId = await ensureUsableTerminalSessionId(
      testApp,
      terminalPanelId,
      sessionRef,
      testApp.window
    );
    await callTerminalPanel(testApp, terminalPanelId, "focusSession", {
      sessionId: reloadedSessionId,
    }).catch(() => undefined);
    await expect
      .poll(
        async () =>
          (await clickPanelSelector(
            testApp!,
            terminalPanelId,
            '[data-focused="true"] .xterm'
          ).catch(() => false)) ||
          (await clickPanelSelector(
            testApp!,
            terminalPanelId,
            '[data-focused="true"] .xterm-helper-textarea'
          ).catch(() => false)),
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(testApp!), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await typePanelText(
      testApp,
      terminalPanelId,
      "\u0003\u0015printf 'vibestudio-reloaded-keyboard-input\\n'\r"
    );
    await expectScrollbackToContain(
      testApp,
      terminalPanelId,
      reloadedSessionId,
      "vibestudio-reloaded-keyboard-input"
    );
    await expectRenderedToContain(
      testApp,
      terminalPanelId,
      reloadedSessionId,
      "vibestudio-reloaded-keyboard-input"
    );

    expect(severePanelDiagnostics(await getPanelDiagnostics(testApp, terminalPanelId))).toEqual([]);
  });
});
