import { expect, test } from "@playwright/test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

import { CredentialStore } from "@vibestudio/credential-client/store";
import { HostLaunchClient } from "@vibestudio/service-schemas/clients/hostLaunchClient";
import {
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getPanelDiagnostics,
  getPanelHtml,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  approvePendingWorkspaceCreationReview,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  executePanelScript,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type PendingApproval = {
  approvalId: string;
  kind: string;
  title?: string;
  capability?: string;
  credentialLabel?: string;
  allowedDecisions?: string[];
  resource?: { type?: string; label?: string; value?: string };
  parts?: Array<{ kind: string; name: string; target?: string | null }>;
};

const OPENAI_CODEX_CREDENTIAL_ID = "e2e-openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function centralDataDirForWorkspace(workspaceDir: string): string {
  return path.dirname(path.dirname(workspaceDir));
}

function envForCentralDataDir(centralDataDir: string): Partial<NodeJS.ProcessEnv> {
  switch (process.platform) {
    case "win32":
      return { APPDATA: path.dirname(centralDataDir) };
    case "darwin":
      return {
        HOME: path.dirname(path.dirname(path.dirname(centralDataDir))),
      };
    default:
      return {
        XDG_CONFIG_HOME: path.dirname(centralDataDir),
        HOME: path.join(path.dirname(path.dirname(centralDataDir)), "home"),
      };
  }
}

async function withCredentialStoreEnv<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const overrides = envForCentralDataDir(centralDataDirForWorkspace(workspaceDir));
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function seedOpenAiCodexCredential(workspaceDir: string): Promise<void> {
  await withCredentialStoreEnv(workspaceDir, async () => {
    const store = new CredentialStore({
      basePath: path.join(centralDataDirForWorkspace(workspaceDir), "credentials"),
    });
    await store.saveUrlBound({
      id: OPENAI_CODEX_CREDENTIAL_ID,
      label: "ChatGPT Codex model credential",
      providerId: "url-bound",
      connectionId: OPENAI_CODEX_CREDENTIAL_ID,
      connectionLabel: "ChatGPT Codex model credential",
      accountIdentity: {
        providerUserId: "e2e-openai-account",
        email: "e2e@example.invalid",
      },
      accessToken: "e2e-openai-token",
      scopes: ["openid", "profile", "email", "offline_access"],
      bindings: [
        {
          id: "fetch",
          use: "fetch",
          audience: [{ url: OPENAI_CODEX_BASE_URL, match: "path-prefix" }],
          injection: {
            type: "header",
            name: "Authorization",
            valueTemplate: "Bearer {token}",
            stripIncoming: ["authorization"],
          },
        },
      ],
      metadata: {
        modelProviderId: "openai-codex",
        materialType: "bearer-token",
      },
    });
  });
}

function configureWorkspaceSourceForApproval(
  sourceRoot: string,
  initialPromptOverride?: string
): string {
  const extensionDir = path.join(sourceRoot, "extensions", "e2e-approval");
  fsSync.mkdirSync(extensionDir, { recursive: true });
  fsSync.writeFileSync(
    path.join(extensionDir, "package.json"),
    JSON.stringify(
      {
        name: "@workspace-extensions/e2e-approval",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          displayName: "E2E Approval Extension",
          entry: "index.ts",
          extension: { activationEvents: ["*"] },
          authority: { requests: [], provides: [] },
        },
      },
      null,
      2
    ),
    "utf8"
  );
  fsSync.writeFileSync(
    path.join(extensionDir, "index.ts"),
    [
      "export async function activate() {",
      "  return {",
      "    ping() { return 'pong'; },",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
  const config = (YAML.parse(fsSync.readFileSync(configPath, "utf8")) ?? {}) as {
    defaultAgentConfig?: { model?: string };
    extensions?: unknown[];
    initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
  };
  config.defaultAgentConfig = {
    ...config.defaultAgentConfig,
    model: "openai-codex:gpt-5.4-mini",
  };
  config.extensions = [
    ...(Array.isArray(config.extensions) ? config.extensions : []),
    { source: "extensions/e2e-approval" },
  ];
  // Exercise the shipped onboarding contract itself. This test must not inject
  // a substitute prompt: doing so would hide a template regression where the
  // configured first turn disappears and the lazy chat correctly stays idle.
  const initialChat = config.initPanels?.find((panel) => panel.source === "panels/chat");
  if (!initialChat) throw new Error("Expected an initial chat panel in the workspace config");
  const initialPrompt = initialChat.stateArgs?.initialPrompt;
  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    throw new Error("Expected the shipped initial chat panel to declare a non-empty initialPrompt");
  }
  if (initialPromptOverride !== undefined) {
    initialChat.stateArgs = { ...initialChat.stateArgs, initialPrompt: initialPromptOverride };
  }
  fsSync.writeFileSync(configPath, YAML.stringify(config), "utf8");
  return initialPromptOverride ?? initialPrompt;
}

async function listPendingApprovals(testApp: TestApp): Promise<PendingApproval[]> {
  return rpcCall(testApp, "shellApproval", "listPending", []) as Promise<PendingApproval[]>;
}

async function rpcCall(
  testApp: TestApp,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return testApp.app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
          };
        }
      ).__testApi;
      if (!testApi) throw new Error("Test API not available");
      return testApi.rpcCall(request.service, request.method, request.args);
    },
    { service, method, args }
  );
}

async function shellHasApprovalUi(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    let hasHostedShellChrome = false;
    let hasApprovalSurface = false;
    let hasLaunchGateApproval = false;
    const candidates = webContents.getAllWebContents().filter((contents) => {
      if (contents.isDestroyed()) return false;
      const title = contents.getTitle();
      return title === "@workspace-apps/shell" || title === "Vibestudio Launch";
    });
    for (const contents of candidates) {
      try {
        const result = (await Promise.race([
          contents.executeJavaScript(
            `(() => {
              const bodyText = document.body?.innerText ?? "";
              return {
                hasHostedShellChrome: Boolean(document.querySelector('[data-shell-top-chrome="titlebar"]')
                  || document.querySelector(".titlebar-breadcrumb-scroll")
                  || document.querySelector('[aria-label="Menu"]')),
                hasApprovalSurface: Boolean(document.querySelector(".approval-card, .approval-pill")),
                hasLaunchGateApproval: Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
                  && Array.from(document.querySelectorAll("button")).some((button) =>
                    /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start|Deny|Quit|Don’t start)$/i.test(button.textContent?.trim() ?? "")
                  ),
              };
            })()`,
            true
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
        ])) as {
          hasHostedShellChrome: boolean;
          hasApprovalSurface: boolean;
          hasLaunchGateApproval: boolean;
        } | null;
        if (!result) continue;
        hasHostedShellChrome ||= result.hasHostedShellChrome;
        hasApprovalSurface ||= result.hasApprovalSurface;
        hasLaunchGateApproval ||= result.hasLaunchGateApproval;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return hasLaunchGateApproval || (hasHostedShellChrome && hasApprovalSurface);
  });
}

async function credentialApprovalActionStyles(
  testApp: TestApp
): Promise<{ trustVersion: string; useOnce: string } | null> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const styles = await contents.executeJavaScript(
          `(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const trust = buttons.find((button) => button.innerText.trim() === 'Trust version');
            const once = buttons.find((button) => button.innerText.trim() === 'Use once');
            if (!(trust instanceof HTMLElement) || !(once instanceof HTMLElement)) return null;
            return {
              trustVersion: trust.getAttribute('data-accent-color') ?? '',
              useOnce: once.getAttribute('data-accent-color') ?? '',
            };
          })()`,
          true
        );
        if (styles) return styles;
      } catch {
        // Ignore non-DOM and transiently navigating webContents.
      }
    }
    return null;
  });
}

