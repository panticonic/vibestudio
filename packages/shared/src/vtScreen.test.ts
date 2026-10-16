import { describe, expect, it } from "vitest";
import { VtScreen } from "./vtScreen.js";

function screen(cols = 20, rows = 5) {
  return new VtScreen({ cols, rows, convertEol: true });
}
const text = (s: VtScreen) => s.lines().join("\n").replace(/\n+$/u, "");

describe("VtScreen", () => {
  it("presents synchronized output only on DEC 2026 frame completion across chunks", () => {
    let frames = 0;
    const s = new VtScreen({ cols: 20, rows: 2, onFrame: () => frames++ });
    s.write("old");
    s.write("\x1b[?202");
    s.write("6h\rnew");
    expect(text(s)).toBe("old");
    expect(frames).toBe(0);
    s.write("\x1b[?2026l");
    expect(text(s)).toBe("new");
    expect(frames).toBe(1);
  });
  it("writes text, wraps at the right edge and scrolls at the bottom", () => {
    const s = screen(5, 2);
    s.write("abcdefgh\nij");
    expect(s.lines()).toEqual(["fgh", "ij"]);
  });

  it("decodes UTF-8 split across chunks and places wide characters in two cells", () => {
    const s = screen(10, 2);
    const bytes = new TextEncoder().encode("é💬x");
    s.write(bytes.slice(0, 1));
    s.write(bytes.slice(1, 4));
    s.write(bytes.slice(4));
    expect(s.lines()[0]).toBe("é💬x");
    s.write("\r\x1b[5Cz");
    expect(s.lines()[0]).toBe("é💬x z");
  });

  it("moves and addresses the cursor, and overwrites in place", () => {
    const s = screen();
    s.write("hello\x1b[2;3Hxy\x1b[1;1HJ\x1b[3;1Hbottom");
    expect(s.lines().slice(0, 3)).toEqual(["Jello", "  xy", "bottom"]);
    s.write("\x1b[1A\x1b[2Cq");
    expect(s.lines()[1]).toBe("  xy    q");
  });

  it("erases within a line, below the cursor and the whole display", () => {
    const s = screen();
    s.write("abcdef\r\n123456\x1b[1;4H\x1b[K");
    expect(s.lines().slice(0, 2)).toEqual(["abc", "123456"]);
    s.write("\x1b[1;2H\x1b[J");
    expect(s.lines().slice(0, 2)).toEqual(["a", ""]);
    s.write("\x1b[2J");
    expect(text(s)).toBe("");
  });

  it("redraws an Ink-style frame: erase the previous lines, then write the next", () => {
    const s = screen(20, 4);
    s.write("one\r\ntwo\r\n");
    s.write("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
    s.write("uno\r\ndos\r\n");
    expect(s.lines().slice(0, 2)).toEqual(["uno", "dos"]);
  });

  it("keeps the alternate screen separate from the main one", () => {
    const s = screen(10, 3);
    s.write("main");
    s.write("\x1b[?1049h\x1b[HALT");
    expect(s.lines()[0]).toBe("ALT");
    s.write("\x1b[?1049l");
    expect(s.lines()[0]).toBe("main");
  });

  it("inserts and deletes lines and characters, honouring a scroll region", () => {
    const s = screen(10, 4);
    s.write("a\r\nb\r\nc\r\nd\x1b[2;1H\x1b[L");
    expect(s.lines()).toEqual(["a", "", "b", "c"]);
    s.write("\x1b[M");
    expect(s.lines()).toEqual(["a", "b", "c", ""]);
    s.write("\x1b[1;1H\x1b[2P");
    expect(s.lines()[0]).toBe("");
    s.write("\x1b[2;3r\x1b[3;1H\n");
    expect(s.lines()).toEqual(["", "c", "", ""]);
  });

  it("ignores colours, titles, mode changes and unknown sequences", () => {
    const s = screen();
    s.write("\x1b[1;31mred\x1b[0m\x1b]0;a title\x07 \x1b]8;;http://x\x1b\\link\x1b[?2004h\x1b[?25l\x1b(B ok");
    expect(s.lines()[0]).toBe("red link ok");
  });
});
