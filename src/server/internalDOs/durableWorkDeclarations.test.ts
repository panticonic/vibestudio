import { describe, expect, it } from "vitest";
import { readDurableWorkDeclaration } from "../../../scripts/durableWorkDeclarations.js";

describe("sealed product durable work declarations", () => {
  it("reads only the selected class literal and canonicalizes its declared queues", () => {
    const source = `export class Other { static durableWorkQueues = []; }
      export class Owner extends Other { static override readonly durableWorkQueues = ["workspace-publication", "channel-delivery"] as const; }`;
    expect(readDurableWorkDeclaration(source, "Owner", "owner.ts")).toEqual([
      "channel-delivery",
      "workspace-publication",
    ]);
  });
  it("refuses missing or dynamic declarations rather than guessing no owned work", () => {
    for (const source of [
      `export class Owner {}`,
      `export class Owner { static durableWorkQueues = configuredQueues; }`,
      `export class Owner { static get durableWorkQueues() { return []; } }`,
      `export class Owner { static durableWorkQueues = [...shared]; }`,
    ])
      expect(() => readDurableWorkDeclaration(source, "Owner", "owner.ts")).toThrow(
        "literal static"
      );
    expect(() =>
      readDurableWorkDeclaration(
        `export class Owner { static durableWorkQueues = ["invented"]; }`,
        "Owner",
        "owner.ts"
      )
    ).toThrow("Invalid durable-work receipt");
  });
});
