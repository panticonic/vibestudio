import { describe, expect, it } from "vitest";
import {
  inspectBrowserExport,
  parseBrowserImportArchive,
  parseSelectedBrowserExport,
  recognizeBrowserExport,
  type ArchiveEntry,
} from "./index.js";

const encoder = new TextEncoder();
const entry = (name: string, text: string): ArchiveEntry => ({ name, bytes: encoder.encode(text) });

describe("browser export archive parser", () => {
  it("parses Safari bookmarks and preserves a Reading List folder", () => {
    const result = recognizeBrowserExport([
      entry(
        "Safari/Bookmarks.html",
        `<!DOCTYPE NETSCAPE-Bookmark-file-1>
         <DL><p><DT><H3>Reading List</H3><DL><p>
         <DT><A HREF="https://example.test/read" ADD_DATE="1710000000">Read &amp; Learn</A>
         </DL><p><DT><A HREF="https://example.test/root">Root</A></DL>`
      ),
    ]);
    expect(result.browser).toBe("safari");
    expect(result.supportedDataTypes).toEqual(["bookmarks"]);
    expect(result.items.bookmarks).toEqual([
      {
        title: "Read & Learn",
        url: "https://example.test/read",
        dateAdded: 1_710_000_000_000,
        folder: ["Reading List"],
      },
      { title: "Root", url: "https://example.test/root", dateAdded: 0, folder: [] },
    ]);
  });

  it("parses Safari history datasets per profile", () => {
    const result = recognizeBrowserExport([
      entry(
        "Safari/Profiles/Personal/History.json",
        JSON.stringify({
          history: [{ url: "https://one.test", title: "One", lastVisitTime: 1_720_000_000_000 }],
        })
      ),
      entry(
        "Safari/Profiles/Work/History.json",
        JSON.stringify({
          "Safari History": [{ URL: "https://two.test", Title: "Two", visitTime: 1_720_000_001 }],
        })
      ),
    ]);
    expect(result.profileCount).toBe(2);
    expect(result.localDataSetCount).toBe(2);
    expect(result.items.history).toHaveLength(2);
    expect(result.items.history[1]?.lastVisitTime).toBe(1_720_000_001_000);
  });

  it("parses quoted Safari and Google password CSV without mixing notes into secrets", () => {
    const safari = recognizeBrowserExport([
      entry(
        "Safari/Passwords.csv",
        'Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.test,"user,one","p""ass",private,otpauth://secret'
      ),
    ]);
    expect(safari.items.passwords).toEqual([
      { url: "https://example.test", username: "user,one", password: 'p"ass' },
    ]);

    const google = recognizeBrowserExport([
      entry(
        "Google Password Manager/passwords.csv",
        "name,url,username,password,note\nSite,https://g.test,u,p,n"
      ),
    ]);
    expect(google.browser).toBe("generic");
    expect(google.items.passwords[0]?.url).toBe("https://g.test");
  });

  it("parses practical Google Takeout Chrome bookmark and history JSON", () => {
    const result = recognizeBrowserExport([
      entry(
        "Takeout/Chrome/Bookmarks.json",
        JSON.stringify({
          roots: {
            bookmark_bar: {
              type: "folder",
              name: "Bookmarks bar",
              children: [
                {
                  type: "url",
                  name: "Google",
                  url: "https://google.test",
                  date_added: "13344473600000000",
                },
              ],
            },
          },
        })
      ),
      entry(
        "Takeout/Chrome/BrowserHistory.json",
        JSON.stringify({
          "Browser History": [
            { url: "https://history.test", title: "History", time_usec: 1_720_000_000_123_000 },
          ],
        })
      ),
    ]);
    expect(result.browser).toBe("chrome");
    expect(result.items.bookmarks[0]?.folder).toEqual(["Bookmarks bar"]);
    expect(result.items.bookmarks[0]?.dateAdded).toBe(1_700_000_000_000);
    expect(result.items.history[0]?.lastVisitTime).toBe(1_720_000_000_123);
  });

  it("inspects categories without returning imported values and parses only selected categories", () => {
    const entries = [
      entry(
        "Bookmarks.html",
        '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="https://public.test">Public</A></DL>'
      ),
      entry(
        "passwords.csv",
        "url,username,password\nhttps://secret.test,private-user,private-password"
      ),
    ];
    const inspection = inspectBrowserExport(entries);
    expect(inspection.supportedDataTypes).toEqual(["bookmarks", "passwords"]);
    expect(JSON.stringify(inspection)).not.toContain("private-password");

    const selected = parseSelectedBrowserExport(entries, ["bookmarks"]);
    expect(selected.items.bookmarks).toHaveLength(1);
    expect(selected.items.passwords).toEqual([]);
    expect(selected.supportedDataTypes).toEqual(["bookmarks", "passwords"]);
  });

  it("rejects unsafe and duplicate canonical names before parsing", () => {
    const result = parseBrowserImportArchive([
      entry("../Passwords.csv", "url,username,password\nhttps://secret.test,u,do-not-leak"),
      entry("A/Bookmarks.html", "plain"),
      entry("a/bookmarks.html", "plain"),
    ]);
    expect(result.errors.map((item) => item.code)).toEqual([
      "unsafe_entry_name",
      "duplicate_entry",
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("do-not-leak");
  });

  it("enforces entry count, entry byte, total byte, and row limits", () => {
    expect(
      parseBrowserImportArchive([entry("a", "x"), entry("b", "x")], { maxEntries: 1 }).errors[0]
        ?.code
    ).toBe("entry_limit_exceeded");
    expect(
      parseBrowserImportArchive([entry("a", "xx")], { maxEntryBytes: 1 }).errors[0]?.code
    ).toBe("entry_size_exceeded");
    expect(
      parseBrowserImportArchive([entry("a", "x"), entry("b", "x")], { maxTotalBytes: 1 }).errors[0]
        ?.code
    ).toBe("total_size_exceeded");
    expect(
      parseBrowserImportArchive(
        [entry("passwords.csv", "url,username,password\nhttps://a.test,u,a\nhttps://b.test,u,b")],
        {
          maxCsvRows: 1,
        }
      ).errors[0]?.code
    ).toBe("row_limit_exceeded");
    expect(
      parseBrowserImportArchive(
        [
          entry(
            "history.json",
            JSON.stringify({
              history: [
                { url: "https://a.test", visitTime: 1 },
                { url: "https://b.test", visitTime: 2 },
              ],
            })
          ),
        ],
        { maxJsonRows: 1 }
      ).errors[0]?.code
    ).toBe("row_limit_exceeded");
  });

  it("bounds bookmark hierarchy and record count", () => {
    const deep =
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><H3>A</H3><DL><H3>B</H3><DL><A HREF="https://a.test">A</A></DL></DL>';
    expect(
      parseBrowserImportArchive([entry("bookmarks.html", deep)], { maxFolderDepth: 1 }).errors[0]
        ?.code
    ).toBe("folder_depth_exceeded");
    const two =
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="https://a.test">A</A><A HREF="https://b.test">B</A></DL>';
    expect(
      parseBrowserImportArchive([entry("bookmarks.html", two)], { maxBookmarkNodes: 1 }).errors[0]
        ?.code
    ).toBe("bookmark_limit_exceeded");
  });

  it("reports malformed data with fixed messages that do not contain record values", () => {
    const result = parseBrowserImportArchive([
      entry("bad.json", '{"history":["credential-secret"'),
      entry("bad.csv", 'url,username,password\nhttps://example.test,user,"credential-secret'),
    ]);
    expect(result.errors.map((item) => item.code)).toEqual(["invalid_json", "invalid_csv"]);
    expect(JSON.stringify(result.errors)).not.toContain("credential-secret");
  });
});
