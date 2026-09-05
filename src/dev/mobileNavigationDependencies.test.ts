import { describe, expect, it } from "vitest";
import { getPathFromState, getStateFromPath } from "@react-navigation/core";

const options = { screens: { Item: { path: "items/:id" } } };

describe("installed navigation query integration", () => {
  it("preserves Unicode, literal plus signs, repeated keys, empty values and flags", () => {
    const state = getStateFromPath(
      "/items/42?name=caf%C3%A9+%2B+tea&tag=one&tag=two&blank=&flag",
      options
    );
    const params = { id: "42", name: "café + tea", tag: ["one", "two"], blank: "", flag: null };
    expect(state?.routes[0]?.params).toEqual(params);
    const path = getPathFromState(state!, options);
    expect(getStateFromPath(path, options)?.routes[0]?.params).toEqual(params);
  });

  it("keeps default scalar values as strings and applies declared parsers", () => {
    expect(
      getStateFromPath("/items/007?count=02&enabled=true", options)?.routes[0]?.params
    ).toEqual({
      id: "007",
      count: "02",
      enabled: "true",
    });
    const typed = { screens: { Item: { path: "items/:id", parse: { count: Number } } } };
    expect(getStateFromPath("/items/007?count=02", typed)?.routes[0]?.params).toEqual({
      id: "007",
      count: 2,
    });
  });

  it.each(["%", "%E0%A4%A", "%FF", "%C0%AF", "%F0%9F%92"])(
    "tolerates malformed query encoding %s",
    (value) => {
      const state = getStateFromPath(`/items/42?q=${value}`, options);
      expect(state?.routes[0]?.params).toMatchObject({ id: "42", q: expect.any(String) });
      expect(() => getPathFromState(state!, options)).not.toThrow();
    }
  );

  it("parses long malformed queries without recursive decoding", () => {
    const value = "%FF".repeat(10_000);
    expect(getStateFromPath(`/items/42?q=${value}`, options)?.routes[0]?.params).toMatchObject({
      id: "42",
      q: value,
    });
  });
});
