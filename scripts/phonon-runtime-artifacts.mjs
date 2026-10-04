import extractZip from "extract-zip";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "native/phonon");
export const PHONON_DISTRIBUTION = JSON.parse(
  await readFile(path.join(sourceRoot, "distribution.json"), "utf8")
);
const sourceFiles = ["runner.mjs", "engine.mjs", "frontend.mjs", "container.mjs"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const PHONON_VENDOR_ID = sha256(JSON.stringify(PHONON_DISTRIBUTION));

export function phononRuntimeTarget(platform = process.platform, arch = process.arch) {
  const target = PHONON_DISTRIBUTION.targets.find(
    (t) => t.platform === platform && t.arch === arch
  );
  if (!target) throw new Error(`Unsupported Phonon runtime target: ${platform}-${arch}`);
  return target;
}
export function verifyPhononDownload(bytes, pin) {
  const algorithm = pin.sha256 ? "sha256" : pin.integrity.split("-")[0];
  const expected = pin.sha256 ?? pin.integrity.slice(algorithm.length + 1);
  const encoding = pin.sha256 ? "hex" : "base64";
  if (createHash(algorithm).update(bytes).digest(encoding) !== expected)
    throw new Error("Phonon download checksum mismatch");
}

async function inputs(appRoot) {
  const require = createRequire(path.join(appRoot, "package.json"));
  const dependencyRoots = {};
  for (const name of ["koffi", "fft.js"]) {
    let directory = path.dirname(require.resolve(name));
    while (
      JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return "{}";
        })
      ).name !== name
    ) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate ${name} package root`);
      directory = parent;
    }
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (metadata.version !== PHONON_DISTRIBUTION.bindings[name])
      throw new Error(`Unpinned speech dependency: ${name}`);
    dependencyRoots[name] = directory;
  }
  const files = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [name, sha256(await readFile(path.join(sourceRoot, name)))])
    )
  );
  return { dependencyRoots, files };
}

async function inventory(root, directory = root) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(root, file));
    else if (entry.isFile())
      files[path.relative(root, file).split(path.sep).join("/")] = sha256(await readFile(file));
    else throw new Error(`Non-regular speech resource: ${file}`);
  }
  return files;
}
async function verifyFiles(root, files) {
  for (const [name, digest] of Object.entries(files)) {
    if (sha256(await readFile(path.join(root, name))) !== digest)
      throw new Error(`Invalid installed Phonon resource: ${name}`);
  }
}
async function publishImmutableDirectory(staging, destination, verify) {
  try {
    await verify(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    // Another publisher may have completed the same immutable generation.
    // Verify its content, independently of the platform's rename error code.
    try {
      await verify(destination);
    } catch {
      throw error;
    }
  }
  await verify(destination);
}
async function assertVendor(root, target = phononRuntimeTarget()) {
  const receipt = JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"));
  if (receipt.version !== 1 || receipt.vendor !== PHONON_VENDOR_ID)
    throw new Error("Invalid installed Phonon receipt");
  await verifyFiles(root, receipt.files);
  const distribution = JSON.parse(await readFile(path.join(root, "distribution.json"), "utf8"));
  if (sha256(JSON.stringify(distribution)) !== PHONON_VENDOR_ID)
    throw new Error("Invalid Phonon distribution manifest");
  for (const name of [
    target.encoder,
    target.decoder,
    target.baselineEncoder,
    target.baselineDecoder,
  ].filter(Boolean)) {
    if (receipt.files[`kernels/${name}`] !== PHONON_DISTRIBUTION.kernels[name])
      throw new Error(`Unpinned Phonon kernel: ${name}`);
  }
  for (const [name, digest] of Object.entries(PHONON_DISTRIBUTION.model.files)) {
    if (receipt.files[name] !== digest) throw new Error(`Unpinned Phonon model: ${name}`);
  }
}
export async function assertPhononRuntimeArtifacts(appRoot, target = phononRuntimeTarget()) {
  const root = path.join(appRoot, "dist/phonon");
  const pointer = JSON.parse(await readFile(path.join(root, "runtime.json"), "utf8"));
  if (
    pointer.version !== 1 ||
    pointer.vendor !== PHONON_VENDOR_ID ||
    !/^[a-f0-9]{64}$/.test(pointer.code)
  )
    throw new Error("Invalid installed Phonon runtime coordinate");
  const vendor = path.join(root, pointer.vendor);
  await assertVendor(vendor, target);
  const code = path.join(vendor, "code", pointer.code);
  const receipt = JSON.parse(await readFile(path.join(code, "receipt.json"), "utf8"));
  if (receipt.version !== 1 || sha256(JSON.stringify(receipt.files)) !== pointer.code)
    throw new Error("Invalid Phonon code receipt");
  await verifyFiles(code, receipt.files);
  const actual = await inventory(code);
  delete actual["receipt.json"];
  if (
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(receipt.files).sort())
  )
    throw new Error("Unexpected Phonon runtime code");
  return code;
}

/** Immutable vendor resources and small content-addressed JS generations.
 * Publication never renames or removes a model or library a live guest owns.
 * Archives and caller-owned staging are retired on every terminal path. */
async function stageVendor(appRoot, dependencyRoots) {
  const base = path.join(appRoot, "dist/phonon");
  const root = path.join(base, PHONON_VENDOR_ID);
  try {
    await assertVendor(root);
    return root;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(path.join(base, ".stage-"));
  const staging = path.join(scratch, "vendor");
  await mkdir(path.join(staging, "kernels"), { recursive: true });
  const download = async (pin, filename) => {
    const response = await fetch(pin.url);
    if (!response.ok || !response.body)
      throw new Error(`Phonon bake download failed: ${response.status} ${pin.url}`);
    const destination = path.join(scratch, filename);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(destination, { mode: 0o600 })
    );
    verifyPhononDownload(await readFile(destination), pin);
    return destination;
  };
  try {
    const wheel = await download(PHONON_DISTRIBUTION.wheel, "kernels.whl");
    const unpacked = path.join(scratch, "wheel");
    await extractZip(wheel, { dir: unpacked });
    for (const [name, digest] of Object.entries(PHONON_DISTRIBUTION.kernels)) {
      const bytes = await readFile(
        path.join(unpacked, "fermion/_speech/_engine_phonon2_cpu", name)
      );
      if (sha256(bytes) !== digest)
        throw new Error(`Upstream Phonon kernel checksum mismatch: ${name}`);
      await writeFile(path.join(staging, "kernels", name), bytes);
    }
    await mkdir(path.join(staging, "licenses"));
    for (const name of ["LICENSE", "NOTICE"]) {
      const bytes = await readFile(
        path.join(unpacked, "fermion_research-0.2.7.dist-info/licenses", name)
      );
      await writeFile(path.join(staging, "licenses", `fermion-${name}`), bytes);
    }
    const archive = await download(PHONON_DISTRIBUTION.model, "model.tar.zst");
    const tar = path.join(scratch, "model.tar");
    await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(tar));
    await execute("tar", [
      "-xf",
      tar,
      "-C",
      staging,
      ...Object.keys(PHONON_DISTRIBUTION.model.files),
    ]);
    for (const [name, digest] of Object.entries(PHONON_DISTRIBUTION.model.files)) {
      if (sha256(await readFile(path.join(staging, name))) !== digest)
        throw new Error(`Upstream model checksum mismatch: ${name}`);
    }
    for (const name of ["NOTICE", "LICENSE-WEIGHTS-CC-BY-4.0.txt"]) {
      const response = await fetch(
        `https://huggingface.co/FermionResearch/Phonon-2/resolve/9c7fef3584499a88fe8d394427f45851bbb8b446/${name}`
      );
      if (!response.ok) throw new Error(`Phonon attribution download failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(path.join(staging, "licenses", `weights-${name}`), bytes);
    }
    for (const target of PHONON_DISTRIBUTION.targets) {
      const archive = await download(target.ffi, `${target.platform}-${target.arch}.tgz`);
      const directory = path.join(staging, "node_modules", target.ffi.name);
      await mkdir(directory, { recursive: true });
      await execute("tar", ["-xf", archive, "-C", directory, "--strip-components=1"]);
    }
    await writeFile(
      path.join(staging, "distribution.json"),
      JSON.stringify(PHONON_DISTRIBUTION, null, 2)
    );
    for (const [name, directory] of Object.entries(dependencyRoots))
      await cp(directory, path.join(staging, "node_modules", name), {
        recursive: true,
        dereference: true,
      });
    const complete = await inventory(staging);
    await writeFile(
      path.join(staging, "receipt.json"),
      JSON.stringify({ version: 1, vendor: PHONON_VENDOR_ID, files: complete }, null, 2)
    );
    await publishImmutableDirectory(staging, root, assertVendor);
    return root;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function stagePhononRuntime(appRoot = repositoryRoot) {
  const { files, dependencyRoots } = await inputs(appRoot);
  const vendor = await stageVendor(appRoot, dependencyRoots);
  const codeId = sha256(JSON.stringify(files));
  const code = path.join(vendor, "code", codeId);
  await mkdir(path.dirname(code), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(code), ".stage-"));
  try {
    for (const name of sourceFiles) await cp(path.join(sourceRoot, name), path.join(staging, name));
    await writeFile(
      path.join(staging, "receipt.json"),
      JSON.stringify({ version: 1, files }, null, 2)
    );
    await verifyFiles(staging, files);
    await publishImmutableDirectory(staging, code, (root) => verifyFiles(root, files));
    // Readers see one complete immutable coordinate. Parallel publishers may
    // select the same generation, without replacing each other's resources.
    const pointer = path.join(staging, "runtime.json");
    await mkdir(staging, { recursive: true });
    await writeFile(
      pointer,
      JSON.stringify({ version: 1, vendor: PHONON_VENDOR_ID, code: codeId })
    );
    await rename(pointer, path.join(appRoot, "dist/phonon/runtime.json"));
    return await assertPhononRuntimeArtifacts(appRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await stagePhononRuntime();
