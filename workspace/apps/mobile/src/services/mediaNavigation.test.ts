import { isPdfUrl, shouldOpenPdfExternally } from "./mediaNavigation";

describe("mobile media navigation", () => {
  it("recognizes PDF URLs without treating query strings as filenames", () => {
    expect(isPdfUrl("https://example.test/files/guide.PDF?download=1#page=2")).toBe(true);
    expect(isPdfUrl("https://example.test/files/guide%2Epdf")).toBe(true);
    expect(isPdfUrl("https://example.test/files/guide.pdfx")).toBe(false);
  });

  it("only hands HTTP(S) PDF URLs off to Android", () => {
    expect(shouldOpenPdfExternally("android", "http://127.0.0.1:3030/assets/guide.pdf")).toBe(true);
    expect(shouldOpenPdfExternally("ios", "https://example.test/guide.pdf")).toBe(false);
    expect(shouldOpenPdfExternally("android", "file:///tmp/guide.pdf")).toBe(false);
  });
});
