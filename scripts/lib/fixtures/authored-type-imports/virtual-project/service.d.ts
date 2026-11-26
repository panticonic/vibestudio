declare module "natlang:services" {
  export const ownedReader: {read(id:string): Promise<import("./review/discovery/types.js").MountedValue>};
}
