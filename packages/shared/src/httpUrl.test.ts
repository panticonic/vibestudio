import { describe, expect, it } from "vitest";
import { assertHttpUrl } from "./httpUrl.js";

describe("assertHttpUrl", () => {
  it.each(["https://example.com", "http://localhost:3000/path?q=1"])(
    "accepts %s",
    (url) => {
      expect(() => assertHttpUrl(url)).not.toThrow();
    }
  );

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "not a url"])(
    "rejects %s",
    (url) => {
      expect(() => assertHttpUrl(url)).toThrow("Invalid URL");
    }
  );
});
