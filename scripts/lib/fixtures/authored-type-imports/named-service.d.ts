declare module "natlang:services" {
  export const ownedReader: {read(id:string): Promise<import("./named.js").RenamedValue>};
}
