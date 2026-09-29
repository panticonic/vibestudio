import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { launchChromium } from "./launch.js";
class Child extends EventEmitter {
  stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => true);
}
const options = { executablePath: "/owned/chromium", profileRoot: "" };
beforeEach(() => {
  spawn.mockReset();
  options.profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-profile-test-"));
});
afterEach(() => fs.rmSync(options.profileRoot, { recursive: true, force: true }));
describe("Chromium launch ownership", () => {
  it("releases startup collectors and joins the child when retired", async () => {
    const child = new Child();
    spawn.mockReturnValue(child);
    const launching = launchChromium(options);
    child.stderr.emit("data", Buffer.from("DevTools listen"));
    child.stderr.emit("data", Buffer.from("ing on ws://127.0.0.1:123/devtools/browser/owned\n"));
    const browser = await launching;
    const profileDir = browser.profileDir;
    expect(fs.existsSync(profileDir)).toBe(true);
    const nativeOptions = spawn.mock.calls[0]![2];
    expect(nativeOptions.env.XDG_CONFIG_HOME).toBe(path.join(profileDir, "config"));
    expect(nativeOptions.env.XDG_CACHE_HOME).toBe(path.join(profileDir, "cache"));
    expect(nativeOptions.env.CHROME_CONFIG_HOME).toBe(path.join(profileDir, "config"));
    expect(browser.wsEndpoint).toBe("ws://127.0.0.1:123/devtools/browser/owned");
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stderr.resume).toHaveBeenCalledOnce();
    let joined = false;
    const retirement = browser.stop();
    expect(browser.stop()).toBe(retirement);
    const stopping = retirement.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(joined).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(true);
    child.signalCode = "SIGKILL";
    child.emit("close", null, "SIGKILL");
    await stopping;
    expect(joined).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(fs.existsSync(options.profileRoot)).toBe(true);
  });
  it("bounds startup diagnostics and awaits process close before rejecting an exited launch", async () => {
    const child = new Child();
    spawn.mockReturnValue(child);
    let settled = false;
    const launching = launchChromium(options).catch((error: Error) => {
      settled = true;
      return error;
    });
    child.stderr.emit(
      "data",
      Buffer.from("discarded-prefix" + "x".repeat(20000) + "native launch failure")
    );
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.stderr.listenerCount("data")).toBe(0);
    child.emit("close", 1, null);
    const error = (await launching) as Error;
    expect(error.message).toContain("native launch failure");
    expect(error.message).not.toContain("discarded-prefix");
    expect(error.message.length).toBeLessThan(2200);
    expect(child.kill).not.toHaveBeenCalled();
    expect(fs.readdirSync(options.profileRoot)).toEqual([]);
  });
  it("preserves the native spawn error and still joins the failed child", async () => {
    const child = new Child();
    spawn.mockReturnValue(child);
    const failure = new Error("executable missing");
    const launching = launchChromium(options).catch((error: unknown) => error);
    child.emit("error", failure);
    await Promise.resolve();
    child.emit("close", -2, null);
    expect(await launching).toBe(failure);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(fs.readdirSync(options.profileRoot)).toEqual([]);
  });
  it("reclaims its acquired profile when spawn throws synchronously", async () => {
    const failure = new Error("native spawn failed");
    spawn.mockImplementation(() => { throw failure; });
    await expect(launchChromium(options)).rejects.toBe(failure);
    expect(fs.readdirSync(options.profileRoot)).toEqual([]);
  });
  it("owns distinct profiles for concurrent launches without touching sibling state", async () => {
    fs.writeFileSync(path.join(options.profileRoot, "unowned"), "preserve");
    const children = [new Child(), new Child()];
    spawn.mockReturnValueOnce(children[0]).mockReturnValueOnce(children[1]);
    const launching = [launchChromium(options), launchChromium(options)];
    for (const child of children) child.stderr.emit("data", Buffer.from("DevTools listening on ws://127.0.0.1:123/devtools/browser/owned\n"));
    const browsers = await Promise.all(launching);
    expect(browsers[0]!.profileDir).not.toBe(browsers[1]!.profileDir);
    const retiring = browsers.map((browser) => browser.stop());
    for (const child of children) { child.signalCode = "SIGKILL"; child.emit("close"); }
    await Promise.all(retiring);
    expect(fs.readdirSync(options.profileRoot)).toEqual(["unowned"]);
  });
});
