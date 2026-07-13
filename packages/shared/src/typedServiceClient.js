/**
 * Runtime companion for typedServiceClient.ts.
 *
 * Some extension child processes load @vibestudio/shared source through Node's
 * native TS loader. That loader resolves literal relative ".js" specifiers
 * against the filesystem and does not rewrite them to ".ts". Keep this file
 * in sync with the runtime helpers in typedServiceClient.ts so imports such as
 * "../typedServiceClient.js" work in both bundled TS and direct Node ESM paths.
 */

export function defineServiceMethods(methods) {
  return methods;
}

function schemaFailure(service, method, boundary, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Service "${service}" method "${method}" ${boundary} failed schema validation: ${detail}`,
    { cause: error }
  );
}

export async function callTypedServiceMethod(service, methods, call, method, args) {
  const definition = methods[method];
  if (!definition) throw new Error(`Service "${service}" has no method "${method}"`);
  let parsedArgs;
  try {
    const tupleItems = definition.args?._def?.items;
    const paddedArgs = tupleItems
      ? [...args, ...Array(Math.max(0, tupleItems.length - args.length))]
      : args;
    parsedArgs = definition.args.parse(paddedArgs);
    while (parsedArgs.length > args.length && parsedArgs.at(-1) === undefined) parsedArgs.pop();
  } catch (error) {
    throw schemaFailure(service, method, "arguments", error);
  }
  const result = await call(service, method, parsedArgs);
  if (!definition.returns) return result;
  try {
    return definition.returns.parse(result);
  } catch (error) {
    throw schemaFailure(service, method, "return value", error);
  }
}

export function createTypedServiceClient(service, methods, call) {
  const root = {};
  for (const fullName of Object.keys(methods)) {
    const segments = fullName.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = (node[segment] ??= {});
      if (typeof next !== "object" || next === null) {
        throw new Error(
          `Service "${service}" method "${fullName}" collides with non-group method "${segment}"`
        );
      }
      node = next;
    }
    const leaf = segments[segments.length - 1];
    if (node[leaf] !== undefined) {
      throw new Error(`Service "${service}" method "${fullName}" collides with group "${leaf}"`);
    }
    node[leaf] = (...args) => callTypedServiceMethod(service, methods, call, fullName, args);
  }
  return root;
}
