import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tsImport } from "tsx/esm/api";
const { ValidationProjects } = await tsImport("./lib/validation-projects.ts", import.meta.url);
const { configuredFiles } = await tsImport("./lib/host-validation.ts", import.meta.url);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-state-"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  const config = path.join(root, "tsconfig.json");
  const options = {target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, types: []};
  return { root, config, options, projects: new ValidationProjects(root) };
}

function states(root) {
  return fs.readdirSync(path.join(root, ".cache/typecheck-state"), {recursive: true})
    .filter((name) => name.endsWith("state.tsbuildinfo"))
    .map((name) => path.join(root, ".cache/typecheck-state", name));
}

test("the original program retains ambient contracts, tests, and valid incremental state after failure", async () => {
  const {root, config, options, projects} = fixture();
  try {
    fs.writeFileSync(path.join(root, "api.ts"), 'export interface Registry {}\nexport function use<K extends keyof Registry>(key: K): Registry[K] { throw new Error(String(key)); }');
    fs.writeFileSync(path.join(root, "extension.ts"), 'import type {} from "api"; declare module "api" { interface Registry { shell: {open(): number} } } export {};');
    const consumer = path.join(root, "consumer.test.ts");
    const source = 'import {use} from "api"; export const result: number = use("shell").open();';
    fs.writeFileSync(consumer, source);
    fs.writeFileSync(config, JSON.stringify({include:["*.ts"], compilerOptions:{...options, paths:{api:["./api.ts"]}}}));
    const check = () => projects.check("fixture", configuredFiles(config), {}, config);
    check();
    const [state] = states(root);
    assert.ok(state);
    check();
    assert.deepEqual(states(root), [state]);
    const saved = fs.readFileSync(state);
    fs.writeFileSync(consumer, source.replace('result: number', 'result: boolean'));
    assert.throws(check);
    assert.deepEqual(fs.readFileSync(state), saved);
    assert.deepEqual(fs.readdirSync(path.dirname(state)), ["state.tsbuildinfo"]);
    fs.writeFileSync(consumer, source);
    check();
    // Changing the authoritative root set must invalidate the ambient contract.
    fs.writeFileSync(config, JSON.stringify({files:["api.ts", "consumer.test.ts"], compilerOptions:{...options, paths:{api:["./api.ts"]}}}));
    assert.throws(check);
  } finally {
    await projects.close();
    fs.rmSync(root, {recursive:true, force:true});
  }
});

test("compiler option changes retain each original realm's diagnostics", async () => {
  const {root, config, options, projects} = fixture();
  try {
    fs.writeFileSync(path.join(root, "realm.ts"), 'export const element = document.createElement("div");');
    const write = (lib) => fs.writeFileSync(config, JSON.stringify({files:["realm.ts"], compilerOptions:{...options, lib}}));
    const check = () => projects.check("realm", configuredFiles(config), {}, config);
    write(["ES2022", "DOM"]);
    check();
    const [state] = states(root);
    const saved = fs.readFileSync(state);
    write(["ES2022"]);
    assert.throws(check);
    assert.deepEqual(fs.readFileSync(state), saved);
    write(["ES2022", "DOM"]);
    check();
  } finally {
    await projects.close();
    fs.rmSync(root, {recursive:true, force:true});
  }
});
