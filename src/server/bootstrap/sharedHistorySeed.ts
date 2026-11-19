import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ByteArraySchema } from "@vibestudio/shared/binary";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { WorkspaceHistorySource } from "../vcsHost/workspaceHistoryHost.js";
import { getBytes } from "../services/blobstoreService.js";
import { writeFileAtomicSync } from "../../atomicFile.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const activation = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1),
  seed: z.object({
    sourceNodeId: digest,
    head: z.string().regex(/^[0-9a-f]{40}$/u),
    eventId: z.string().min(1),
  }).strict(),
  offer: z.object({
    destinationNodeId: digest,
    branch: z.string().regex(/^seed\/[0-9a-f]{64}$/u),
  }).strict(),
  packDigest: digest,
}).strict();
const exportRequest = z.object({
  version: z.literal(1),
  sourceWorkspaceId: z.string().min(1),
  destinationWorkspaceId: z.string().min(1),
  head: activation.shape.seed.shape.head,
  eventId: activation.shape.seed.shape.eventId,
}).strict();
const exportGrant = z.object({
  branch: activation.shape.offer.shape.branch,
  id: z.string().min(1),
  token: z.string().min(1),
  contentHashes: z.array(digest),
}).strict();

async function optionalText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readVerifiedFile(file: string, expected: string): Promise<Uint8Array> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 1_073_741_824) {
    throw new Error("Workspace seed files must be regular files within the transfer limit");
  }
  const contents = await readFile(file);
  if (createHash("sha256").update(contents).digest("hex") !== expected) {
    throw new Error("Workspace seed file differs from its approved digest");
  }
  return contents;
}

/** Load the exact seed approved by the local operator for this workspace's first boot. */
export async function readSharedHistorySeed(statePath: string, workspaceId: string, stagedRoot?: string) {
  const root = path.join(statePath, "shared-history-seed");
  const manifestPath = path.join(root, "approved.json");
  const stagedPath = stagedRoot ? path.join(stagedRoot, "approved.json") : null;
  const local = await optionalText(manifestPath);
  const staged = stagedPath ? await optionalText(stagedPath) : null;
  if (local !== null && staged !== null && local !== staged) {
    throw new Error("The staged workspace seed differs from its installed origin");
  }
  const raw = local ?? staged;
  if (raw === null) return null;
  const manifest = activation.parse(JSON.parse(raw));
  if (manifest.workspaceId !== workspaceId) throw new Error("Workspace seed was approved for a different workspace");
  const payloadRoot = staged !== null && stagedRoot ? stagedRoot : root;
  return {
    seed: manifest.seed,
    // The pack is the recorded result of the source's scoped fetch. The local
    // transport never sends a grant token over the network.
    offer: { ...manifest.offer, token: manifest.packDigest },
    fetchPack: () => readVerifiedFile(path.join(payloadRoot, "history.pack"), manifest.packDigest),
    fetchFile: (hash: string) => readVerifiedFile(path.join(payloadRoot, "blobs", digest.parse(hash)), hash),
    confirmSource: async () => {
      if (await readFile(path.join(payloadRoot, "approved.json"), "utf8") !== raw) {
        throw new Error("Workspace seed approval changed during installation");
      }
    },
    remember: async () => {
      if (local === null) writeFileAtomicSync(manifestPath, raw);
    },
  };
}

/** Read a local operator's first-boot export request for one exact published event. */
export async function readSharedHistorySeedExport(input: {
  statePath: string;
  blobsDir: string;
  workspaceId: string;
  sourceNodeId(): Promise<string>;
}) {
  const root = path.join(input.statePath, "shared-history-export");
  const requestPath = path.join(root, "request.json");
  const raw = await optionalText(requestPath);
  if (raw === null) return null;
  const request = exportRequest.parse(JSON.parse(raw));
  if (request.sourceWorkspaceId !== input.workspaceId || request.destinationWorkspaceId === input.workspaceId) {
    throw new Error("Workspace seed export names different workspaces");
  }
  const operationId = sha256HexSyncText(canonicalJson(request));
  const destination = path.join(root, operationId);
  if (await optionalText(path.join(destination, "approved.json")) !== null) return null;
  return async ({ dispatch, canonical }: WorkspaceHistorySource): Promise<void> => {
    const sourceNodeId = digest.parse(await input.sourceNodeId());
    const destinationNodeId = randomBytes(32).toString("hex");
    const { head, eventId } = request;
    const staging = await mkdtemp(path.join(root, ".seed-"));
    let grant: z.infer<typeof exportGrant> | undefined;
    try {
      grant = exportGrant.parse(await dispatch.dispatch(canonical, "offerSharedHistorySeed", {
        destinationNodeId, head, eventId,
      }));
      // celld Dolt remote v1 fetch frame, with an empty receiver's set of known commits.
      const body = Buffer.from(JSON.stringify({ token: grant.token, haves: [], branches: [grant.branch] }));
      const frame = Buffer.alloc(6 + body.length);
      frame[0] = 1;
      frame[1] = 2;
      frame.writeUInt32LE(body.length, 2);
      body.copy(frame, 6);
      const pack = ByteArraySchema.parse(await dispatch.dispatch(canonical, "serveSharedHistorySeed", {
        destinationNodeId, bytes: frame,
      }));
      if (pack.length < 5 || pack[0] !== 0) throw new Error("The native workspace refused the seed fetch");
      const packHeader = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
      const headerEnd = 5 + packHeader.readUInt32LE(1);
      if (headerEnd >= pack.length) throw new Error("The native workspace returned an incomplete seed pack");
      const { branches } = z.object({ branches: z.record(z.string(), activation.shape.seed.shape.head) })
        .parse(JSON.parse(packHeader.toString("utf8", 5, headerEnd)));
      if (Object.keys(branches).length !== 1 || branches[grant.branch] !== head) {
        throw new Error("The native workspace returned a different seed branch");
      }
      await writeFile(path.join(staging, "history.pack"), pack, { mode: 0o600, flush: true });
      const blobs = path.join(staging, "blobs");
      await mkdir(blobs, { mode: 0o700 });
      for (const hash of grant.contentHashes) {
        const bytes = await getBytes(input.blobsDir, hash);
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) {
          throw new Error("Published workspace history is missing verified seed file bytes");
        }
        await writeFile(path.join(blobs, hash), bytes, { mode: 0o600, flush: true });
      }
      if (await readFile(requestPath, "utf8") !== raw) throw new Error("Workspace seed export request changed");
      const manifest = activation.parse({
        version: 1, workspaceId: request.destinationWorkspaceId,
        seed: { sourceNodeId, head, eventId },
        offer: { destinationNodeId, branch: grant.branch },
        packDigest: createHash("sha256").update(pack).digest("hex"),
      });
      await writeFile(path.join(staging, "approved.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flush: true });
      await syncDirectory(blobs);
      await syncDirectory(staging);
      await rename(staging, destination);
      await syncDirectory(root);
    } finally {
      try {
        if (grant) await dispatch.dispatch(canonical, "releaseSharedHistorySeed", { destinationNodeId, head, id: grant.id });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  };
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
