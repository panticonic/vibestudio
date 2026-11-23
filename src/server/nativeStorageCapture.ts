import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomicSync } from "../atomicFile.js";
import { blobCasPath } from "./storage/blobCas.js";

interface NativeCaptureIdentity {
  workspaceId: string;
  namespace: string;
  actorHash: string;
  target?: { source: string; className: string; objectKey: string };
}
interface CapturedFile {
  name: string;
  bytes: number;
  mode: number;
  sha256: string;
}
interface NativeCaptureManifest {
  schema: "vibestudio.native-storage-capture/1";
  identity: NativeCaptureIdentity;
  files: CapturedFile[];
  capturedAt: string;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = (s: import("node:fs").BigIntStats) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");

async function names(directory: string, hash: string): Promise<string[]> {
  return (
    await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })
  )
    .filter((name) => name.startsWith(`${hash}.`))
    .sort();
}

async function copyBoundFile(source: string, destination: string): Promise<CapturedFile> {
  const initial = await fs.lstat(source, { bigint: true });
  if (!initial.isFile()) throw new Error(`Native capture requires a regular file: ${source}`);
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (stamp(await input.stat({ bigint: true })) !== stamp(initial))
      throw new Error("Native source changed before capture");
    output = await fs.open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
      await output.writeFile(chunk);
    }
    await output.chmod(Number(initial.mode & 0o777n));
    await output.sync();
    if (
      stamp(await input.stat({ bigint: true })) !== stamp(initial) ||
      stamp(await fs.lstat(source, { bigint: true })) !== stamp(initial) ||
      bytes !== Number(initial.size)
    ) {
      throw new Error(`Native source changed during capture: ${source}`);
    }
    return {
      name: path.basename(source),
      bytes,
      mode: Number(initial.mode & 0o777n),
      sha256: hash.digest("hex"),
    };
  } finally {
    await output?.close();
    await input.close();
  }
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Native archive member is not a regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyPublished(
  directory: string,
  expected: Omit<NativeCaptureManifest, "capturedAt">
): Promise<void> {
  const raw = await fs.readFile(path.join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as NativeCaptureManifest;
  const { capturedAt: _capturedAt, ...bound } = manifest;
  if (JSON.stringify(bound) !== JSON.stringify(expected))
    throw new Error("Native archive manifest does not match the exact source");
  const members = (await fs.readdir(directory)).sort();
  if (
    JSON.stringify(members) !==
    JSON.stringify([...expected.files.map((file) => file.name), "manifest.json"].sort())
  )
    throw new Error("Native archive member set changed");
  for (const file of expected.files) {
    const actual = await hashFile(path.join(directory, file.name));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`Native archive bytes changed: ${file.name}`);
  }
}

