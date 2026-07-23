/**
 * Intrinsics and web-platform values deliberately visible to confined eval
 * source and dynamically built library modules. Host authority (process,
 * network primitives, RPC kernels, loader hooks) is never copied here.
 */
const SAFE_GUEST_GLOBALS = [
  "AbortController", "AbortSignal", "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array",
  "BigUint64Array", "Blob", "Boolean", "DOMException", "DataView", "Date", "Error",
  "EvalError", "FinalizationRegistry", "Float32Array", "Float64Array", "FormData",
  "Headers", "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl", "JSON",
  "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
  "ReferenceError", "Reflect", "RegExp", "Request", "Response", "Set",
  "SharedArrayBuffer", "String", "Symbol", "SyntaxError", "TextDecoder", "TextEncoder",
  "TypeError", "URIError", "URL", "URLSearchParams", "Uint16Array", "Uint32Array",
  "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "WebAssembly",
  "Buffer", "atob", "btoa", "clearInterval", "clearTimeout", "crypto", "decodeURI",
  "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "isFinite",
  "isNaN", "parseFloat", "parseInt", "performance", "queueMicrotask", "setInterval",
  "setTimeout", "structuredClone", "undefined", "unescape",
] as const;

const SAFE_CONSOLE_METHODS = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
] as const;

// Workerd implements several web-platform globals as receiver-sensitive host
// functions. A confined scope necessarily moves them off globalThis, so bind
// only the explicitly reviewed callable primitives. Constructors and objects
// stay unwrapped to preserve their prototypes and static methods.
const RECEIVER_SENSITIVE_GUEST_FUNCTIONS = new Set<string>([
  "atob",
  "btoa",
  "clearInterval",
  "clearTimeout",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "structuredClone",
]);

/**
 * Function constructors reachable from any ordinary value: `({}).constructor`
 * is `Object`, whose `.constructor` is `Function`. Hiding the *name* `Function`
 * from the guest scope therefore hides nothing — a private global is only a
 * boundary in a realm where these cannot compile code.
 */
const CODEGEN_SAMPLE_SOURCE =
  "return [function(){}, async function(){}, function*(){}, async function*(){}]";

/** Realms this module has tamed, mapped to the compile capability taken from them. */
const TAMED_REALMS = new WeakMap<object, FunctionConstructor>();