async function capabilityApprovalUiSnapshot(
  testApp: TestApp,
  approvalId?: string
): Promise<{
  text: string;
  buttons: string[];
  role: string | null;
  labelledByText: string;
  describedByText: string;
  keyboardShortcuts: string | null;
} | null> {
  return testApp.app.evaluate(async ({ webContents }, requestedApprovalId) => {
    const candidates = webContents
      .getAllWebContents()
      .sort(
        (left, right) =>
          Number(!left.getURL().includes("overlaySurface=")) -
          Number(!right.getURL().includes("overlaySurface="))
      );
    for (const contents of candidates) {
      if (contents.isDestroyed()) continue;
      try {
        const snapshot = await contents.executeJavaScript(
          `(() => {
            const requestedApprovalId = ${JSON.stringify(requestedApprovalId)};
            const card = requestedApprovalId
              ? Array.from(document.querySelectorAll("[data-approval-card]")).find(
                  (element) => element.getAttribute("data-approval-id") === requestedApprovalId
                )
              : document.querySelector(".approval-card");
            if (!(card instanceof HTMLElement)) return null;
            return {
              text: card.innerText,
              buttons: Array.from(card.querySelectorAll("button"))
                .map((button) => button.innerText.trim())
                .filter(Boolean),
              role: card.getAttribute("role"),
              labelledByText: document.getElementById(card.getAttribute("aria-labelledby") ?? "")
                ?.textContent?.trim() ?? "",
              describedByText: document.getElementById(card.getAttribute("aria-describedby") ?? "")
                ?.textContent?.trim() ?? "",
              keyboardShortcuts: card.getAttribute("aria-keyshortcuts"),
            };
          })()`,
          true
        );
        if (snapshot) return snapshot;
      } catch {
        // Ignore non-DOM and transiently navigating webContents.
      }
    }
    return null;
  }, approvalId ?? null);
}

async function hostedShellHasApprovalUi(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    let hasHostedShellChrome = false;
    let hasApprovalSurface = false;
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = (await contents.executeJavaScript(
          `(() => ({
            // The explicit shell marker avoids treating a generic launch-page
            // menu or stale WebContents as the hosted application.
            hasHostedShellChrome: Boolean(document.querySelector('[data-shell-top-chrome="titlebar"]')),
            hasApprovalSurface: Boolean(document.querySelector(".approval-card, .approval-pill")),
          }))()`,
          true
        )) as {
          hasHostedShellChrome: boolean;
          hasApprovalSurface: boolean;
        };
        hasHostedShellChrome ||= result.hasHostedShellChrome;
        hasApprovalSurface ||= result.hasApprovalSurface;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return hasHostedShellChrome && hasApprovalSurface;
  });
}

async function hostedShellHasChrome(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) => !candidate.isDestroyed() && candidate.getTitle() === "@workspace-apps/shell"
      );
    if (!contents) return false;
    try {
      return await Promise.race([
        contents.executeJavaScript(
          `(() => Boolean(
              document.querySelector('[data-shell-top-chrome="titlebar"]')
            ))()`,
          true
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
    } catch {
      return false;
    }
  });
}

async function callHostedShellService(
  testApp: TestApp,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return testApp.app.evaluate(
    async ({ webContents }, request) => {
      const contents = webContents
        .getAllWebContents()
        .find(
          (candidate) =>
            !candidate.isDestroyed() && candidate.getTitle() === "@workspace-apps/shell"
        );
      if (!contents) throw new Error("Hosted shell app WebContents was not found");
      return contents.executeJavaScript(
        `globalThis.__vibestudioApp.serviceCall(${JSON.stringify(request.method)}, ...${JSON.stringify(request.args)})`,
        true
      );
    },
    { method, args }
  );
}

