/**
 * The Hermes web-API polyfills (see `installPolyfills.ts`). Metro resolves
 * `./polyfills.js` to `polyfills.native.ts` (platform extensions), so the
 * implementation lives in its own module that both entries import; importing
 * it by the entry's own name would make the native entry import itself.
 */
import "./installPolyfills.js";