function inertConstructor(name: string, prototype: unknown): FunctionConstructor {
  const inert = function () {
    throw new TypeError(
      `${name} is disabled: this realm does not permit dynamic code generation`
    );
  } as unknown as FunctionConstructor;
  Object.defineProperty(inert, "name", { value: name, configurable: true });
  Object.defineProperty(inert, "prototype", {
    value: prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return Object.freeze(inert);
}

/** Does `candidate` still turn a string into running code? */
function compilesCode(candidate: unknown): boolean {
  if (typeof candidate !== "function") return false;
  const compile = candidate as (source: string) => unknown;
  try {
    const compiled = compile("return 1");
    if (typeof compiled === "function" && (compiled as () => unknown)() === 1) return true;
  } catch {
    // not a Function-style compiler (or codegen is refused) — try eval-style below
  }
  try {
    if (compile("1") === 1) return true;
  } catch {
    // refuses to compile
  }
  return false;
}

/**
 * Can guest code in `realm` reach a working compiler? True whenever `Function`
 * or `eval` still compile — the constructor chains (`({}).constructor.constructor`,
 * the async/generator function constructors) all terminate in those intrinsics,
 * and engines that block dynamic codegen (workerd) block every one of them
 * together.
 */
export function isCodegenReachable(
  realm: Record<string, unknown> = globalThis as Record<string, unknown>
): boolean {
  if (TAMED_REALMS.has(realm as unknown as object)) return false;
  if (compilesCode(realm["Function"]) || compilesCode(realm["eval"])) return true;
  if ((realm as unknown) === globalThis) {
    // Same realm as this module: check the constructor chains directly rather
    // than inferring them from `Function`.
    for (const sample of [
      function () {},
      async function () {},
      function* () {},
      async function* () {},
    ]) {
      const proto = Object.getPrototypeOf(sample) as { constructor?: unknown } | null;
      if (compilesCode(proto?.constructor)) return true;
    }
  }
  return false;
}

/**
 * Remove `realm`'s ability to compile source at runtime: `eval`, `Function`, and
 * the async/generator function constructors reachable as `.constructor` on any
 * value are replaced with inert throwing stand-ins that keep their prototypes.
 * This is the SES `lockdown()` codegen repair, done narrowly, and is the
 * precondition `createPrivateGuestGlobal` enforces in realms whose engine does
 * not already refuse dynamic codegen (workerd does; Node does not).
 *
 * Realm-wide and irreversible by design: after this call nothing in the realm —
 * host code included — can compile source. Bootstraps that still need to compile
 * (the eval kernel does) take the capability from the returned constructor, which
 * is the realm's real `Function` captured before taming.
 *
 * Idempotent; returns the same captured constructor on repeat calls.
 */
export function tameRealmCodegen(
  realm: Record<string, unknown> = globalThis as Record<string, unknown>
): FunctionConstructor {
  const key = realm as unknown as object;
  const captured = TAMED_REALMS.get(key);
  if (captured) return captured;

  const realmFunction = realm["Function"] as FunctionConstructor | undefined;
  if (typeof realmFunction !== "function") {
    throw new TypeError("Cannot tame a realm without a Function constructor");
  }

  // Mint the samples with the realm's own (still working) compiler so the
  // prototypes we repair belong to `realm`, not to this module's realm.
  const samples = (new realmFunction(CODEGEN_SAMPLE_SOURCE) as unknown as () => unknown[])();
  for (const sample of samples) {
    const proto = Object.getPrototypeOf(sample) as { constructor?: unknown } | null;
    if (!proto) continue;
    const ctor = proto.constructor;
    if (typeof ctor !== "function") continue;
    Object.defineProperty(proto, "constructor", {
      value: inertConstructor(ctor.name || "Function", proto),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  const inertFunction = (Object.getPrototypeOf(samples[0]) as { constructor: FunctionConstructor })
    .constructor;
  Object.defineProperty(realm, "Function", {
    value: inertFunction,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  if (typeof realm["eval"] === "function") {
    Object.defineProperty(realm, "eval", {
      value: inertConstructor("eval", undefined),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  TAMED_REALMS.set(key, realmFunction);
  return realmFunction;
}

/**
 * The realm's compile capability: its real `Function` if the realm was tamed by
 * `tameRealmCodegen`, else whatever `Function` it currently has. Host code that
 * must compile (the eval kernel's `compileFunction`) goes through here so taming
 * a realm does not disarm the kernel that runs inside it.
 */
export function getRealmCompiler(
  realm: Record<string, unknown> = globalThis as Record<string, unknown>
): FunctionConstructor {
  return (
    TAMED_REALMS.get(realm as unknown as object) ?? (realm["Function"] as FunctionConstructor)
  );
}

/**
 * Make a null-prototype scope that claims every free identifier. Used as the
 * outer `with` environment for strict guest functions so name lookup cannot
 * fall through into the evaluator isolate.
 *
 * `realm` must be the realm guest code is *compiled in*: the guest builds
 * ordinary values there, and every such value hands back that realm's function
 * constructors. This throws unless that realm's codegen is unreachable, because
 * otherwise the scope is a naming convention rather than a boundary.
 *
 * The same rule applies to endowments passed into the scope: an endowment
 * carried in from a codegen-capable realm re-opens the escape through its own
 * `.constructor` chain, so endowments must come from the guest realm or another
 * codegen-free one. That is endowment discipline, not something this function
 * can check.
 */
export function createPrivateGuestGlobal(
  realm: Record<string, unknown> = globalThis as Record<string, unknown>,
  endowments: Readonly<Record<string, unknown>> = {}
): Record<PropertyKey, unknown> {
  if (isCodegenReachable(realm)) {
    throw new TypeError(
      "Refusing to build a private guest global in a realm that can still compile code: " +
        "guest code recovers the real global via ({}).constructor.constructor. Run the guest " +
        "in an engine that blocks dynamic codegen (workerd) or call tameRealmCodegen() at " +
        "realm bootstrap."
    );
  }
  const target = Object.create(null) as Record<PropertyKey, unknown>;
  for (const name of SAFE_GUEST_GLOBALS) {
    if (!(name in realm)) continue;
    const value = realm[name];
    target[name] =
      RECEIVER_SENSITIVE_GUEST_FUNCTIONS.has(name) && typeof value === "function"
        ? value.bind(realm)
        : value;
  }
  // Eval's named bindings are already reviewed endowments of this guest
  // invocation. Publish the same objects on the private facade so ordinary
  // Node-style `global.fs` and web-style `globalThis.fs` agree with the free
  // `fs` binding instead of exposing a second, weaker ambient contract.
  Object.assign(target, endowments);
  const realmConsole = realm["console"];
  if (realmConsole && typeof realmConsole === "object") {
    const guestConsole = Object.create(null) as Record<string, unknown>;
    for (const method of SAFE_CONSOLE_METHODS) {
      const value = (realmConsole as Record<string, unknown>)[method];
      if (typeof value === "function") guestConsole[method] = value.bind(realmConsole);
    }
    target["console"] = Object.freeze(guestConsole);
  }
  let guest: Record<PropertyKey, unknown>;
  guest = new Proxy(target, {
    has: () => true,
    get: (scope, property) => {
      if (property === Symbol.unscopables) return undefined;
      // Cross-target libraries commonly resolve their realm through
      // globalThis, the WorkerGlobalScope alias `self`, or Node's `global`.
      // Every spelling points at the confined facade, never the evaluator
      // isolate's real global.
      if (property === "globalThis" || property === "self" || property === "global") return guest;
      return Reflect.get(scope, property);
    },
    set: (scope, property, value) => Reflect.set(scope, property, value),
    getPrototypeOf: () => null,
  });
  return guest;
}
