import { expect, it } from "vitest";
import { windowsEnvironmentValue } from "./windowsEnvironment.js";

it("reads copied Windows environment keys without depending on process.env proxy behavior", () => {
  expect(windowsEnvironmentValue({ SYSTEMROOT: "C:\\Windows" }, "SystemRoot")).toBe("C:\\Windows");
  expect(
    windowsEnvironmentValue({ systemroot: "C:\\Windows", SystemRoot: "C:\\Windows" }, "SYSTEMROOT")
  ).toBe("C:\\Windows");
  expect(windowsEnvironmentValue({ SYSTEMROOT: undefined }, "SystemRoot")).toBeUndefined();
  expect(() =>
    windowsEnvironmentValue({ SYSTEMROOT: "C:\\one", SystemRoot: "D:\\two" }, "SystemRoot")
  ).toThrow(/Conflicting/);
});