async function bootstrapLaunchGateHasCredentialApproval(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => {
            const bodyText = document.body?.innerText ?? "";
            return Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && /credential|OpenAI|ChatGPT Codex model credential/i.test(bodyText);
          })()`,
          true
        );
        if (result) return true;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return false;
  });
}

async function clickShellButton(
  testApp: TestApp,
  label: RegExp,
  approvalId?: string
): Promise<boolean> {
  return testApp.app.evaluate(
    async ({ webContents }, request) => {
      const { labelSource, approvalId } = request;
      const candidates = webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed())
        .sort((left, right) => {
          const priority = (contents: Electron.WebContents) => {
            if (approvalId && contents.getURL().includes("overlaySurface=")) return -1;
            const title = contents.getTitle();
            if (title === "Vibestudio Launch") return 0;
            if (title === "@workspace-apps/shell") return 1;
            return 2;
          };
          return priority(left) - priority(right);
        });
      for (const contents of candidates) {
        if (contents.isDestroyed()) continue;
        try {
          const clicked = await contents.executeJavaScript(
            `(() => {
            const label = new RegExp(${JSON.stringify(labelSource)}, "i");
            const approvalId = ${JSON.stringify(approvalId ?? null)};
            const approvalCard = approvalId
              ? Array.from(document.querySelectorAll("[data-approval-card]")).find(
                  (element) => element.getAttribute("data-approval-id") === approvalId
                )
              : null;
            if (approvalId && !approvalCard) return false;
            const scope = approvalCard ?? document;
            const buttons = Array.from(scope.querySelectorAll("button"));
            const semanticButton =
              (label.test("Add to workspace")
                ? scope.querySelector("button[data-approval-action='accept-install-review']")
                : null)
                ?? (label.test("Trust this version") || label.test("Trust version")
                  ? scope.querySelector("button[data-approval-decision='version']")
                  : label.test("Use this session")
                    ? scope.querySelector("button[data-approval-decision='session']")
                    : null);
            const button = semanticButton ?? buttons.find((item) => {
              const text = (item.textContent ?? "").replace(/\s+/g, " ").trim();
              const innerText = (item.innerText ?? "").replace(/\s+/g, " ").trim();
              return label.test(text) || label.test(innerText);
            });
            if (!button || ("disabled" in button && Boolean(button.disabled))) return false;
            if (typeof button.focus === "function") button.focus();
            if (typeof button.click !== "function") return false;
            button.click();
            return true;
          })()`,
            true
          );
          if (clicked) return true;
        } catch {
          // Ignore non-DOM webContents.
        }
      }
      return false;
    },
    { labelSource: label.source, approvalId: approvalId ?? null }
  );
}

async function clickShellButtonByPreference(
  testApp: TestApp,
  labels: RegExp[],
  approvalId?: string
): Promise<boolean> {
  for (const label of labels) {
    if (await clickShellButton(testApp, label, approvalId)) return true;
  }
  return false;
}

async function listShellDomSnapshots(testApp: TestApp): Promise<
  Array<{
    id: number;
    url: string;
    title: string;
    text: string;
    hasTitlebar: boolean;
    hasApprovalBar: boolean;
    hasRecoveryApproval: boolean;
    approvalText: string;
    buttons: Array<{ text: string; disabled: boolean }>;
    overlay: {
      readyState: string;
      hasBridge: boolean;
      rootHtml: string;
      bodyHtml: string;
    } | null;
  }>
> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const snapshots = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      const title = contents.getTitle();
      if (
        !url.includes("/_a/") &&
        !url.includes("overlaySurface=") &&
        !url.endsWith("/index.html") &&
        title !== "@workspace-apps/shell" &&
        title !== "Vibestudio Launch"
      )
        continue;
      try {
        const dom = await contents.executeJavaScript(
          `(() => {
            const approval = document.querySelector(".approval-card, .approval-pill");
            const bodyText = document.body?.innerText ?? "";
            const buttons = Array.from(document.querySelectorAll("button")).map((button) => ({
              text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
              disabled: button instanceof HTMLButtonElement ? button.disabled : false,
            }));
            const overlay = location.hash.includes("overlaySurface=")
              ? {
                  readyState: document.readyState,
                  hasBridge: Boolean(globalThis.__vibestudioContentOverlay),
                  rootHtml: document.getElementById("app")?.innerHTML.slice(0, 2000) ?? "",
                  bodyHtml: document.body?.innerHTML.slice(0, 2000) ?? "",
                }
              : null;
            const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && Array.from(document.querySelectorAll("button")).some((button) =>
                /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start|Deny|Quit|Don’t start)$/i.test(button.textContent?.trim() ?? "")
              );
            return {
              text: bodyText.slice(0, 4000),
              buttons,
              overlay,
              hasTitlebar: Boolean(document.querySelector('[data-shell-top-chrome="titlebar"]')
                || document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')),
              hasApprovalBar: Boolean(approval),
              hasRecoveryApproval: hasLaunchGateApproval,
              approvalText: approval?.textContent ?? "",
            };
          })()`,
          true
        );
        snapshots.push({
          id: contents.id,
          url,
          title,
          ...dom,
        });
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return snapshots;
  });
}

async function attachStartupDiagnostics(testApp: TestApp): Promise<void> {
  const pending = await listPendingApprovals(testApp).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const launchResult = await new HostLaunchClient((service, method, args) =>
    rpcCall(testApp, service, method, args)
  )
    .launch("electron")
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  const hostView = await testApp.app
    .evaluate(() => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getHostViewDebugInfo?: () => unknown;
          };
        }
      ).__testApi;
      return testApi?.getHostViewDebugInfo?.() ?? null;
    })
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  const shellDom = await listShellDomSnapshots(testApp).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const panels = await getPanelTree(testApp.app).catch(() => []);
  const panelDetails = [];
  const channelNames: string[] = [];
  for (const panel of panels) {
    const id = panel.id;
    const text = await getPanelText(testApp.app, id).catch((error: unknown) =>
      error instanceof Error ? `ERROR: ${error.message}` : `ERROR: ${String(error)}`
    );
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.channelName === "string"
        ? stateArgs.channelName
        : text.match(/\bchat-[a-z0-9]+\b/)?.[0];
    if (channelName) channelNames.push(channelName);
    panelDetails.push({
      id,
      title: panel.title,
      snapshot: panel.snapshot,
      source: panel.snapshot?.source,
      text,
      boot: await executePanelScript(
        testApp.app,
        id,
        `(async () => {
          const loader = document.querySelector("script[data-bundle-src]");
          const bundleSrc = loader instanceof HTMLScriptElement ? loader.dataset.bundleSrc : null;
          const bundleUrl = bundleSrc ? new URL(bundleSrc, document.baseURI).href : null;
          const resources = performance.getEntriesByType("resource").map((entry) => {
            const resource = entry;
            return {
              name: resource.name,
              duration: resource.duration,
              transferSize: "transferSize" in resource ? resource.transferSize : undefined,
              responseStatus: "responseStatus" in resource ? resource.responseStatus : undefined,
            };
          });
          let bundleFetch = null;
          if (bundleUrl) {
            try {
              const response = await fetch(bundleUrl, { cache: "no-store" });
              bundleFetch = {
                ok: response.ok,
                status: response.status,
                contentType: response.headers.get("content-type"),
                bodyPrefix: (await response.text()).slice(0, 300),
              };
            } catch (error) {
              bundleFetch = { error: error instanceof Error ? error.message : String(error) };
            }
          }
          return {
            href: location.href,
            baseURI: document.baseURI,
            bundleSrc,
            bundleUrl,
            state: globalThis.__vibestudioPanelBoot ?? null,
            resources,
            bundleFetch,
          };
        })()`
      ).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
      htmlSummary: await getPanelHtml(testApp.app, id)
        .then((html) => ({
          length: html.length,
          hasLoader: html.includes("/__loader.js"),
          hasBundle: html.includes("./bundle.js"),
          hasTransport: html.includes("/__transport.js"),
          hasActionBar: html.includes("chat-action-bar"),
        }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      diagnostics: await getPanelDiagnostics(testApp.app, id).catch(() => []),
    });
  }
  const channelParticipants = [];
  const channelReplays = [];
  const agentDebugStates = [];
  for (const channelName of channelNames) {
    const firstPanelId = panels[0]?.id;
    const resolved = firstPanelId
      ? await resolveWorkspaceServiceFromPanel(
          testApp,
          firstPanelId,
          "vibestudio.channel.v1",
          channelName
        ).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      : { error: "No hosted panel is available to resolve the creator-context channel" };
    const targetId =
      typeof resolved === "object" &&
      resolved !== null &&
      "targetId" in resolved &&
      typeof resolved.targetId === "string"
        ? resolved.targetId
        : null;
    const participants =
      targetId && firstPanelId
        ? await executePanelScript(
            testApp.app,
            firstPanelId,
            `globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(targetId)}, "getParticipants", []))`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    const replay =
      targetId && firstPanelId
        ? await executePanelScript(
            testApp.app,
            firstPanelId,
            `(() => globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(targetId)}, "getReplayAfter", [{ after: 0 }])).then((replay) => ({
              ready: replay?.ready,
              snapshots: replay?.snapshots,
              logEvents: (replay?.logEvents ?? []).map((event) => ({
                id: event.id,
                type: event.type,
                senderId: event.senderId,
                senderMetadata: event.senderMetadata,
                payloadKind: event.payload?.kind,
                agenticKind: event.payload?.payload?.kind,
                role: event.payload?.payload?.message?.role ?? event.payload?.message?.role,
                content: String(event.payload?.payload?.message?.content ?? event.payload?.message?.content ?? event.payload?.content ?? "").slice(0, 300),
              })),
            })))()`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    channelReplays.push({ channelName, replay });
    const agentParticipants = Array.isArray(participants)
      ? participants.filter(
          (participant: { participantId?: unknown }) =>
            typeof participant.participantId === "string" &&
            participant.participantId.startsWith("do:workers/agent-worker:AiChatWorker:")
        )
      : [];
    for (const agent of agentParticipants) {
      const agentId = (agent as { participantId: string }).participantId;
      const debugState = firstPanelId
        ? await executePanelScript(
            testApp.app,
            firstPanelId,
            `globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(agentId)}, "getDebugState", [${JSON.stringify(channelName)}]))`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
      agentDebugStates.push({ channelName, agentId, debugState });
    }
    channelParticipants.push({ channelName, resolved, participants });
  }
  const workerLogs = await rpcCall(testApp, "workspace", "units.logs", [
    "workers/agent-worker",
    { limit: 200 },
  ]).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const diagnostics = {
    pending,
    launchResult,
    hostView,
    shellDom,
    panels: panelDetails,
    channelParticipants,
    channelReplays,
    agentDebugStates,
    workerLogs,
  };
  await test.info().attach("startup-approvals-diagnostics.json", {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: "application/json",
  });
}

type StartupAgentCompletionState = {
  complete: boolean;
  channels: Array<{
    channelName: string;
    agentIds: string[];
    initialPromptDelivered: boolean;
    onboardingSkillReadCompleted: boolean;
    assistantCompleted: boolean;
    turnClosed: boolean;
    pendingWork: string[];
    failures: string[];
    invocations: Array<Record<string, unknown>>;
  }>;
  errors: string[];
};

function boundedEventValue(value: unknown, maxLength = 600): string | undefined {
  if (value === undefined) return undefined;
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length <= maxLength ? rendered : `${rendered.slice(0, maxLength)}…`;
}

function summarizeInvocationEvent(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      kind: event["kind"],
      invocationId: event["invocationId"],
      name: event["name"],
      request: boundedEventValue(event["request"]),
      terminalOutcome: event["terminalOutcome"],
      outcome: event["outcome"],
      reason: event["reason"],
      error: boundedEventValue(event["error"]),
      result: boundedEventValue(event["result"]),
    }).filter((entry) => entry[1] !== undefined)
  );
}

async function collectStartupAgentCompletion(
  testApp: TestApp,
  expectedInitialPrompt: string
): Promise<StartupAgentCompletionState> {
  const panels = await getPanelTree(testApp.app).catch(() => []);
  const firstPanelId = panels[0]?.id;
  const channelNames = new Set<string>();
  for (const panel of panels) {
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.channelName === "string"
        ? stateArgs.channelName
        : (await getPanelText(testApp.app, panel.id).catch(() => "")).match(
            /\bchat-[a-z0-9]+\b/
          )?.[0];
    if (channelName) channelNames.add(channelName);
  }
  if (!firstPanelId) {
    return { complete: false, channels: [], errors: ["No panel is available for RPC inspection"] };
  }
  const panelSurfaceText = await getPanelText(testApp.app, firstPanelId).catch(() => "");
  const surfaceAgentHandle = panelSurfaceText.match(/@ai-chat-[a-z0-9-]+/i)?.[0] ?? null;
  // A completed first turn can be fully rendered in the panel after the agent
  // has retired its live subscription. Keep the user-visible contract as a
  // bounded fallback for that lifecycle state; durable channel/trajectory
  // events remain authoritative whenever they are available.
  const surfaceInitialPromptDelivered = panelSurfaceText.includes(expectedInitialPrompt.trim());
  const surfaceOnboardingSkillReadCompleted = /\bRead\s+path:\s+SKILL\.md\b/i.test(
    panelSurfaceText
  );
  const surfaceAssistantCompleted = panelSurfaceText.includes(
    "E2E model response: initial agent turn completed."
  );

  const channels: StartupAgentCompletionState["channels"] = [];
  const errors: string[] = [];
  for (const channelName of channelNames) {
    const resolved = await resolveWorkspaceServiceFromPanel(
      testApp,
      firstPanelId,
      "vibestudio.channel.v1",
      channelName
    ).catch((error: unknown) => {
      errors.push(
        `${channelName}: resolveService failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    });
    const targetId =
      typeof resolved === "object" &&
      resolved !== null &&
      "targetId" in resolved &&
      typeof resolved.targetId === "string"
        ? resolved.targetId
        : null;
    if (!targetId) {
      channels.push({
        channelName,
        agentIds: [],
        initialPromptDelivered: false,
        onboardingSkillReadCompleted: false,
        assistantCompleted: false,
        turnClosed: false,
        pendingWork: [],
        failures: ["Channel service target was not resolved"],
        invocations: [],
      });
      continue;
    }

    const snapshot = await executePanelScript(
      testApp.app,
      firstPanelId,
      `(async () => {
        const { rpc } = await globalThis.__vibestudioRequireAsync__("@workspace/runtime");
        const hydrateStoredValue = async (value) => {
          if (
            !value ||
            typeof value !== "object" ||
            value.protocol !== "vibestudio.blob-ref.v1" ||
            typeof value.digest !== "string"
          ) {
            return value;
          }
          const text = await rpc.call("main", "blobstore.getText", [value.digest]);
          if (text === null) {
            throw new Error("Missing trajectory blob " + value.digest);
          }
          return value.encoding === "json" ? JSON.parse(text) : text;
        };
        const normalize = async (event) => {
          const outer = event?.payload;
          const agentic = outer?.kind === "agentic.event" ? outer.payload : (outer?.payload?.kind ? outer.payload : outer);
          const body = agentic?.payload ?? agentic?.message ?? agentic ?? {};
          const message = body?.message ?? {};
          const rawBlocks = Array.isArray(body?.blocks)
            ? body.blocks
            : Array.isArray(message?.blocks)
              ? message.blocks
              : [];
          const blocks = Array.isArray(agentic?.payload?.blocks)
            ? agentic.payload.blocks.map((block) => ({
                type: block?.type,
                content: typeof block?.content === "string" ? block.content : "",
                metadata: block?.metadata,
              }))
            : rawBlocks.map((block) => ({
                type: block?.type,
                content: typeof block?.content === "string" ? block.content : "",
                metadata: block?.metadata,
              }));
          return {
            senderId: event?.senderId,
            kind: agentic?.kind ?? event?.payloadKind ?? event?.type,
            actorId: agentic?.actor?.id,
            actorKind: agentic?.actor?.kind,
            invocationId: agentic?.causality?.invocationId,
            role: body?.role ?? message?.role,
            name: body?.name,
            request: await hydrateStoredValue(body?.request),
            result: await hydrateStoredValue(body?.result),
            terminalOutcome: body?.terminalOutcome,
            content: typeof body?.content === "string"
              ? body.content
              : typeof message?.content === "string"
                ? message.content
                : "",
            outcome: body?.outcome ?? message?.outcome,
            reason: body?.reason,
            error: body?.error,
            recoverable: body?.recoverable,
            blocks,
          };
        };
        const [participants, replay, trajectoryEvents] = await Promise.all([
          rpc.call(${JSON.stringify(targetId)}, "getParticipants", []),
          rpc.call(${JSON.stringify(targetId)}, "getReplayAfter", [{ after: 0 }]),
          // The agent may gracefully leave the live channel after completing
          // the turn. The channel roster/tail is then intentionally empty, but
          // the GAD trajectory remains the durable source of truth for the
          // completed turn and its tool invocations.
          rpc
            .call("do:workers/workspace-source:GadWorkspaceDO:workspace", "listTrajectoryEvents", [
              {
                trajectoryId: "branch:channel:" + ${JSON.stringify(channelName)},
                branchId: "branch:channel:" + ${JSON.stringify(channelName)},
                cursor: 0,
                limit: 500,
              },
            ])
            .catch(() => []),
        ]);
        return {
          participants,
          events: await Promise.all((replay?.logEvents ?? []).map(normalize)),
          trajectoryEvents: await Promise.all(
            (Array.isArray(trajectoryEvents) ? trajectoryEvents : []).map((event) =>
              normalize({ payload: event?.payload, senderId: event?.actor?.id }).catch(() => null)
            )
          ).then((events) => events.filter((event) => event !== null)),
        };
      })()`
    ).catch((error: unknown) => {
      errors.push(
        `${channelName}: replay inspection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    });

    const participants = Array.isArray(
      (snapshot as { participants?: unknown } | null)?.participants
    )
      ? (snapshot as { participants: Array<{ participantId?: unknown }> }).participants
      : [];
    const agentIds = participants
      .map((participant) =>
        typeof participant.participantId === "string" ? participant.participantId : null
      )
      .filter(
        (participantId): participantId is string =>
          !!participantId && participantId.startsWith("do:workers/agent-worker:AiChatWorker:")
      );
    const channelEvents = Array.isArray((snapshot as { events?: unknown } | null)?.events)
      ? (snapshot as { events: Array<Record<string, unknown>> }).events
      : [];
    const trajectoryEvents = Array.isArray(
      (snapshot as { trajectoryEvents?: unknown } | null)?.trajectoryEvents
    )
      ? (snapshot as { trajectoryEvents: Array<Record<string, unknown>> }).trajectoryEvents
      : [];
    const events = [...channelEvents, ...trajectoryEvents];
    // A completed worker may leave the channel before this diagnostic poll
    // runs. Preserve its identity from the durable event stream so completion
    // validation still recognizes the turn instead of treating a valid replay
    // as an empty, agentless chat.
    const observedAgentIds = new Set(agentIds);
    for (const event of events) {
      for (const key of ["actorId", "senderId"]) {
        const id = event[key];
        if (typeof id === "string" && id.startsWith("do:workers/agent-worker:AiChatWorker:")) {
          observedAgentIds.add(id);
        }
      }
    }
    if (observedAgentIds.size === 0 && surfaceAgentHandle) {
      observedAgentIds.add(`surface:${surfaceAgentHandle}`);
    }
    const isAgentEvent = (event: Record<string, unknown>) =>
      Array.from(observedAgentIds).some(
        (agentId) => event["actorId"] === agentId || event["senderId"] === agentId
      );
    const initialPromptDelivered = events.some((event) => {
      if (event["kind"] !== "message.completed" || event["role"] !== "user") return false;
      const blocks = Array.isArray(event["blocks"]) ? event["blocks"] : [];
      const blockText = blocks
        .filter(
          (block): block is { type: string; content: string } =>
            !!block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { content?: unknown }).content === "string"
        )
        .map((block) => block.content)
        .join("\n")
        .trim();
      const content = typeof event["content"] === "string" ? event["content"].trim() : "";
      return blockText === expectedInitialPrompt.trim() || content === expectedInitialPrompt.trim();
    });
    const onboardingReadInvocationIds = new Set(
      events
        .filter((event) => {
          if (event["kind"] !== "invocation.started" || event["name"] !== "read") return false;
          if (!isAgentEvent(event)) return false;
          const request = event["request"];
          if (!request || typeof request !== "object") return false;
          const path = (request as Record<string, unknown>)["path"];
          const target = (request as Record<string, unknown>)["target"];
          return path === "skills/onboarding/SKILL.md" || target === "skills/onboarding/SKILL.md";
        })
        .map((event) => event["invocationId"])
        .filter((invocationId): invocationId is string => typeof invocationId === "string")
    );
    const onboardingSkillReadCompleted = events.some((event) => {
      if (event["kind"] !== "invocation.completed") return false;
      if (event["terminalOutcome"] !== "success") return false;
      if (!isAgentEvent(event)) return false;
      const invocationId = event["invocationId"];
      if (typeof invocationId !== "string" || !onboardingReadInvocationIds.has(invocationId)) {
        return false;
      }
      // A terminal event alone only proves that the tool returned. Requiring a
      // distinctive fragment from the shipped skill proves the real runtime
      // transport returned the requested file contents to the agent.
      return JSON.stringify(event["result"] ?? "").includes("name: onboarding");
    });
    const assistantCompleted = events.some((event) => {
      if (event["kind"] !== "message.completed") return false;
      if (event["role"] !== "assistant" || event["outcome"] !== "completed") return false;
      if (!isAgentEvent(event)) return false;
      const blocks = Array.isArray(event["blocks"]) ? event["blocks"] : [];
      return blocks.some(
        (block) =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { content?: unknown }).content === "string" &&
          (block as { content: string }).content.trim().length > 0
      );
    });
    const turnClosed = events.some(
      (event) => event["kind"] === "turn.closed" && isAgentEvent(event)
    );
    const failures = events
      .filter((event) => {
        if (!isAgentEvent(event)) return false;
        if (event["kind"] === "message.failed" || event["kind"] === "invocation.failed") {
          return true;
        }
        return event["kind"] === "message.completed" && event["outcome"] === "empty";
      })
      .map(
        (event) =>
          `${String(event["kind"])}:${String(event["outcome"] ?? "")}:` +
          `${String(event["reason"] ?? "")}:` +
          `${JSON.stringify(event["error"] ?? event["result"] ?? null)}`
      );
    for (const event of events) {
      if (event["kind"] !== "message.completed" || !isAgentEvent(event)) continue;
      const blocks = Array.isArray(event["blocks"]) ? event["blocks"] : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const record = block as { type?: unknown; metadata?: unknown };
        if (record.type !== "diagnostic" || !record.metadata || typeof record.metadata !== "object")
          continue;
        const metadata = record.metadata as Record<string, unknown>;
        failures.push(
          `diagnostic:${String(metadata["code"] ?? "unknown")}:${String(metadata["reason"] ?? "")}`
        );
      }
    }
    const pendingWork: string[] = [];
    for (const agentId of observedAgentIds) {
      const debugState = await executePanelScript(
        testApp.app,
        firstPanelId,
        `globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(agentId)}, "getDebugState", [${JSON.stringify(channelName)}]))`
      ).catch((error: unknown) => {
        return null;
      });
      const state = (debugState as { result?: unknown } | null)?.result ?? debugState;
      const loop =
        state && typeof state === "object" && (state as { loops?: Record<string, unknown> }).loops
          ? (state as { loops: Record<string, unknown> }).loops[channelName]
          : null;
      if (loop && typeof loop === "object") {
        for (const key of ["pendingInvocations", "pendingApprovals", "pendingCredentialWaits"]) {
          const values = (loop as Record<string, unknown>)[key];
          if (Array.isArray(values) && values.length > 0) {
            pendingWork.push(`${agentId}:${key}:${values.join(",")}`);
          }
        }
      }
    }

    channels.push({
      channelName,
      agentIds: Array.from(observedAgentIds),
      initialPromptDelivered: initialPromptDelivered || surfaceInitialPromptDelivered,
      onboardingSkillReadCompleted:
        onboardingSkillReadCompleted || surfaceOnboardingSkillReadCompleted,
      assistantCompleted: assistantCompleted || surfaceAssistantCompleted,
      turnClosed: turnClosed || surfaceAssistantCompleted,
      pendingWork,
      failures,
      invocations: events
        .filter(
          (event) =>
            typeof event["kind"] === "string" && (event["kind"] as string).startsWith("invocation.")
        )
        .map(summarizeInvocationEvent),
    });
  }

  const complete =
    channels.length >= 1 &&
    channels.every(
      (channel) =>
        channel.agentIds.length > 0 &&
        channel.initialPromptDelivered &&
        channel.onboardingSkillReadCompleted &&
        channel.assistantCompleted &&
        channel.turnClosed &&
        channel.pendingWork.length === 0 &&
        channel.failures.length === 0
    ) &&
    errors.length === 0;

  return { complete, channels, errors };
}

async function resolveWorkspaceServiceFromPanel(
  testApp: TestApp,
  panelId: string,
  query: string,
  objectKey: string | null
): Promise<unknown> {
  return executePanelScript(
    testApp.app,
    panelId,
    `(async () => {
      const { workers } = await globalThis.__vibestudioRequireAsync__("@workspace/runtime");
      return workers.resolveService(${JSON.stringify(query)}, ${JSON.stringify(objectKey)});
    })()`
  );
}

function isUnitBatchApproval(approval: PendingApproval): boolean {
  return approval.kind === "unit-install-review";
}

/** A client app part, in the install review's own vocabulary. */
function appParts(approval: PendingApproval) {
  return approval.kind === "unit-install-review"
    ? (approval.parts ?? []).filter((part) => part.kind === "app")
    : [];
}

function isElectronHostAppApproval(approval: PendingApproval): boolean {
  return appParts(approval).some((part) => part.target === "electron");
}

function describeApproval(approval: PendingApproval): string {
  const parts =
    approval.kind === "unit-install-review"
      ? (approval.parts ?? [])
          .map((part) => `${part.kind}:${part.name}:${part.target ?? "none"}`)
          .join(",")
      : "";
  return `${approval.kind}:${approval.title ?? ""}:${parts}`;
}

function isOpenAiCredentialApproval(approval: PendingApproval): boolean {
  return (
    approval.kind === "credential" && approval.credentialLabel === "ChatGPT Codex model credential"
  );
}

async function reachHostedShellAndDrainStartupApprovals(testApp: TestApp): Promise<string[]> {
  const observedInstallReviews = new Set<string>();
  let startupState: "approval" | "ready" | "waiting" = "waiting";
  try {
    await expect
      .poll(
        async () => {
          const pending = await listPendingApprovals(testApp);
          for (const approval of pending.filter(isUnitBatchApproval)) {
            observedInstallReviews.add(describeApproval(approval));
          }
          if (pending.some(isElectronHostAppApproval) && (await shellHasApprovalUi(testApp))) {
            startupState = "approval";
            return startupState;
          }
          if (await hostedShellHasChrome(testApp)) {
            startupState = "ready";
            return startupState;
          }
          startupState = "waiting";
          return startupState;
        },
        { timeout: 90_000, intervals: [500, 1000, 2000] }
      )
      .not.toBe("waiting");
  } catch (error) {
    await attachStartupDiagnostics(testApp);
    throw error;
  }

  if (startupState === "approval") {
    // `startupState` is "approval" for either surface: the launch gate window
    // (accept label "Start"), or the workspace shell already up and showing the
    // in-app install review. Accept whichever is actually on screen — the same
    // decision is reachable from both, and which one appears depends on how far
    // startup got before the review was queued.
    expect(
      await clickShellButton(
        testApp,
        /^(Start|Add to workspace|Add template|Update|Use the new version|Trust and start|Approve and start)$/
      )
    ).toBe(true);
  }

  try {
    await expect
      .poll(() => hostedShellHasChrome(testApp), {
        timeout: 180_000,
        intervals: [500, 1000, 2000, 5000],
      })
      .toBe(true);
  } catch (error) {
    await attachStartupDiagnostics(testApp);
    throw error;
  }

  await expect
    .poll(() => bootstrapLaunchGateHasCredentialApproval(testApp), {
      timeout: 10_000,
      intervals: [500, 1000],
    })
    .toBe(false);

  for (const panel of await getPanelTree(testApp.app)) {
    await startPanelDiagnostics(testApp.app, panel.id).catch(() => {});
  }

  const drainDeadline = Date.now() + 120_000;
  while (Date.now() < drainDeadline) {
    const pending = await listPendingApprovals(testApp);
    // Once the hosted shell is live it owns every workspace install review,
    // including shared and deferred host-target batches. Leaving those cards
    // pending keeps panel/agent capabilities behind the creation-review gate.
    const pendingInstallReviews = pending.filter(isUnitBatchApproval);
    for (const approval of pendingInstallReviews) {
      observedInstallReviews.add(describeApproval(approval));
    }
    const pendingUnitBatchCount = pendingInstallReviews.length;
    const pendingCredentialCount = pending.filter(isOpenAiCredentialApproval).length;
    const pendingTargetCount = pendingUnitBatchCount + pendingCredentialCount;
    if (pendingTargetCount === 0) break;
    if (pendingCredentialCount > 0) {
      await expect
        .poll(() => credentialApprovalActionStyles(testApp), {
          timeout: 45_000,
          intervals: [250, 500, 1_000, 2_000],
        })
        .toEqual({ trustVersion: "sky", useOnce: "" });
    }
    if (pendingUnitBatchCount > 0) {
      // The install review's real click path is covered by the desktop pairing
      // smoke. This launch-gate spec is about the subsequent agent lifecycle;
      // resolve the one-time workspace adoption through the typed host helper
      // so a large full-surface render cannot make this fixture race its own
      // startup transition.
      await approvePendingWorkspaceCreationReview(
        testApp.app,
        pendingInstallReviews.map(({ approvalId }) => approvalId)
      );
    }
    if (pendingCredentialCount > 0) {
      try {
        await expect
          .poll(
            () =>
              clickShellButtonByPreference(testApp, [
                /^Trust(?: this)? version$/,
                /^Use this session$/,
                /^Approve all$/,
                /^Dev session$/,
                /^Approve and start$/,
                /^Approve$/,
                /^Install and run$/,
                /^Run once$/,
                /^Allow for session$/,
                /^Use once$/,
              ]),
            { timeout: 45_000, intervals: [500, 1000, 2000, 5000] }
          )
          .toBe(true);
      } catch (error) {
        await attachStartupDiagnostics(testApp);
        throw error;
      }
    }
    await expect
      .poll(
        async () => {
          const next = await listPendingApprovals(testApp);
          return (
            next.filter(isUnitBatchApproval).length + next.filter(isOpenAiCredentialApproval).length
          );
        },
        { timeout: 10_000, intervals: [500, 1000, 2000] }
      )
      .toBeLessThan(pendingTargetCount);
  }

  await expect
    .poll(async () => (await listPendingApprovals(testApp)).filter(isUnitBatchApproval).length, {
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(0);
  await expect
    .poll(
      async () => (await listPendingApprovals(testApp)).filter(isOpenAiCredentialApproval).length,
      { timeout: 30_000, intervals: [500, 1000, 2000] }
    )
    .toBe(0);
  return [...observedInstallReviews];
}

/**
 * The initial chat is expected to pause on its two ordinary workspace-service
 * capabilities. The panel and its agent worker can request those capabilities
 * at slightly different times, so wait for a quiet queue after the last one is
 * approved before handing control to the completion assertion. Contextual
 * approvals (for example network access) remain with the scenario that tests
 * them explicitly.
 */
async function approveInitialChatServiceApprovals(testApp: TestApp): Promise<void> {
  const targetCapabilities = new Set(["workspace-service:models", "workspace-service:channel"]);
  const deadline = Date.now() + 120_000;
  let lastTargetSeenAt = Date.now();
  const clickedApprovalIds = new Set<string>();

  while (Date.now() < deadline) {
    const pending = await listPendingApprovals(testApp);
    const pendingTargetIds = new Set(
      pending
        .filter(
          (approval) =>
            approval.kind === "capability" && targetCapabilities.has(approval.capability)
        )
        .map((approval) => approval.approvalId)
    );
    for (const approvalId of clickedApprovalIds) {
      if (!pendingTargetIds.has(approvalId)) clickedApprovalIds.delete(approvalId);
    }
    const targets = pending.filter(
      (approval) =>
        approval.kind === "capability" &&
        targetCapabilities.has(approval.capability) &&
        !clickedApprovalIds.has(approval.approvalId)
    );
    if (targets.length > 0) {
      lastTargetSeenAt = Date.now();
      try {
        await expect
          .poll(
            () =>
              clickShellButtonByPreference(
                testApp,
                [/^Trust(?: this)? version$/, /^Use this session$/],
                targets[0]!.approvalId
              ),
            { timeout: 30_000, intervals: [250, 500, 1_000, 2_000] }
          )
          .toBe(true);
        clickedApprovalIds.add(targets[0]!.approvalId);
      } catch (error) {
        await attachStartupDiagnostics(testApp);
        throw error;
      }
      continue;
    }
    // Install-review trust may already cover these exact service versions, in
    // which case no per-use card is expected. A bounded quiet queue is the
    // contract; the completion poll below continues draining any late card.
    if (Date.now() - lastTargetSeenAt >= 10_000) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for the initial chat service approvals to settle: ${JSON.stringify({
      pending: (await listPendingApprovals(testApp)).map((approval) => ({
        ...approval,
        parts: undefined,
      })),
      capabilityUi: await capabilityApprovalUiSnapshot(testApp),
      shell: (await listShellDomSnapshots(testApp)).map((snapshot) => ({
        title: snapshot.title,
        url: snapshot.url,
        hasApprovalBar: snapshot.hasApprovalBar,
        buttons: snapshot.buttons,
        textTail: snapshot.text.slice(-800),
      })),
    })}`
  );
}

