declare module "natlang:services" {
  export const ownedReader: {read(id:string): Promise<import("./review/discovery/private.js").PrivateValue>};
}
