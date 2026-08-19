import { describe, expect, it } from "vitest";
import {
  createShellSurfaceLink,
  parseShellSurfaceLink,
  validateShellSurfaceTarget,
} from "./shellSurface";

describe("shell surface targets", () => {
  it("normalizes and validates every kind", () => {
    expect(validateShellSurfaceTarget("workspace-chooser")).toEqual({ kind: "workspace-chooser" });
    expect(validateShellSurfaceTarget({ kind: "about", page: "permissions" })).toEqual({
      kind: "about",
      page: "permissions",
    });
    expect(
      validateShellSurfaceTarget({ kind: "command-agent", prompt: "hi", mode: "quickfire" })
    ).toEqual({ kind: "command-agent", prompt: "hi", mode: "quickfire" });
    expect(() => validateShellSurfaceTarget({ kind: "about", page: "../x" })).toThrow(/About page/);
    expect(() => validateShellSurfaceTarget({ kind: "command-agent", autoSend: true })).toThrow(
      /does not accept/
    );
    expect(() => validateShellSurfaceTarget({ kind: "panel-command", panelId: "p" })).toThrow(
      /commandId/
    );
    expect(() => validateShellSurfaceTarget("invented")).toThrow(/Unknown shell surface/);
  });

  it("round-trips deep links on both carriers", () => {
    const targets = [
      {
        kind: "command-agent",
        panelId: "panel:tree/a~b/c",
        mode: "quickfire",
        prompt: "Add a scene — “ok”?",
      },
      { kind: "about", page: "credentials" },
      { kind: "panel-command", panelId: "panel:tree/x", commandId: "tour-next" },
      { kind: "connection-settings" },
    ] as const;
    for (const target of targets) {
      for (const carrier of ["scheme", "https"] as const) {
        const link = createShellSurfaceLink(target, carrier);
        expect(parseShellSurfaceLink(link)).toEqual({ kind: "ok", target, carrier });
      }
    }
    expect(createShellSurfaceLink({ kind: "about", page: "permissions" })).toBe(
      "vibestudio://about?v=1&page=permissions"
    );
  });

  it("distinguishes unrelated links from malformed ones", () => {
    expect(parseShellSurfaceLink("vibestudio://panel?v=1&source=panels/tour")).toEqual({
      kind: "unrelated",
    });
    expect(parseShellSurfaceLink("vibestudio://connect?room=x")).toEqual({ kind: "unrelated" });
    expect(parseShellSurfaceLink("https://vibestudio.app/pair#x")).toEqual({ kind: "unrelated" });
    expect(parseShellSurfaceLink("vibestudio://about?v=2&page=permissions").kind).toBe("error");
    expect(parseShellSurfaceLink("vibestudio://ask?v=1&prompt=hi&auto=1").kind).toBe("error");
    expect(parseShellSurfaceLink("https://vibestudio.app/about?page=x#v=1").kind).toBe("error");
  });
});
