import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { macCaskUpgrade } from "./macCaskUpgrade.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("requires the installed cask to own the running bundle, not merely a Homebrew executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cask-"));
  roots.push(root);
  const brew = path.join(root, "bin", "brew");
  const bundle = path.join(root, "Applications", "Vibestudio.app");
  const executable = path.join(bundle, "Contents", "MacOS", "Vibestudio");
  fs.mkdirSync(path.dirname(brew), { recursive: true });
  fs.writeFileSync(brew, "");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  expect(macCaskUpgrade(executable, [brew])).toBeNull();
  const cask = path.join(root, "Caskroom", "vibestudio", "0.2.0");
  fs.mkdirSync(cask, { recursive: true });
  fs.symlinkSync(bundle, path.join(cask, "Vibestudio.app"));
  expect(macCaskUpgrade(executable, [brew])?.argv).toEqual([
    brew,
    "upgrade",
    "--cask",
    "vibestudio",
  ]);
  const other = path.join(root, "Downloads", "Vibestudio.app", "Contents", "MacOS", "Vibestudio");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  expect(macCaskUpgrade(other, [brew])).toBeNull();
});
