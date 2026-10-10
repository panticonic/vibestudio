// Node and workerd expose the nonthrowing internal-slot predicate. Using the
// byteLength getter instead would throw for every ordinary JSON object.
export { isArrayBuffer } from "node:util/types";
