import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TypeCheckService } from "./service.js";

let root: string;
let service: TypeCheckService;
afterEach(() => {
  service?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});
function start() {
  root = mkdtempSync(join(tmpdir(), "vibestudio-svelte-typecheck-"));
  service = new TypeCheckService({ panelPath: root, nodeModulesPaths: [resolve("node_modules")], skipSuggestions: true });
}
it("checks Svelte script and markup with original source locations and typed props", () => {
  start();
  service.updateFile(join(root, "App.svelte"), '<script lang="ts">\nexport let count: number;\nconst wrong: number = "bad";\n</script>\n<p>{count.toUpperCase()}</p>');
  service.updateFile(join(root, "index.ts"), 'import App from "./App.svelte"; import { mount } from "svelte"; mount(App, { target: document.body, props: { count: "wrong" } });');
  const diagnostics = service.check().diagnostics;
  expect(diagnostics).toContainEqual(expect.objectContaining({ file: join(root, "App.svelte"), line: 3, code: 2322 }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ file: join(root, "App.svelte"), line: 5, code: 2339 }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ file: join(root, "index.ts"), code: 2322 }));
  expect(diagnostics.some(d => d.code === 2307)).toBe(false);
  service.updateFile(join(root, "App.svelte"), '<script lang="ts">export let count: number;</script><p>{count.toFixed()}</p>');
  service.updateFile(join(root, "index.ts"), 'import App from "./App.svelte"; import { mount } from "svelte"; mount(App, { target: document.body, props: { count: 1 } });');
  expect(service.check().diagnostics).toEqual([]);
});
it("resolves a disk component through the native import projection", () => {
  start();
  writeFileSync(join(root, "App.svelte"), '<script lang="ts">export let count: number;</script>{count}');
  service.updateFile(join(root, "index.ts"), 'import App from "./App.svelte"; import { mount } from "svelte"; mount(App, { target: document.body, props: { count: "wrong" } });');
  expect(service.check().diagnostics).toEqual([expect.objectContaining({ file: join(root, "index.ts"), code: 2322 })]);
});
it("preserves JavaScript components and retires old output when their language changes", () => {
  start();
  const file = join(root, "App.svelte");
  service.updateFile(file, '<script>export let count = 0;</script>{count}');
  service.updateFile(join(root, "index.ts"), 'export {default} from "./App.svelte";');
  expect(service.check().diagnostics).toEqual([]);
  expect(service.getFileNames()).toContain(join(root, "++App.svelte.js"));
  service.updateFile(file, '<script lang="ts">export let count: number;</script>{count}');
  expect(service.check().diagnostics).toEqual([]);
  expect(service.getFileNames()).not.toContain(join(root, "++App.svelte.js"));
  service.removeFile(file);
  expect(service.hasFile(file)).toBe(false);
  expect(service.check().diagnostics).toContainEqual(expect.objectContaining({ code: 2307 }));
});

it("checks a single JavaScript component's markup at its original location", () => {
  start();
  const file = join(root, "App.svelte");
  service.updateFile(file, '<script>export let count = 0;</script>\n<p>{count.toUpperCase()}</p>');
  const checked = service.check(file);
  expect(checked.checkedFiles).toEqual([file]);
  expect(checked.diagnostics).toContainEqual(expect.objectContaining({ file, line: 2, code: 2339 }));
  service.updateFile(file, '<script>export let count = 0;</script>\n<p>{count.toFixed()}</p>');
  expect(service.check(file).diagnostics).toEqual([]);
});
it("rejects an authored output collision during a component language change", () => {
  start();
  const file = join(root, "App.svelte");
  service.updateFile(file, '<script>export let count = 0;</script>{count}');
  writeFileSync(join(root, "++App.svelte.ts"), "export const authored = true;");
  expect(() => service.updateFile(file, '<script lang="ts">export let count: number;</script>{count}')).toThrow("conflicts with authored source");
  expect(service.getFileNames()).toContain(join(root, "++App.svelte.js"));
});