/** Caller owns the exact native fence/quiescence. This barrier never erases the source. */
export async function retainNativeStorageBeforeErase(input: {
  archiveRoot: string;
  directory: string;
  hash: string;
  workspaceId: string;
  target?: NativeCaptureIdentity["target"];
  verifySqlite: (paths: string[]) => Promise<void>;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(input.hash))
    throw new Error("Native capture requires an exact native actor hash");
  const identity: NativeCaptureIdentity = {
    workspaceId: input.workspaceId,
    namespace: path.basename(input.directory),
    actorHash: input.hash,
    ...(input.target ? { target: input.target } : {}),
  };
  const ownerDirectory = path.join(input.archiveRoot, digest(identity));
  await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  const stage = path.join(ownerDirectory, `.pending-${randomUUID()}`);
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const initial = await names(input.directory, input.hash);
    const files: CapturedFile[] = [];
    for (const name of initial)
      files.push(await copyBoundFile(path.join(input.directory, name), path.join(stage, name)));
    if (JSON.stringify(initial) !== JSON.stringify(await names(input.directory, input.hash)))
      throw new Error("Native source member set changed during capture");
    // SQLite may update a WAL read mark or recover a journal while inspecting.
    // Verify a disposable copy so the archived bytes remain exactly native.
    const verification = path.join(stage, ".verify");
    await fs.mkdir(verification, { mode: 0o700 });
    for (const name of initial)
      await fs.copyFile(path.join(stage, name), path.join(verification, name));
    await input.verifySqlite(
      files
        .filter((file) => file.name.endsWith(".sqlite"))
        .map((file) => path.join(verification, file.name))
    );
    await fs.rm(verification, { recursive: true });
    // Verify source bytes again after database validation and before publication.
    for (const file of files) {
      const current = await hashFile(path.join(input.directory, file.name));
      if (current.bytes !== file.bytes || current.sha256 !== file.sha256)
        throw new Error("Native source bytes changed before archive publication");
    }
    if (JSON.stringify(initial) !== JSON.stringify(await names(input.directory, input.hash)))
      throw new Error("Native source member set changed before publication");
    const bound: Omit<NativeCaptureManifest, "capturedAt"> = {
      schema: "vibestudio.native-storage-capture/1",
      identity,
      files,
    };
    const destination = path.join(ownerDirectory, digest(bound));
    const manifest = await fs.open(path.join(stage, "manifest.json"), "wx", 0o600);
    try {
      await manifest.writeFile(
        JSON.stringify({ ...bound, capturedAt: new Date().toISOString() }, null, 2) + "\n"
      );
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    await syncDirectory(stage);
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await verifyPublished(destination, bound);
    }
    await syncDirectory(ownerDirectory);
    await verifyPublished(destination, bound);
    return destination;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

/** Copy the quiesced celld object and its facets, including Dolt local tables. */
export async function retainCelldStorageImage(input: {
  directory: string;
  indexPath: string;
  blobRoot: string;
  cellId: string;
  workspaceId: string;
  source: NativeCaptureIdentity["target"];
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(input.cellId)) throw new Error("Invalid celld capture cell ID");
  const database = new DatabaseSync(input.indexPath, { readOnly: true });
  const prefix = (() => {
    try {
      const rows = database.prepare("SELECT key FROM objects WHERE key GLOB ?")
        .all(`cells/*:${input.cellId}/own.json`);
      if (rows.length > 1) throw new Error("Found more than one celld cell with the same ID");
      return rows[0] ? String(rows[0]["key"]).slice(0, -"own.json".length) : null;
    } catch (error) {
      database.close();
      throw error;
    }
  })();
  if (prefix === null) {
    database.close();
    return;
  }
  const stage = `${input.directory}.${randomUUID()}.pending`;
  try {
    await fs.mkdir(stage, { recursive: true, mode: 0o700 });
    const files: Array<{ key: string; bytes: number; sha256: string }> = [];
    const entries = database.prepare("SELECT key, size, digest, body FROM objects WHERE key >= ? AND key < ? ORDER BY key")
      .iterate(prefix, `${prefix.slice(0, -1)}0`);
    for (const row of entries) {
      const key = String(row["key"]);
      const relative = key.slice(prefix.length);
      if (!relative.split("/").every(name => /^[a-zA-Z0-9_.-]+$/u.test(name) && name !== "." && name !== ".."))
        throw new Error("Invalid celld archive member name");
      const file = path.join(stage, relative);
      const bytes = Number(row["size"]);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const digest = row["digest"];
      if (typeof digest === "string") {
        await fs.copyFile(blobCasPath(input.blobRoot, digest), file, constants.COPYFILE_EXCL);
        if ((await fs.stat(file)).size !== bytes) throw new Error("Truncated celld archive member");
        files.push({ key, bytes, sha256: digest });
      } else {
        const body = row["body"];
        if (!(body instanceof Uint8Array) || body.byteLength !== bytes) throw new Error("Invalid celld inline archive member");
        await fs.writeFile(file, body, { flag: "wx", mode: 0o600 });
        files.push({ key, bytes, sha256: createHash("sha256").update(body).digest("hex") });
      }
    }
    writeFileAtomicSync(path.join(stage, "manifest.json"), JSON.stringify({
      schema: "vibestudio.celld-native-storage-capture/1",
      workspaceId: input.workspaceId,
      source: input.source,
      cellId: input.cellId,
      files,
    }) + "\n");
    await fs.rename(stage, input.directory);
  } finally {
    database.close();
    await fs.rm(stage, { recursive: true, force: true });
  }
}
