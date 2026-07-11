import { describe, expect, it } from "vitest";
import { inferAttachmentMimeType, readSayAttachments } from "./say-attachments.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function makeFs(files: Record<string, string | Uint8Array>) {
  return {
    async readFile(path: string): Promise<string | Uint8Array> {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
  };
}

describe("inferAttachmentMimeType", () => {
  it("maps image extensions case-insensitively", () => {
    expect(inferAttachmentMimeType("/shots/page.PNG")).toBe("image/png");
    expect(inferAttachmentMimeType("a/b.jpeg")).toBe("image/jpeg");
    expect(inferAttachmentMimeType("b.jpg")).toBe("image/jpeg");
    expect(inferAttachmentMimeType("c.webp")).toBe("image/webp");
    expect(inferAttachmentMimeType("d.gif")).toBe("image/gif");
  });

  it("rejects non-image and extension-less paths with the supported list", () => {
    expect(() => inferAttachmentMimeType("/notes/report.pdf")).toThrow(/supported/i);
    expect(() => inferAttachmentMimeType("/bin/screenshot")).toThrow(/supported/i);
  });
});

describe("readSayAttachments", () => {
  it("reads image files into base64 channel attachments", async () => {
    const fs = makeFs({ "/shots/page.png": PNG_BYTES });
    const attachments = await readSayAttachments(fs, ["/shots/page.png"]);
    expect(attachments).toEqual([
      {
        id: "att_0",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mimeType: "image/png",
        name: "page.png",
        size: PNG_BYTES.length,
      },
    ]);
  });

  it("wraps fs errors with the offending path", async () => {
    const fs = makeFs({});
    await expect(readSayAttachments(fs, ["/missing.png"])).rejects.toThrow(
      /say attachment "\/missing.png"/
    );
  });

  it("rejects text file contents", async () => {
    const fs = makeFs({ "/fake.png": "not binary" });
    await expect(readSayAttachments(fs, ["/fake.png"])).rejects.toThrow(/binary image data/);
  });

  it("rejects oversized attachments via the shared validation", async () => {
    const fs = makeFs({ "/huge.png": new Uint8Array(16 * 1024 * 1024) });
    await expect(readSayAttachments(fs, ["/huge.png"])).rejects.toThrow(/too large/i);
  });

  it("returns an empty list for no paths", async () => {
    expect(await readSayAttachments(makeFs({}), [])).toEqual([]);
  });
});
