declare module "natlang:services" {
  export const ownedReader: {read(id:string): Promise<import("@workspace-skills/owned/types").OwnedValue>};
}