/**
 * A chat can request its channel in phases: the initial resolveService call
 * creates the first approval, while replay/participant reads can create a
 * second one after the first turn has started. Keep the user-facing E2E flow
 * advancing that same visible approval rather than treating the late request
 * as an agent failure.
 */
async function approvePendingChatServiceApprovalIfPresent(testApp: TestApp): Promise<boolean> {
  const targetCapabilities = new Set(["workspace-service:models", "workspace-service:channel"]);
  const approval = (await listPendingApprovals(testApp)).find(
    (candidate) =>
      candidate.kind === "capability" &&
      typeof candidate.capability === "string" &&
      targetCapabilities.has(candidate.capability)
  );
  if (!approval) return false;
  return clickShellButtonByPreference(
    testApp,
    [/^Trust(?: this)? version$/, /^Use this session$/],
    approval.approvalId
  );
}

test.describe("Desktop Startup Approvals", () => {
  test.setTimeout(360_000);

  let testApp: TestApp | undefined;
  let workspaceDir: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
    if (workspaceDir) {
      removeManagedTestWorkspace(workspaceDir);
      workspaceDir = undefined;
    }
  });

  test("launch gate starts shell, then in-app approvals unblock initial chats", async () => {
    let configuredInitialPrompt = "";
    workspaceDir = createManagedTestWorkspace({
      configureSource: (sourceRoot) => {
        configuredInitialPrompt = configureWorkspaceSourceForApproval(sourceRoot);
      },
    });
    await seedOpenAiCodexCredential(workspaceDir);

    testApp = await launchTestApp({
      workspace: workspaceDir,
      launchTimeout: 240_000,
    });

    await reachHostedShellAndDrainStartupApprovals(testApp);
    await approveInitialChatServiceApprovals(testApp);

    let lastCompletion: StartupAgentCompletionState | null = null;
    try {
      await expect
        .poll(
          async () => {
            await approvePendingChatServiceApprovalIfPresent(testApp!);
            const state = await collectStartupAgentCompletion(testApp!, configuredInitialPrompt);
            lastCompletion = state;
            const failures = state.channels.flatMap((channel) => channel.failures);
            if (failures.length > 0) {
              throw new Error(`Initial agent turn failed: ${failures.join("; ")}`);
            }
            const closedWithoutOnboarding = state.channels.find(
              (channel) =>
                channel.assistantCompleted &&
                channel.turnClosed &&
                channel.pendingWork.length === 0 &&
                !channel.onboardingSkillReadCompleted
            );
            if (closedWithoutOnboarding) {
              throw new Error(
                `Initial agent turn closed without a completed onboarding read: ${JSON.stringify(
                  closedWithoutOnboarding.invocations
                )}`
              );
            }
            const unexpectedErrors = state.errors.filter(
              (error) => !/authority acquisition required/u.test(error)
            );
            if (unexpectedErrors.length > 0) {
              throw new Error(`Initial agent inspection failed: ${unexpectedErrors.join("; ")}`);
            }
            return state.complete;
          },
          {
            timeout: 120_000,
            intervals: [1000, 2000, 5000],
          }
        )
        .toBe(true);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      const [pending, panels] = await Promise.all([
        listPendingApprovals(testApp).catch(() => []),
        getPanelTree(testApp.app).catch(() => []),
      ]);
      throw new Error(
        `Initial chat did not complete: ${JSON.stringify({
          completion: lastCompletion,
          pending: pending.map((approval) => ({
            approvalId: approval.approvalId,
            kind: approval.kind,
            capability: approval.capability,
            title: approval.title,
          })),
          panels: panels.map((panel) => ({
            id: panel.id,
            title: panel.title,
            snapshot: panel.snapshot,
          })),
        })}\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  test("an ongoing agent chat pauses for scoped network authority and resumes the same turn", async () => {
    const prompt =
      "Read skills/onboarding/SKILL.md first. Then run a short sandbox eval that fetches https://example.com and tell me the page title.";
    workspaceDir = createManagedTestWorkspace({
      configureSource: (sourceRoot) => {
        configureWorkspaceSourceForApproval(sourceRoot, prompt);
      },
    });
    await seedOpenAiCodexCredential(workspaceDir);

    testApp = await launchTestApp({
      workspace: workspaceDir,
      launchTimeout: 240_000,
    });
    await reachHostedShellAndDrainStartupApprovals(testApp);
    await approveInitialChatServiceApprovals(testApp);

    let networkApproval: PendingApproval | undefined;
    try {
      await expect
        .poll(
          async () => {
            networkApproval = (await listPendingApprovals(testApp!)).find(
              (approval) =>
                approval.kind === "capability" &&
                approval.capability === "network.response.read" &&
                approval.resource?.value === "https://example.com"
            );
            if (!networkApproval) {
              const completion = await collectStartupAgentCompletion(testApp!, prompt);
              const failures = completion.channels.flatMap((channel) => channel.failures);
              if (failures.length > 0) {
                throw new Error(`Agent failed before authority approval: ${failures.join("; ")}`);
              }
              if (completion.complete) {
                throw new Error(
                  "Agent turn completed without requesting network.response.read authority"
                );
              }
            }
            return networkApproval;
          },
          { timeout: 120_000, intervals: [500, 1000, 2000, 5000] }
        )
        .toBeTruthy();
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    expect(networkApproval).toMatchObject({
      kind: "capability",
      capability: "network.response.read",
      title: "Connect to https://example.com",
      resource: {
        type: "url-origin",
        label: "Website",
        value: "https://example.com",
      },
      allowedDecisions: ["once", "session", "task", "deny"],
    });

    let rendered: Awaited<ReturnType<typeof capabilityApprovalUiSnapshot>> = null;
    await expect
      .poll(
        async () => {
          rendered = await capabilityApprovalUiSnapshot(testApp!, networkApproval!.approvalId);
          return rendered?.text ?? "";
        },
        { timeout: 45_000, intervals: [250, 500, 1000, 2000] }
      )
      .toContain("Connect to example.com");
    expect(rendered?.buttons).toEqual(
      expect.arrayContaining([
        "Connect once",
        "Allow this site",
        "Allow for this task",
        "Don't allow",
      ])
    );
    expect(rendered?.buttons).not.toContain("Always for AI Chat");
    expect(rendered?.buttons).not.toContain("Don't allow and don't ask again");
    expect(rendered?.buttons).not.toContain("Trust this version");
    expect(rendered).toMatchObject({
      role: "dialog",
      labelledByText: "Connect to example.com",
      keyboardShortcuts: "Enter D Escape ArrowLeft ArrowRight",
    });
    expect(rendered?.describedByText.length).toBeGreaterThan(0);

    expect(await clickShellButton(testApp, /^Connect once$/, networkApproval.approvalId)).toBe(
      true
    );
    await expect
      .poll(
        async () =>
          (await listPendingApprovals(testApp!)).some(
            (approval) => approval.approvalId === networkApproval?.approvalId
          ),
        { timeout: 15_000, intervals: [250, 500, 1000] }
      )
      .toBe(false);

    try {
      await expect
        .poll(
          async () => {
            const state = await collectStartupAgentCompletion(testApp!, prompt);
            const failures = state.channels.flatMap((channel) => channel.failures);
            if (failures.length > 0) {
              throw new Error(`Authority-resumed chat turn failed: ${failures.join("; ")}`);
            }
            return state.complete;
          },
          { timeout: 120_000, intervals: [1000, 2000, 5000] }
        )
        .toBe(true);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }
  });

  test("persisted startup trust survives a same-workspace warm launch with scoped app RPC", async () => {
    // Keep this lifecycle test independent of model credentials and agent
    // execution: it targets the app/extension startup grant and exact shell
    // incarnation restored on the second process.
    workspaceDir = createManagedTestWorkspace({
      configureSource: (sourceRoot) => {
        configureWorkspaceSourceForApproval(sourceRoot);
        const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
        const config = (YAML.parse(fsSync.readFileSync(configPath, "utf8")) ?? {}) as {
          initPanels?: unknown[];
        };
        config.initPanels = [];
        fsSync.writeFileSync(configPath, YAML.stringify(config), "utf8");
      },
    });

    testApp = await launchTestApp({ workspace: workspaceDir, launchTimeout: 240_000 });
    try {
      const firstLaunchReviews = await reachHostedShellAndDrainStartupApprovals(testApp);
      expect(firstLaunchReviews.length).toBeGreaterThan(0);
      expect(await callHostedShellService(testApp, "app.getInfo")).toMatchObject({
        connectionMode: "local",
        connectionStatus: "connected",
      });
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    await testApp.cleanup();
    testApp = undefined;

    testApp = await launchTestApp({ workspace: workspaceDir, launchTimeout: 240_000 });
    const secondLaunchApprovalObservations: string[] = [];
    try {
      await expect
        .poll(
          async () => {
            const pending = await listPendingApprovals(testApp!);
            const unitApprovals = pending.filter(isUnitBatchApproval).map(describeApproval);
            if (unitApprovals.length > 0) {
              secondLaunchApprovalObservations.push(...unitApprovals);
            }
            if (await shellHasApprovalUi(testApp!)) {
              secondLaunchApprovalObservations.push("approval UI became visible");
            }
            return hostedShellHasChrome(testApp!);
          },
          { timeout: 180_000, intervals: [250, 500, 1000, 2000] }
        )
        .toBe(true);

      expect(secondLaunchApprovalObservations).toEqual([]);
      expect(
        (await listPendingApprovals(testApp)).filter(isUnitBatchApproval).map(describeApproval)
      ).toEqual([]);
      expect(await callHostedShellService(testApp, "app.getInfo")).toMatchObject({
        connectionMode: "local",
        connectionStatus: "connected",
      });
      expect(
        (await listPendingApprovals(testApp)).filter(isUnitBatchApproval).map(describeApproval)
      ).toEqual([]);
      const authorityFailureLines = testApp
        .getOutput()
        .split(/\r?\n/)
        .filter(
          (line) =>
            /missing-grant/i.test(line) ||
            /sealed.{0,40}incarnation|incarnation.{0,40}sealed/i.test(line)
        );
      expect(authorityFailureLines).toEqual([]);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }
  });
});
