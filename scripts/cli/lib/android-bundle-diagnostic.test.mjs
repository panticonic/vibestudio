import test from "node:test";
import assert from "node:assert/strict";
import {
  activeBundleCacheRelativePath,
  bundleLineExcerpt,
  parseHermesLocation,
} from "./android-bundle-diagnostic.mjs";

test("extracts only a bundle path inside the app's React Native cache", () => {
  assert.equal(
    activeBundleCacheRelativePath(
      '<map><string name="activeBundle.localPath">/data/user/0/app.vibestudio/cache/vibestudio-rn/build_1/index.android.bundle</string></map>'
    ),
    "cache/vibestudio-rn/build_1/index.android.bundle"
  );
  assert.throws(
    () => activeBundleCacheRelativePath('<string name="activeBundle.localPath">/tmp/index.bundle</string>'),
    /outside the app bundle cache/
  );
  assert.throws(
    () => activeBundleCacheRelativePath('<string name="activeBundle.localPath">/data/cache/vibestudio-rn/../secret</string>'),
    /invalid cache path/
  );
});

test("extracts Hermes line and column and formats a bounded source excerpt", () => {
  const location = parseHermesLocation("SyntaxError: invalid expression (line 9, column 4)");
  assert.deepEqual(location, { line: 9, column: 4 });
  const source = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
  const excerpt = bundleLineExcerpt(source, location);
  assert.equal(excerpt.split("\n").filter((line) => /^\s*[> ]\s*\d+ \|/.test(line)).length, 7);
  assert.match(excerpt, />\s+9 \| line-9/);
  assert.match(excerpt, /\^/);
});

test("parses the managed bundle compiler's bare line and column signature", () => {
  assert.deepEqual(
    parseHermesLocation("10-12 19:59:14.307 E/AndroidRuntime: Compiling JS failed: 301:1233:';' expected"),
    { line: 301, column: 1233 }
  );
  assert.equal(parseHermesLocation("10-12 19:59:14.307 E/AndroidRuntime: reload failed"), null);
});

test("caps excerpt content around a location on a minified bundle line", () => {
  const longLine = `prefix${"x".repeat(20_000)}target${"y".repeat(20_000)}`;
  const excerpt = bundleLineExcerpt(longLine, { line: 1, column: 20_007 });
  assert.ok(excerpt.length < 450);
  assert.match(excerpt, /…/);
  assert.match(excerpt, /\^/);
  assert.ok(!excerpt.includes("x".repeat(1_000)));
  assert.ok(bundleLineExcerpt("short", { line: 1, column: 20_000 }).length < 300);
});

test("returns no excerpt when Hermes does not report an in-range location", () => {
  assert.equal(parseHermesLocation("SyntaxError: unsupported token"), null);
  assert.equal(bundleLineExcerpt("one\ntwo", { line: 3, column: 1 }), null);
});
