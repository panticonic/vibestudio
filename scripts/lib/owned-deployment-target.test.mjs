import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Ownership } from "@vibestudio/shared/ownership";
import {
  openOwnedDeploymentTarget,
  requireInstalledDeploymentPackage,
} from "./owned-deployment-target.mjs";

for(const nativeReference of [false,true])test(`an installed deployment child preserves owner policy and production dependencies (native=${nativeReference})`, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deployment-environment-"));
  let ownership;
  t.after(async () => {
    try {
      await ownership?.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const appRoot = path.join(root, "installed");
  const cli = path.join(appRoot, "scripts", "cli");
  const scratchRoot = path.join(root, "target");
  await mkdir(cli, { recursive: true });
  await mkdir(scratchRoot);
  const captured = path.join(appRoot, "child-env.json");
  await writeFile(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "@panticonic/vibestudio-server", vibestudioHostedModelRouteVersion: 1, vibestudioNativeReferenceModeVersion: 1 })
  );
  await writeFile(
    path.join(cli, "remote-serve.mjs"),
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.env));`
  );
  const previous = process.env.NODE_ENV;
  const priorRoute = process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE;
  const route = '{"primary":"openai-codex:gpt-6-luna","fallback":null}';
  process.env.NODE_ENV = "development";
  process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE = route;
  t.after(() => {
    if (priorRoute === undefined) delete process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE;
    else process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE = priorRoute;
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  ownership = await Ownership.open({ profileDir: path.join(root, "profile"), lifetime: "leased" });
  const target = await openOwnedDeploymentTarget({
    appRoot,
    ownership,
    scratchRoot,
    nativeReference,
    signal: new AbortController().signal,
  });
  try {
    // The fixture records the actual child environment and exits without a hub.
    await assert.rejects(
      target.start("installed-child"),
      /never published a healthy managed workspace/
    );
    const env = JSON.parse(await readFile(captured, "utf8"));
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.VIBESTUDIO_HOSTED_MODEL_ROUTE, route);
    assert.equal(env.VIBESTUDIO_NATIVE_REFERENCE_ONLY,nativeReference?"1":undefined);
    assert.equal(env.VIBESTUDIO_APP_ROOT, appRoot);
    assert.equal(process.env.NODE_ENV, "development");
  } finally {
    await target.close();
  }
});

test("deployment preflight rejects an installed server whose Iroh binding cannot load", async (t) => {
  const appRoot = await mkdtemp(path.join(tmpdir(), "deployment-package-"));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const cli = path.join(appRoot, "scripts", "cli");
  const binding = path.join(appRoot, "node_modules", "@number0", "iroh");
  await mkdir(cli, { recursive: true });
  await mkdir(binding, { recursive: true });
  await writeFile(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "@panticonic/vibestudio-server" })
  );
  await writeFile(path.join(cli, "remote-serve.mjs"), "");
  await writeFile(path.join(binding, "index.js"), 'require("./missing-native-binding.node");');

  await assert.rejects(
    requireInstalledDeploymentPackage(appRoot),
    /the installed Vibestudio server could not load its Iroh native binding/i
  );
});

test("an older installed target is refused before resource allocation when it cannot enforce the owner route", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deployment-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@panticonic/vibestudio-server" })
  );
  const previous = process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE;
  process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE =
    '{"primary":"openai-codex:gpt-6-luna","fallback":null}';
  t.after(() => {
    if (previous === undefined) delete process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE;
    else process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE = previous;
  });
  await assert.rejects(
    openOwnedDeploymentTarget({
      appRoot: root,
      ownership: {
        spawn() {
          throw new Error("must not spawn");
        },
      },
      scratchRoot: path.join(root, "never-created"),
      signal: new AbortController().signal,
    }),
    /cannot enforce VIBESTUDIO_HOSTED_MODEL_ROUTE/
  );
  await assert.rejects(readFile(path.join(root, "never-created", "home")), { code: "ENOENT" });
});

test("native deployment refuses an old package before creating any target state",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"TEST-native-package-admission-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"package.json"),JSON.stringify({name:"@panticonic/vibestudio-server",vibestudioHostedModelRouteVersion:1}));
 await assert.rejects(requireInstalledDeploymentPackage(root,{nativeReference:true}),/cannot enforce native-reference/);
 await assert.rejects(openOwnedDeploymentTarget({appRoot:root,nativeReference:true,scratchRoot:path.join(root,"unallocated"),signal:new AbortController().signal}),/cannot enforce native-reference/);
 await assert.rejects(readFile(path.join(root,"unallocated","home")),{code:"ENOENT"});
});
