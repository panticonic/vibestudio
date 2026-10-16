/** Type declaration for the actual export supplied by React Native's fetch
 * dependency. No fetch replacement or runtime adapter is installed here. */
declare module "whatwg-fetch" {
  export const DOMException: new (message?: string, name?: string) => Error;
}
