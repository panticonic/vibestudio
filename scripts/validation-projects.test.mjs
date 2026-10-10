import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tsImport } from "tsx/esm/api";
const { ValidationProjects, validationGroups } = await tsImport(
  "./lib/validation-projects.ts",
  import.meta.url
);

test("dependency declarations preserve diagnostics and unchanged graphs reuse their outputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-projects-"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "fixture");
  const write = (name, content) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.ts");
    fs.writeFileSync(file, content);
    return { name, root: dir, files: [file] };
  };
  const a = write("a", "export const value: number = 1;");
  const b = write("b", 'import {value} from "a"; export const result = value + 1;');
  const paths = { a: a.files, b: b.files };
  const options = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  };
  let projects = new ValidationProjects(root);
  try {
    assert.deepEqual(
      validationGroups([b, a], paths).map((group) => group.map((unit) => unit.name)),
      [["a"], ["b"]]
    );
    const first = await projects.contracts([b, a], paths, options);
    const second = await projects.contracts([b, a], paths, options);
    assert.deepEqual(first, second);
    const relocated = [b, a].map((unit) => {
      const directory = path.join(root, "projection", unit.name);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "index.ts");
      fs.copyFileSync(unit.files[0], file);
      return { ...unit, root: directory, files: [file] };
    });
    const relocatedPaths = Object.fromEntries(relocated.map((unit) => [unit.name, unit.files]));
    assert.deepEqual(await projects.contracts(relocated, relocatedPaths, options), first);

    assert.match(fs.readFileSync(second.b[0], "utf8"), /result: number/);
    fs.writeFileSync(a.files[0], 'export const value: string = "changed";');
    const updated = await projects.contracts([b, a], paths, options);
    assert.notEqual(updated.a[0], first.a[0]);
    assert.match(fs.readFileSync(updated.b[0], "utf8"), /result: string/);
    fs.writeFileSync(
      b.files[0],
      'import {value} from "a"; const invalid: number = value; export {invalid};'
    );
    await assert.rejects(projects.contracts([b, a], paths, options));
    assert.equal(
      fs
        .readdirSync(path.join(root, ".cache"))
        .some((name) => name.startsWith("typecheck-contract-")),
      false
    );
  } finally {
    await projects.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package cycles and source-relative edges stay inside one compiler owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-cycle-"));
  try {
    const units = ["a", "b"].map((name) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      const file = path.join(dir, "index.ts");
      fs.writeFileSync(
        file,
        name === "a" ? 'export { value } from "../b/index.js";' : "export const value = 1;"
      );
      return { name, root: dir, files: [file] };
    });
    assert.equal(validationGroups(units, {}).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("declaration contracts retain JSON and authored module declarations and reject damaged outputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-assets-"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "fixture");
  const source = path.join(root, "package");
  fs.mkdirSync(source);
  const entry = path.join(source, "index.ts");
  fs.writeFileSync(
    entry,
    'import data from "./data.json"; import {value} from "./native.mjs"; export {value}; export const result = data.count;'
  );
  fs.writeFileSync(path.join(source, "data.json"), '{"count":1}');
  fs.writeFileSync(path.join(source, "native.mjs"), "export const value = 1;");
  fs.writeFileSync(path.join(source, "native.d.mts"), "export const value: number;");
  const units = [{ name: "fixture", root: source, files: [entry] }];
  const options = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
    resolveJsonModule: true,
    esModuleInterop: true,
  };
  const projects = new ValidationProjects(root);
  try {
    const first = await projects.contracts(units, { fixture: [entry] }, options);
    projects.check("consumer", [entry], { ...options, paths: first });
    const output = path.dirname(first.fixture[0]);
    assert.equal(
      fs.readFileSync(path.join(output, "native.d.mts"), "utf8"),
      "export const value: number;"
    );
    assert.equal(fs.readFileSync(path.join(output, "data.json"), "utf8"), '{"count":1}');
    fs.writeFileSync(path.join(source, "data.json"), '{"count":"updated"}');
    const updated = await projects.contracts(units, { fixture: [entry] }, options);
    assert.match(fs.readFileSync(updated.fixture[0], "utf8"), /result: string/);
    projects.check("consumer", [entry], { ...options, paths: updated });
    assert.equal(
      fs
        .readdirSync(path.join(root, ".cache", "typecheck-state"), { recursive: true })
        .filter((file) => file.endsWith(".tsbuildinfo")).length,
      1
    );
    fs.rmSync(updated.fixture[0]);
    await assert.rejects(
      projects.contracts(units, { fixture: [entry] }, options),
      /cache integrity failure/
    );
  } finally {
    await projects.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cached declarations resolve dependencies through their owning installation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-installation-"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(
    path.resolve("node_modules/typescript"),
    path.join(root, "node_modules/typescript"),
    "dir"
  );
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "fixture");
  const modules = path.join(root, "projection/node_modules");
  for (const directory of [path.join(root, "node_modules"), modules]) {
    const dependency = path.join(directory, "fixture-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "fixture-dependency", types: "index.d.ts", type: "module" })
    );
    fs.writeFileSync(
      path.join(dependency, "index.d.ts"),
      "export declare class Item { private readonly brand; }"
    );
  }
  const directory = path.join(root, "projection/a");
  fs.mkdirSync(directory);
  const entry = path.join(directory, "index.ts");
  fs.writeFileSync(path.join(directory, "package.json"), '{"name":"a","type":"module"}');
  fs.writeFileSync(
    entry,
    'import {Item} from "fixture-dependency"; export function makeItem() {return new Item();}'
  );
  const consumer = path.join(root, "projection/consumer.ts");
  fs.writeFileSync(
    consumer,
    'import {Item} from "fixture-dependency"; import {makeItem} from "a"; export const item: Item = makeItem();'
  );
  const options = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  };
  const projects = new ValidationProjects(root);
  try {
    const declarations = await projects.contracts(
      [{ name: "a", root: directory, files: [entry] }],
      { a: [entry] },
      options,
      [],
      modules
    );
    projects.check("consumer", [consumer], { ...options, paths: declarations });
  } finally {
    await projects.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
