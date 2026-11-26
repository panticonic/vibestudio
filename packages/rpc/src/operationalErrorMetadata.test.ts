import { expect, it } from "vitest";
import { operationalErrorMetadata, errorDataProperty, setErrorStack } from "./operationalErrorMetadata.js";
import { serializeRpcFailure, deserializeRpcFailure } from "./errors.js";
it("retains real nested OS causes through RPC without adding request data to diagnostics", () => {
  const cause = Object.assign(new Error("secret request https://user:password@example"), {
    code: "ETIMEDOUT",
    syscall: "connect",
    phase: "connect",
    address: "192.0.2.1",
    port: 443,
    errno: -110,
    headers: { authorization: "secret" },
  });
  const error = new TypeError("fetch failed", {
    cause: new AggregateError([cause], "connect failures"),
  });
  const expected = {
    name: "TypeError",
    cause: {
      name: "AggregateError",
      errors: [
        {
          name: "Error",
          code: "ETIMEDOUT",
          syscall: "connect",
          phase: "connect",
          address: "192.0.2.1",
          port: 443,
          errno: -110,
        },
      ],
    },
  };
  expect(operationalErrorMetadata(error)).toEqual(expected);
  const remote = deserializeRpcFailure(JSON.parse(JSON.stringify(serializeRpcFailure(error))));
  expect(operationalErrorMetadata(remote)).toEqual(expected);
  expect(JSON.stringify(operationalErrorMetadata(remote))).not.toMatch(
    /secret|password|headers|message|stack/
  );
});
it("does not execute error or aggregate array getters, conversions or toJSON", () => {
  let reads = 0;
  const forbidden = () => {
    reads++;
    throw Error("observer hook");
  };
  const error = Object.create(null);
  for (const key of [
    "name",
    "message",
    "code",
    "stack",
    "cause",
    "errors",
    "systemError",
    "errorData",
    "errorKind",
    "syscall",
    "address",
  ])
    Object.defineProperty(error, key, { get: forbidden });
  Object.defineProperty(error, "toString", { value: forbidden });
  Object.defineProperty(error, "toJSON", { value: forbidden });
  expect(operationalErrorMetadata(error)).toEqual({});
  expect(() => serializeRpcFailure(error)).not.toThrow();
  const errors = [new Error("allowed")];
  Object.defineProperty(errors, 1, { enumerable: true, get: forbidden });
  expect(operationalErrorMetadata({ errors })).toEqual({ errors: [{ name: "Error" }] });
  expect(reads).toBe(0);
});
it("bounds cyclic/deep aggregate evidence and excludes nonoperational address/code content", () => {
  const error: any = { code: "https://secret", address: "user:password@example", port: 999999 };
  error.cause = error;
  expect(operationalErrorMetadata(error)).toEqual({ cause: { circular: true } });
  expect(
    operationalErrorMetadata({ errors: Array.from({ length: 20 }, () => ({ code: "EIO" })) })
  ).toMatchObject({ truncated: true, errors: [{ code: "EIO" }, { code: "EIO" }, { code: "EIO" }] });
  expect(
    errorDataProperty(
      {
        get x() {
          throw Error("no");
        },
      },
      "x"
    )
  ).toBeUndefined();
});

it("inspects only the bounded aggregate prefix without enumerating a huge array", () => {
  let descriptors = 0;
  const errors = new Proxy(new Array(100000000), {
    ownKeys() {
      throw Error("must not enumerate");
    },
    getOwnPropertyDescriptor(target, key) {
      descriptors++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  expect(operationalErrorMetadata({ errors })).toEqual({ errors: [], truncated: true });
  expect(descriptors).toBeLessThanOrEqual(6);
});

it("restored stack data survives another RPC boundary without evaluating accessors", () => {
 const error = new Error("native failure");
 setErrorStack(error, "native retained stack");
 const restored = deserializeRpcFailure(serializeRpcFailure(error));
 expect(Object.getOwnPropertyDescriptor(restored, "stack")?.value).toBe("native retained stack");
 expect(serializeRpcFailure(restored).stack).toBe("native retained stack");
});
