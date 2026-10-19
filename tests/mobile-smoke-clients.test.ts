import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientLink,
  clientTasks,
  ingressIntentArgs,
  newClientTask,
  parseShortcuts,
  taskIdsByActivity,
} from "../scripts/cli/lib/mobile-smoke-clients.mjs";

const PKG = "app.vibestudio.mobile.internal";
const dump = (rows: Array<[string, number]>) =>
  rows.map(([cls, task]) => `    * ActivityRecord{abc u0 ${PKG}/${cls} t${task} f}}`).join("\n");

describe("mobile smoke client surfaces", () => {
  it("reads task ids per activity of the app only", () => {
    const text = `${dump([
      ["app.vibestudio.mobile.MainActivity", 4],
      ["app.vibestudio.mobile.ClientActivity", 5],
    ])}\n * ActivityRecord{x u0 other.pkg/app.vibestudio.mobile.ClientActivity t9 f}}`;
    expect(taskIdsByActivity(text, PKG).get("app.vibestudio.mobile.ClientActivity")).toEqual(
      new Set([5])
    );
    expect(clientTasks(text, PKG)).toEqual(new Set([5]));
  });

  it("finds a client task that is neither the host's nor an earlier client's", () => {
    const before = dump([
      ["app.vibestudio.mobile.MainActivity", 4],
      ["app.vibestudio.mobile.ClientActivity", 5],
    ]);
    const same = newClientTask(before, PKG, clientTasks(before, PKG));
    expect(same).toBeNull();
    const after = `${before}\n${dump([["app.vibestudio.mobile.ClientActivity", 6]])}`;
    expect(newClientTask(after, PKG, clientTasks(before, PKG))).toBe(6);
    const sharedWithHost = dump([
      ["app.vibestudio.mobile.MainActivity", 4],
      ["app.vibestudio.mobile.ClientActivity", 4],
    ]);
    expect(newClientTask(sharedWithHost, PKG, new Set())).toBeNull();
  });

  it("parses dynamic, pinned and disabled shortcuts of the package", () => {
    const text = [
      `  Package: ${PKG}`,
      // As a real device prints it: the flag names run together.
      "    ShortcutInfo {id=vibestudio://c/chat/open, flags=0x85 [DynIc-rStr], packageName=x}",
      "    ShortcutInfo {id=vibestudio://c/old/open, flags=0x120 [Pin Dis], packageName=x}",
      "  Package: other",
      "    ShortcutInfo {id=zzz, flags=0x1 [Dyn], packageName=y}",
    ].join("\n");
    expect(parseShortcuts(text, PKG)).toEqual([
      { id: "vibestudio://c/chat/open", dynamic: true, pinned: false, disabled: false },
      { id: "vibestudio://c/old/open", dynamic: false, pinned: true, disabled: true },
    ]);
  });

  it("delivers the link to the ingress activity, as a launcher shortcut does", () => {
    expect(ingressIntentArgs(PKG, clientLink("chat"))).toEqual([
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "vibestudio://c/chat/open",
      "-n",
      `${PKG}/app.vibestudio.mobile.IngressActivity`,
    ]);
  });

  it("is wired into the smoke after the base flow", () => {
    const smoke = fs.readFileSync(path.join(process.cwd(), "scripts/cli/mobile-smoke.mjs"), "utf8");
    expect(smoke).toContain("assertSecondClientSeparateTask");
  });
});
