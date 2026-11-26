declare module "natlang:services" {
  export const ownedReader: {read(id:string): Promise<import("./barrel.js").OwnedValue>};
}
