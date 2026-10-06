import { expect, test } from "@playwright/test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { inspectNativeApprovalInvocation } from "../../fixtures/nativeApprovalEvidence.js";
import type { PanelReadinessSnapshot } from "../../../src/main/panelReadiness.js";

import {
  NATIVE_APPROVAL_MODEL,
  NATIVE_APPROVAL_REPLY,
  writeNativeApprovalModelProvider,
  writeNativeApprovalReviewExtension,
} from "../../fixtures/nativeApprovalModelProvider";
import { HostLaunchClient } from "@vibestudio/service-schemas/clients/hostLaunchClient";
import { RuntimeSupervisionDescriptionSchema } from "@vibestudio/service-schemas/runtime";
import {
  createManagedTestWorkspace,
  callTestApi,
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
import { declineFirstRunReporting } from "../support/workspaceCreation";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type PendingApproval = {
  approvalId: string;
  workspaceId: string;
  kind: string;
  title?: string;
  capability?: string;
  credentialLabel?: string;
  allowedDecisions?: string[];
  resource?: { type?: string; label?: string; value?: string };
  parts?: Array<{ kind: string; name: string; target?: string | null }>;
};

function configureWorkspaceSourceForApproval(
  sourceRoot: string,
  initialPromptOverride?: string
): string {
  const providerRepo = writeNativeApprovalModelProvider(sourceRoot);
  writeNativeApprovalReviewExtension(sourceRoot);
  const configPath = path.join(sourceRoot, "meta", "vibestudio.yml");
  const config = (YAML.parse(fsSync.readFileSync(configPath, "utf8")) ?? {}) as {
    template?: { repositories?: string[] };
    defaultAgentConfig?: { model?: string };
    extensions?: unknown[];
    initPanels?: Array<{ source?: string; stateArgs?: Record<string, unknown> }>;
  };
  const repositories = config.template?.repositories;
  if (!Array.isArray(repositories)) {
    throw new Error("Expected the workspace template to declare its repositories");
  }
  if (!repositories.includes("extensions/e2e-approval")) {
    repositories.push("extensions/e2e-approval");
  }
  if (!repositories.includes(providerRepo)) repositories.push(providerRepo);
  config.defaultAgentConfig = {
    ...config.defaultAgentConfig,
    model: NATIVE_APPROVAL_MODEL,
  };
  config.extensions = [
    ...(Array.isArray(config.extensions) ? config.extensions : []),
    { source: "extensions/e2e-approval" },
    { source: providerRepo },
  ];
  // Exercise the shipped onboarding contract itself. This test must not inject
  // a substitute prompt: doing so would hide a template regression where the
  // configured first turn disappears and the lazy chat correctly stays idle.
  const initialChat = config.initPanels?.find((panel) => panel.source === "panels/chat");
  if (!initialChat) throw new Error("Expected an initial chat panel in the workspace config");
  const seed = initialChat.stateArgs?.["seed"] as
    | { messages?: unknown[]; openingRequest?: string }
    | undefined;
  const initialPrompt = seed?.openingRequest;
  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    throw new Error(
      "Expected the shipped initial chat panel to declare a non-empty seed.openingRequest"
    );
  }
  if (initialPromptOverride !== undefined) {
    initialChat.stateArgs = {
      ...initialChat.stateArgs,
      seed: { ...seed, openingRequest: initialPromptOverride },
    };
  }
  fsSync.writeFileSync(configPath, YAML.stringify(config), "utf8");
  return initialPromptOverride ?? initialPrompt;
}

async function listPendingApprovals(testApp: TestApp): Promise<PendingApproval[]> {
  const owners = [...new Set([testApp.systemWorkspaceId, testApp.workspaceId])];
  return (
    await Promise.all(
      owners.map(async (workspaceId) => {
        const pending = (await rpcCall(
          testApp,
          "shellApproval",
          "listPending",
          [],
          workspaceId
        )) as PendingApproval[];
        return pending.map((approval) => ({ ...approval, workspaceId }));
      })
    )
  ).flat();
}

