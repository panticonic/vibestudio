import { describe, expect, it } from "vitest";
import {
  HOSTED_MODEL_ROUTE_ENV,
  readHostedModelRoute,
  assertHostedModelAllowed,
} from "./hostedModelRoute.js";
const route = { primary: "openai-codex:gpt-6-luna", fallback: null };
describe("owner hosted-model route", () => {
  it("is unset by default and admits ordinary product choices", () => {
    expect(readHostedModelRoute({})).toBeNull();
    expect(() => assertHostedModelAllowed(null, "openai-codex:gpt-6-sol")).not.toThrow();
  });
  it("requires an exact typed canonical route rather than silently ignoring malformed configuration", () => {
    for (const raw of [
      "",
      "null",
      "[]",
      "{}",
      '{"primary":"executor","fallback":null}',
      '{"primary":"openai-codex:gpt-6-luna"}',
      '{"primary":"openai-codex:gpt-6-luna","fallback":false}',
      '{"primary":"openai-codex:gpt-6-luna","fallback":null,"other":true}',
    ])
      expect(() => readHostedModelRoute({ [HOSTED_MODEL_ROUTE_ENV]: raw })).toThrow(
        HOSTED_MODEL_ROUTE_ENV
      );
  });
  it("admits only configured canonical primary and fallback targets", () => {
    const parsed = readHostedModelRoute({ [HOSTED_MODEL_ROUTE_ENV]: JSON.stringify(route) });
    expect(parsed).toEqual(route);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => assertHostedModelAllowed(parsed, route.primary)).not.toThrow();
    expect(() => assertHostedModelAllowed(parsed, "openai-codex:gpt-6-sol")).toThrow(
      "Host owner's configured"
    );
    const fallback = readHostedModelRoute({
      [HOSTED_MODEL_ROUTE_ENV]: JSON.stringify({ ...route, fallback: "anthropic:permitted" }),
    });
    expect(() => assertHostedModelAllowed(fallback, "anthropic:permitted")).not.toThrow();
  });
});
