import { describe, expect, it } from "vitest";
import { parseBinaryCookies, parseSafariPasswordCsv } from "../readers/safariReader.js";

/** One cookie record in Safari's layout: 56-byte header, then NUL-terminated strings. */
function cookieRecord(fields: {
  flags: number;
  domain: string;
  name: string;
  path: string;
  value: string;
  expires: number;
  created: number;
}): Buffer {
  const strings = [fields.domain, fields.name, fields.path, fields.value].map((text) =>
    Buffer.from(`${text}\0`, "utf-8")
  );
  const headerSize = 56;
  const size = headerSize + strings.reduce((sum, part) => sum + part.length, 0);
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(size, 0);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(fields.flags, 8);
  header.writeUInt32LE(0, 12);
  let offset = headerSize;
  for (const [index, part] of strings.entries()) {
    header.writeUInt32LE(offset, 16 + index * 4);
    offset += part.length;
  }
  header.writeDoubleLE(fields.expires, 40);
  header.writeDoubleLE(fields.created, 48);
  return Buffer.concat([header, ...strings]);
}

function binaryCookiesFile(records: Buffer[]): Buffer {
  const pageHeaderSize = 8 + records.length * 4 + 4;
  const pageHeader = Buffer.alloc(pageHeaderSize);
  pageHeader.writeUInt32BE(0x00000100, 0);
  pageHeader.writeUInt32LE(records.length, 4);
  let offset = pageHeaderSize;
  for (const [index, record] of records.entries()) {
    pageHeader.writeUInt32LE(offset, 8 + index * 4);
    offset += record.length;
  }
  const page = Buffer.concat([pageHeader, ...records]);
  const fileHeader = Buffer.alloc(12);
  fileHeader.write("cook", 0, "ascii");
  fileHeader.writeUInt32BE(1, 4);
  fileHeader.writeUInt32BE(page.length, 8);
  return Buffer.concat([fileHeader, page]);
}

describe("parseBinaryCookies", () => {
  it("reads every field from Safari's record layout", () => {
    const file = binaryCookiesFile([
      cookieRecord({
        flags: 0x5,
        domain: ".example.com",
        name: "session",
        path: "/app",
        value: "abc123",
        expires: 800_000_000,
        created: 700_000_000,
      }),
      cookieRecord({
        flags: 0,
        domain: "other.test",
        name: "pref",
        path: "/",
        value: "dark",
        expires: 0,
        created: 1,
      }),
    ]);

    expect(parseBinaryCookies(file)).toEqual([
      {
        name: "session",
        value: "abc123",
        domain: ".example.com",
        path: "/app",
        expirationDate: 800_000_000,
        creationDate: 700_000_000,
        flags: 0x5,
      },
      {
        name: "pref",
        value: "dark",
        domain: "other.test",
        path: "/",
        expirationDate: 0,
        creationDate: 1,
        flags: 0,
      },
    ]);
  });
});

describe("parseSafariPasswordCsv", () => {
  it("keeps quoted multi-line notes inside their row", () => {
    const csv = [
      "Title,URL,Username,Password,Notes,OTPAuth",
      'Example,https://example.com,alice,"pa,ss","first line',
      'second, ""quoted"", line",',
      "Other,https://other.test,bob,secret,,",
      "",
    ].join("\r\n");

    expect(parseSafariPasswordCsv(csv)).toEqual([
      { url: "https://example.com", username: "alice", password: "pa,ss", realm: "Example" },
      { url: "https://other.test", username: "bob", password: "secret", realm: "Other" },
    ]);
  });
});