async function rpcCall(
  testApp: TestApp,
  service: string,
  method: string,
  args: unknown[] = [],
  workspaceId = testApp.workspaceId
): Promise<unknown> {
  return callTestApi({ app: testApp.app, workspaceId: workspaceId }, "rpcCall", [
    service,
    method,
    args,
  ]);
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

async function hostedShellHasChrome(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) =>
          !candidate.isDestroyed() &&
          candidate.getTitle() === "@workspace-apps/shell" &&
          !candidate.getURL().includes("overlaySurface=")
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
            !candidate.isDestroyed() &&
            candidate.getTitle() === "@workspace-apps/shell" &&
            !candidate.getURL().includes("overlaySurface=")
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
                ?? (label.test("Remember for this version") || label.test("Trust version") || label.test("Trust this version")
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
  const extensionOwners = await Promise.all(
    [...new Set([testApp.workspaceId, testApp.systemWorkspaceId])].map(async (workspaceId) => {
      const config = await rpcCall(testApp, "workspace", "getConfig", [], workspaceId)
        .then((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("The owning workspace did not return its effective configuration");
          const config = value as Record<string, unknown>;
          return {
            extensions: config["extensions"],
            hostTargets: config["hostTargets"],
            defaultAgentConfig: config["defaultAgentConfig"],
          };
        })
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
      const extensions = await rpcCall(
        testApp,
        "runtime",
        "supervision.list",
        [{ kind: "extension" }],
        workspaceId
      )
        .then((value) => RuntimeSupervisionDescriptionSchema.array().parse(value))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
      return { workspaceId, config, extensions };
    })
  );
  const pending = await listPendingApprovals(testApp).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const launchResult = await new HostLaunchClient((service, method, args) =>
    rpcCall(testApp, service, method, args, testApp.systemWorkspaceId)
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
  const panels = await getPanelTree(testApp).catch(() => []);
  const panelDetails = [];
  const channelNames: string[] = [];
  for (const panel of panels) {
    const id = panel.id;
    const text = await getPanelText(testApp, id).catch((error: unknown) =>
      error instanceof Error ? `ERROR: ${error.message}` : `ERROR: ${String(error)}`
    );
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.["channelName"] === "string"
        ? stateArgs["channelName"]
        : text.match(/\bchat-[a-z0-9]+\b/)?.[0];
    if (channelName) channelNames.push(channelName);
    panelDetails.push({
      id,
      title: panel.title,
      snapshot: panel.snapshot,
      source: panel.snapshot?.source,
      text,
      boot: await executePanelScript(
        testApp,
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
      htmlSummary: await getPanelHtml(testApp, id)
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
      diagnostics: await getPanelDiagnostics(testApp, id).catch(() => []),
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
            testApp,
            firstPanelId,
            `globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(targetId)}, "getParticipants", []))`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    const replay =
      targetId && firstPanelId
        ? await executePanelScript(
            testApp,
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
                content: String(event.payload?.payload?.blocks?.filter((block) => block.type === "text").map((block) => block.content).join("\n") ?? "").slice(0, 300),
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
            testApp,
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
    extensionOwners,
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
    nativeSettled: boolean;
    networkInvocationIds: string[];
    completedNetworkInvocationIds: string[];
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
      nativeSource: boundedEventValue(event["nativeSource"]),
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
  const panels = await getPanelTree(testApp).catch(() => []);
  const firstPanelId = panels[0]?.id;
  const channelNames = new Set<string>();
  for (const panel of panels) {
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.["channelName"] === "string"
        ? stateArgs["channelName"]
        : (await getPanelText(testApp, panel.id).catch(() => "")).match(/\bchat-[a-z0-9]+\b/)?.[0];
    if (channelName) channelNames.add(channelName);
  }
  if (!firstPanelId) {
    return { complete: false, channels: [], errors: ["No panel is available for RPC inspection"] };
  }
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
        nativeSettled: false,
        networkInvocationIds: [],
        completedNetworkInvocationIds: [],
        pendingWork: [],
        failures: ["Channel service target was not resolved"],
        invocations: [],
      });
      continue;
    }

    const snapshot = await executePanelScript(
      testApp,
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
          const agentic = event?.payload;
          if (!agentic || !["message.completed", "invocation.started", "invocation.completed", "invocation.failed"].includes(agentic.kind)) return null;
          if (!agentic.actor || !agentic.payload)
            throw new Error("Canonical agentic record has no actor or payload");
          const body = agentic.payload;
          const rawBlocks = Array.isArray(body.blocks) ? body.blocks : [];
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
            role: body.role,
            name: body?.name,
            nativeSource: body.nativeSource,
            transport: body.transport,
            result: await hydrateStoredValue(body?.result),
            terminalOutcome: body?.terminalOutcome,
            content: typeof body.content === "string" ? body.content : "",
            outcome: body.outcome,
            failure: body.failure,
            metadata: body.metadata,
            reason: body?.reason,
            error: body?.error,
            recoverable: body?.recoverable,
            blocks,
          };
        };
        const [participants, replay] = await Promise.all([
          rpc.call(${JSON.stringify(targetId)}, "getParticipants", []),
          rpc.call(${JSON.stringify(targetId)}, "getReplayAfter", [{ after: 0 }]),
        ]);
        return {
          participants,
          events: (await Promise.all((replay?.logEvents ?? []).map(normalize))).filter((event) => event !== null),
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
    const events = channelEvents;
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
    const nativeInvocations = events
      .filter((event) => event["kind"] === "invocation.started" && isAgentEvent(event))
      .flatMap((event) => {
        const inspected = inspectNativeApprovalInvocation(event, channelName);
        return inspected ? [{ event, ...inspected }] : [];
      });
    const originalReadDigest = createHash("sha256")
      .update(JSON.stringify({ path: "skills/onboarding/SKILL.md" }))
      .digest("hex");
    const onboardingReadInvocationIds = new Set(
      nativeInvocations
        .filter(
          ({ source }) =>
            source.operation.kind === "tool" &&
            source.operation.name === "read" &&
            source.operation.argumentsDigest === originalReadDigest
        )
        .map(({ invocationId }) => invocationId)
    );
    const networkInvocationIds = [
      ...new Set(
        nativeInvocations
          .filter(
            ({ source }) => source.operation.kind === "tool" && source.operation.name === "eval"
          )
          .map(({ invocationId }) => invocationId)
      ),
    ];
    const completedNetworkInvocationIds = networkInvocationIds.filter((invocationId) =>
      events.some(
        (event) =>
          event["kind"] === "invocation.completed" &&
          event["terminalOutcome"] === "success" &&
          event["invocationId"] === invocationId &&
          isAgentEvent(event)
      )
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
          (block as { content: string }).content === NATIVE_APPROVAL_REPLY
      );
    });
    const failures = events
      .filter((event) => {
        if (!isAgentEvent(event)) return false;
        if (event["kind"] === "invocation.failed") {
          return true;
        }
        return (
          event["kind"] === "message.completed" &&
          (event["failure"] !== undefined ||
            event["outcome"] === "empty" ||
            event["outcome"] === "interrupted")
        );
      })
      .map(
        (event) =>
          `${String(event["kind"])}:${String(event["outcome"] ?? "")}:` +
          `${String(event["reason"] ?? "")}:` +
          `${JSON.stringify(event["failure"] ?? event["error"] ?? event["result"] ?? null)}`
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
    let nativeSettled = observedAgentIds.size > 0;
    for (const agentId of observedAgentIds) {
      const debugState = await executePanelScript(
        testApp,
        firstPanelId,
        `globalThis.__vibestudioRequireAsync__("@workspace/runtime").then(({ rpc }) => rpc.call(${JSON.stringify(agentId)}, "getDebugState", [${JSON.stringify(channelName)}]))`
      );
      const state = (debugState as { result?: unknown } | null)?.result ?? debugState;
      const inspection =
        state && typeof state === "object"
          ? (
              state as {
                conversations?: Record<
                  string,
                  {
                    loaded?: boolean;
                    conversationId?: unknown;
                    live?: { run?: unknown };
                    tasks?: unknown[];
                    submissions?: unknown[];
                    observation?: unknown;
                  }
                >;
              }
            ).conversations?.[channelName]
          : undefined;
      if (
        !inspection ||
        inspection.loaded !== true ||
        typeof inspection.conversationId !== "number" ||
        !inspection.live ||
        !Array.isArray(inspection.tasks) ||
        !Array.isArray(inspection.submissions)
      ) {
        nativeSettled = false;
        pendingWork.push(
          `${agentId}:native-inspection:${String(inspection?.observation ?? "missing")}`
        );
        continue;
      }
      if (inspection.live.run || inspection.tasks.length || inspection.submissions.length) {
        nativeSettled = false;
        pendingWork.push(`${agentId}:native-owned-work:${JSON.stringify(inspection)}`);
      }
    }

    channels.push({
      channelName,
      agentIds: Array.from(observedAgentIds),
      initialPromptDelivered,
      onboardingSkillReadCompleted,
      assistantCompleted,
      nativeSettled,
      networkInvocationIds,
      completedNetworkInvocationIds,
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
        channel.nativeSettled &&
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
    testApp,
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

async function reachHostedShellAndDrainStartupApprovals(testApp: TestApp): Promise<string[]> {
  const observedInstallReviews = new Set<string>();
  const startupState: { current: "approval" | "ready" | "waiting" } = { current: "waiting" };
  try {
    await expect
      .poll(
        async () => {
          const pending = await listPendingApprovals(testApp);
          for (const approval of pending.filter(isUnitBatchApproval)) {
            observedInstallReviews.add(describeApproval(approval));
          }
          if (pending.some(isElectronHostAppApproval) && (await shellHasApprovalUi(testApp))) {
            startupState.current = "approval";
            return startupState.current;
          }
          if (await hostedShellHasChrome(testApp)) {
            startupState.current = "ready";
            return startupState.current;
          }
          startupState.current = "waiting";
          return startupState.current;
        },
        { timeout: 90_000, intervals: [500, 1000, 2000] }
      )
      .not.toBe("waiting");
  } catch (error) {
    await attachStartupDiagnostics(testApp);
    throw error;
  }

  if (startupState.current === "approval") {
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

  for (const panel of await getPanelTree(testApp)) {
    await startPanelDiagnostics(testApp, panel.id).catch(() => {});
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
    const pendingTargetCount = pendingUnitBatchCount;
    if (pendingTargetCount === 0) break;
    if (pendingUnitBatchCount > 0) {
      // The install review's real click path is covered by the desktop pairing
      // smoke. This launch-gate spec is about the subsequent agent lifecycle;
      // resolve the one-time workspace adoption through the typed host helper
      // so a large full-surface render cannot make this fixture race its own
      // startup transition.
      for (const workspaceId of new Set(
        pendingInstallReviews.map((approval) => approval.workspaceId)
      )) {
        await approvePendingWorkspaceCreationReview(
          { app: testApp.app, workspaceId: workspaceId },
          pendingInstallReviews
            .filter((approval) => approval.workspaceId === workspaceId)
            .map(({ approvalId }) => approvalId)
        );
      }
    }
    await expect
      .poll(
        async () => {
          const next = await listPendingApprovals(testApp);
          return next.filter(isUnitBatchApproval).length;
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
  await declineFirstRunReporting(testApp);
  return [...observedInstallReviews];
}

/** Ordinary declared service access is covered by the accepted installation.
 * Approving it again here would make a missing admission grant look like a
 * successful onboarding run. Credential and network decisions remain explicit
 * in the scenarios that exercise those contextual permissions.
 */
async function assertNoUnexpectedChatServiceApprovals(testApp: TestApp): Promise<void> {
  const capabilities = new Set(["workspace-service:models", "workspace-service:channel"]);
  const unexpected = (await listPendingApprovals(testApp))
    .filter(
      (approval) =>
        approval.kind === "capability" &&
        typeof approval.capability === "string" &&
        capabilities.has(approval.capability)
    )
    .map(({ approvalId, capability }) => ({ approvalId, capability }));
  expect(unexpected, "Installation must grant the initial chat's declared service access").toEqual(
    []
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
    workspaceDir = await createManagedTestWorkspace({
      workspaceKind: "personal",
      configureSource: (sourceRoot) => {
        configuredInitialPrompt = configureWorkspaceSourceForApproval(sourceRoot);
      },
    });

    testApp = await launchTestApp({
      workspace: workspaceDir,
      launchTimeout: 240_000,
    });

    await reachHostedShellAndDrainStartupApprovals(testApp);
    await assertNoUnexpectedChatServiceApprovals(testApp);

    let lastCompletion: StartupAgentCompletionState | null = null;
    try {
      await expect
        .poll(
          async () => {
            await assertNoUnexpectedChatServiceApprovals(testApp!);
            const state = await collectStartupAgentCompletion(testApp!, configuredInitialPrompt);
            lastCompletion = state;
            const failures = state.channels.flatMap((channel) => channel.failures);
            if (failures.length > 0) {
              throw new Error(`Initial agent turn failed: ${failures.join("; ")}`);
            }
            const closedWithoutOnboarding = state.channels.find(
              (channel) =>
                channel.assistantCompleted &&
                channel.nativeSettled &&
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

      const onboardingPanel = (await getPanelTree(testApp)).find(
        (panel) =>
          panel.snapshot?.source === "panels/chat" &&
          (panel.snapshot.stateArgs?.["seed"] as { openingRequest?: string } | undefined)
            ?.openingRequest === configuredInitialPrompt
      );
      if (!onboardingPanel) throw new Error("The automatic onboarding panel disappeared");
      await expect
        .poll(
          () =>
            executePanelScript<boolean>(
              testApp!,
              onboardingPanel.id,
              `(() => {
                const overview = document.querySelector(
                  '[data-inline-ui-id="onboarding-setup-overview"]'
                );
                if (!(overview instanceof HTMLElement)) return false;
                overview.scrollIntoView({ block: "start" });
                const bounds = overview.getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0 && bounds.top < innerHeight && bounds.bottom > 0
                  && overview.innerText.includes("Your Vibestudio")
                  && Boolean(overview.querySelector('[aria-label="Refresh setup overview"]'));
              })()`
            ),
          { timeout: 30_000, intervals: [250, 500, 1000] }
        )
        .toBe(true);
      expect(
        await executePanelScript<boolean>(
          testApp,
          onboardingPanel.id,
          `(() => {
            const link = Array.from(document.querySelectorAll('a')).find(
              (candidate) => candidate.textContent?.trim() === 'Add workspace'
            );
            if (!(link instanceof HTMLAnchorElement)) return false;
            link.click();
            return true;
          })()`
        )
      ).toBe(true);
      let chooserPage: import("@playwright/test").Page | undefined;
      await expect
        .poll(
          async () => {
            for (const page of testApp!.app.context().pages()) {
              if (
                await page
                  .getByRole("dialog", { name: "Create a workspace", exact: true })
                  .isVisible()
              ) {
                chooserPage = page;
                return true;
              }
            }
            return false;
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      await chooserPage!
        .getByRole("button", { name: "Close workspace setup", exact: true })
        .click();
      const readiness = await callTestApi<PanelReadinessSnapshot>(testApp, "getPanelReadiness", [
        onboardingPanel.id,
      ]);
      if (readiness.presentation.state !== "ready") {
        throw new Error("The completed onboarding panel lost its native presentation");
      }
      const screenshot = await testApp.app.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (!contents || contents.isDestroyed())
          throw new Error("Onboarding native view disappeared");
        return (await contents.capturePage()).toPNG().toString("base64");
      }, readiness.presentation.webContentsId);
      const screenshotPath = test.info().outputPath("personal-onboarding-complete.png");
      fsSync.writeFileSync(screenshotPath, Buffer.from(screenshot, "base64"), { mode: 0o600 });
      await test.info().attach("personal-onboarding-complete", {
        path: screenshotPath,
        contentType: "image/png",
      });
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      const [pending, panels] = await Promise.all([
        listPendingApprovals(testApp).catch(() => []),
        getPanelTree(testApp).catch(() => []),
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
    workspaceDir = await createManagedTestWorkspace({
      workspaceKind: "personal",
      configureSource: (sourceRoot) => {
        configureWorkspaceSourceForApproval(sourceRoot, prompt);
      },
    });

    testApp = await launchTestApp({
      workspace: workspaceDir,
      launchTimeout: 240_000,
    });
    await reachHostedShellAndDrainStartupApprovals(testApp);
    await assertNoUnexpectedChatServiceApprovals(testApp);

    let networkApproval: PendingApproval | undefined;
    try {
      await expect
        .poll(
          async () => {
            await assertNoUnexpectedChatServiceApprovals(testApp!);
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

    if (!networkApproval) throw new Error("Expected the pending network approval");
    const paused = await collectStartupAgentCompletion(testApp, prompt);
    const originalNetworkInvocations = paused.channels.flatMap(
      (channel) => channel.networkInvocationIds
    );
    expect(originalNetworkInvocations).toHaveLength(1);
    expect(paused.complete).toBe(false);
    expect(paused.channels.flatMap((channel) => channel.completedNetworkInvocationIds)).toEqual([]);
    expect(networkApproval).toMatchObject({
      kind: "capability",
      capability: "network.response.read",
      title: "Connect to https://example.com",
      resource: {
        type: "url-origin",
        label: "Website",
        value: "https://example.com",
      },
      allowedDecisions: ["once", "task", "deny"],
    });

    const rendered: { current: Awaited<ReturnType<typeof capabilityApprovalUiSnapshot>> } = {
      current: null,
    };
    await expect
      .poll(
        async () => {
          rendered.current = await capabilityApprovalUiSnapshot(
            testApp!,
            networkApproval!.approvalId
          );
          return rendered.current?.text ?? "";
        },
        { timeout: 45_000, intervals: [250, 500, 1000, 2000] }
      )
      .toContain("Connect to example.com");
    expect(rendered.current?.buttons).toEqual(
      expect.arrayContaining(["Connect once", "Allow for this task", "Don't allow"])
    );
    expect(rendered.current?.buttons).not.toContain("Allow this site");
    expect(rendered.current?.buttons).not.toContain("Always for AI Chat");
    expect(rendered.current?.buttons).not.toContain("Don't allow and stop asking");
    expect(rendered.current?.buttons).not.toContain("Remember for this version");
    expect(rendered.current).toMatchObject({
      role: "dialog",
      labelledByText: "Connect to example.com",
      keyboardShortcuts: "Enter D Escape ArrowLeft ArrowRight",
    });
    expect(rendered.current?.describedByText.length).toBeGreaterThan(0);

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
            if (state.complete) {
              expect(state.channels.flatMap((channel) => channel.networkInvocationIds)).toEqual(
                originalNetworkInvocations
              );
              expect(
                state.channels.flatMap((channel) => channel.completedNetworkInvocationIds)
              ).toEqual(originalNetworkInvocations);
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
    // execution: it targets the workspace-creation grant for the app and the
    // exact shell incarnation restored on the second process.
    workspaceDir = await createManagedTestWorkspace({
      workspaceKind: "personal",
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
      await reachHostedShellAndDrainStartupApprovals(testApp);
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
