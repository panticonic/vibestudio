import { describe, expect, it } from "vitest";
import {
  authorHelloSource,
  editHelloSource,
  notificationText,
  systemWorkspaceName,
  visibleTexts,
} from "../scripts/cli/lib/mobile-smoke-client-dev.mjs";

describe("android client dev loop sources", () => {
  it("authors a client, its echo service and a default declaration, and publishes", () => {
    const source = authorHelloSource("n1");
    expect(source).toContain('projectType: "client", name: "hello-android"');
    expect(source).toContain('runtime: "rn-host-6"');
    expect(source).toContain("vibestudio.hello.v1#echo");
    expect(source).toContain('"context.boundary"'); // every React Native client owes it
    expect(source).toContain("android: clients/hello-android");
    expect(source).toContain("Hello n1");
    expect(source.trimEnd().split("\n").at(-1)).toContain("vcs.publish");
    // The generated worker is a template literal inside a template literal: the echo must survive both.
    expect(source).toContain("return \\`echo: \\${input.params.text}\\`;");
  });

  it("edits only the greeting and publishes", () => {
    const source = editHelloSource("n1");
    expect(source).toContain("Hello again n1");
    expect(source).toContain("vcs.publish");
    expect(source).not.toContain("prepareProjects");
  });

  it("finds the System workspace the CLI must work in", () => {
    expect(
      systemWorkspaceName({
        workspaces: [
          { name: "personal-ws_a", privateRole: "personal" },
          { name: "system-ws_b", privateRole: "system" },
        ],
      })
    ).toBe("system-ws_b");
    expect(() => systemWorkspaceName({ workspaces: [] })).toThrow(/no System workspace/);
  });

  it("reads texts from a uiautomator dump and a notification body from dumpsys", () => {
    expect(
      visibleTexts('<node text="Hello &amp; welcome" /><node text="" /><node text="Send" />')
    ).toEqual(["Hello & welcome", "Send"]);
    const dump = [
      "  NotificationRecord(0x1 pkg=app.vibestudio.mobile.internal user=UserHandle{0} id=7 tag=null importance=3)",
      "      extras={",
      "        android.title=String (Hello echo)",
      "        android.text=String (echo: ping-1)",
      "  NotificationRecord(0x2 pkg=other user=UserHandle{0} id=8 tag=null importance=3)",
      "        android.title=String (Hello echo)",
      "        android.text=String (not this)",
    ].join("\n");
    expect(notificationText(dump, "app.vibestudio.mobile.internal", "Hello echo")).toBe(
      "echo: ping-1"
    );
    expect(notificationText(dump, "app.vibestudio.mobile.internal", "Absent")).toBeNull();
  });
});
