import git from "isomorphic-git";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const hash = (bytes: Buffer) => createHash("sha1").update(bytes).digest();
const blobOid = (text: string) => hash(Buffer.from(`blob ${Buffer.byteLength(text)}\0${text}`));
function objectHeader(type: number, size: number): Buffer {
  const bytes = [(type << 4) | (size & 15)];
  size >>>= 4;
  while (size) {
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! | 128;
    bytes.push(size & 127);
    size >>>= 7;
  }
  return Buffer.from(bytes);
}
function blob(text: string): Buffer {
  const bytes = Buffer.from(text);
  return Buffer.concat([objectHeader(3, bytes.length), deflateSync(bytes)]);
}
function delta(base: string, suffix: string): Buffer {
  const bytes = Buffer.concat([
    Buffer.from([base.length, base.length + suffix.length, 0x90, base.length, suffix.length]),
    Buffer.from(suffix),
  ]);
  return Buffer.concat([objectHeader(7, bytes.length), blobOid(base), deflateSync(bytes)]);
}
function pack(objects: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const content = Buffer.concat([header, ...objects]);
  return Buffer.concat([content, hash(content)]);
}
async function withPack(objects: Buffer[], run: (dir: string, filepath: string) => Promise<void>) {
  const dir = await fsp.mkdtemp(path.resolve(".cache/git-pack-test-"));
  try {
    await git.init({ fs, dir });
    const bytes = pack(objects);
    const filepath = `.git/objects/pack/pack-${bytes.subarray(-20).toString("hex")}.pack`;
    await fsp.mkdir(path.dirname(path.join(dir, filepath)), { recursive: true });
    await fsp.writeFile(path.join(dir, filepath), bytes);
    await run(dir, filepath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe("pack indexing", () => {
  it("indexes forward REF_DELTA chains without dropping objects", async () => {
    await withPack(
      [delta("hello world", "!"), delta("hello", " world"), blob("hello")],
      async (dir, filepath) => {
        const { oids } = await git.indexPack({ fs, dir, filepath });
        expect(oids).toHaveLength(3);
        for (const text of ["hello", "hello world", "hello world!"]) {
          const oid = blobOid(text).toString("hex");
          expect(oids).toContain(oid);
          const result = await git.readObject({ fs, dir, oid, format: "content" });
          expect(Buffer.from(result.object as Uint8Array).toString()).toBe(text);
        }
      }
    );
  });

  it("resolves a thin pack against a base stored outside that pack", async () => {
    await withPack([delta("hello", " world")], async (dir, filepath) => {
      await git.writeBlob({ fs, dir, blob: Buffer.from("hello") });
      const { oids } = await git.indexPack({ fs, dir, filepath });
      expect(oids).toEqual([blobOid("hello world").toString("hex")]);
    });
  });

  it("resolves forward delta chains rooted in an external thin-pack base", async () => {
    await withPack([delta("hello world", "!"), delta("hello", " world")], async (dir, filepath) => {
      await git.writeBlob({ fs, dir, blob: Buffer.from("hello") });
      const { oids } = await git.indexPack({ fs, dir, filepath });
      expect(oids).toEqual(
        [blobOid("hello world").toString("hex"), blobOid("hello world!").toString("hex")].sort()
      );
    });
  });

  it("propagates a missing base instead of writing an incomplete index", async () => {
    await withPack([delta("missing", "!")], async (dir, filepath) => {
      await expect(git.indexPack({ fs, dir, filepath })).rejects.toMatchObject({
        code: "NotFoundError",
      });
      await expect(
        fsp.stat(path.join(dir, filepath.replace(/\.pack$/, ".idx")))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("propagates malformed object data instead of dropping the object", async () => {
    const malformed = Buffer.concat([objectHeader(3, 8), deflateSync(Buffer.from("short"))]);
    await withPack([malformed], async (dir, filepath) => {
      await expect(git.indexPack({ fs, dir, filepath })).rejects.toThrow(/Inflated object size/);
    });
  });
});
