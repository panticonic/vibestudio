import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PANEL_BOOTSTRAP_SCRIPT } from "./panelBootstrapScript.js";

describe("PANEL_BOOTSTRAP_SCRIPT", () => {
  it("publishes the authenticated workspace identity with panel runtime coordinates", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioWorkspaceId: cfg.workspaceId");
  });
  it("requires canonical entityId bootstrap identity without the old panelId alias", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("const entityId = cfg?.entityId;");
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain("cfg?.panelId");
  });

  it("publishes runtime lease fields before loading the WebSocket transport", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf("__vibestudioConnectionId")).toBeGreaterThan(-1);
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf('new URL("__transport.js"')).toBeGreaterThan(-1);
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf("__vibestudioConnectionId")).toBeLessThan(
      PANEL_BOOTSTRAP_SCRIPT.indexOf('new URL("__transport.js"')
    );
  });

  it("keeps runtime lease ids out of persisted/userland bootstrap state", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('url.searchParams.get("connectionId")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('typeof cfg?.connectionId === "string"');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("delete stored.connectionId");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("delete globalThis.__vibestudioConnectionId");
  });

  it("waits for a headless fallback transport before starting the panel bundle", () => {
    const ready = PANEL_BOOTSTRAP_SCRIPT.indexOf("__vibestudioShell.ready()");
    const bundle = PANEL_BOOTSTRAP_SCRIPT.indexOf('document.createElement("script")', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(ready);
  });

  it.each([false, true])(
    "holds bundle startup until state reconciliation, explicit override %s",
    async (override) => {
      const location = new URL("https://panel.example.test/");
      if (override)
        location.searchParams.set("stateArgs", JSON.stringify({ ownerStage: "override" }));
      let finishPreparation!: () => void;
      const pendingPreparation = new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      let preparationStarted!: () => void;
      const wasPreparing = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      const appendBundle = vi.fn();
      const prepare = vi.fn(async () => {
        preparationStarted();
        await pendingPreparation;
        realm.__vibestudioStateArgs = { ownerStage: "current" };
      });
      const realm = {
        URL,
        location,
        CustomEvent,
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        sessionStorage: { setItem: vi.fn() },
        document: {
          baseURI: location.href,
          createElement: () => ({}),
          head: { appendChild: (script: { onload: () => void }) => script.onload() },
          body: { appendChild: appendBundle },
        },
        __vibestudioPanelInit: {
          workspaceId: "workspace:test",
          entityId: "panel:nav-a",
          slotId: "panel:tree/a",
          gatewayConfig: { serverUrl: "https://host.example.test", token: "owned-test-grant" },
          stateArgs: { ownerStage: "stale-bootstrap" },
        },
        __vibestudioShell: { ready: async () => undefined },
        __vibestudioPreparePanelStateArgs: prepare,
        __vibestudioStateArgs: undefined as { ownerStage: string } | undefined,
      };

      const boot = runInNewContext(PANEL_BOOTSTRAP_SCRIPT, realm) as Promise<void>;
      if (!override) {
        await wasPreparing;
        expect(appendBundle).not.toHaveBeenCalled();
        finishPreparation();
      }
      await boot;

      expect(prepare).toHaveBeenCalledTimes(override ? 0 : 1);
      expect(appendBundle).toHaveBeenCalledOnce();
      expect(realm.__vibestudioStateArgs).toEqual({
        ownerStage: override ? "override" : "current",
      });
      expect(realm.__vibestudioPreparePanelStateArgs).toBeUndefined();
    }
  );

  it("keys persisted panel init by document URL instead of one shared session key", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain(
      'const storageKey = () => "__vibestudioPanelInit:" + location.href;'
    );
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("sessionStorage.getItem(storageKey())");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("sessionStorage.setItem(storageKey()");
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('sessionStorage.getItem("__vibestudioPanelInit")');
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('sessionStorage.setItem("__vibestudioPanelInit"');
  });

  it("renders a recovery surface when the generated panel bundle cannot load", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("bundle.onerror");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("The panel bundle could not be loaded.");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("Reload panel");
  });

  it("reports a transport script that cannot load as a bundle-load failure, not an entry throw", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain(
      'reportBoot("failed", new Error("The panel transport could not be loaded"), "bundle-load")'
    );
  });

  it("publishes a machine-readable boot handshake instead of using DOM presence as readiness", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioPanelBoot");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("loading")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("booting")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain(
      'globalThis.__vibestudioPanelMarkReady = () => reportBoot("ready")'
    );
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain("bundle.onload");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("failed"');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('"vibestudio:panel-boot"');
  });

  it("keeps a ready boot record terminal against later application errors", () => {
    // Post-ready unhandled rejections are app-runtime noise; the held record
    // must stay ready or host relay / restart re-adoption republishes failed.
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain(
      'if (previous?.phase === "ready" && phase === "failed") return previous;'
    );
  });

  it("ties the handshake to runtime and immutable build identity", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioEntityId");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioEffectiveVersion");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioBuildKey");
  });
});
