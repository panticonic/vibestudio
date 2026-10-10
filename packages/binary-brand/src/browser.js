// Browsers have no nonthrowing ArrayBuffer brand predicate. The intrinsic
// getter preserves correctness across realms and altered prototypes/tags.
const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;

export function isArrayBuffer(value) {
  try {
    byteLength.call(value);
    return true;
  } catch {
    return false;
  }
}
