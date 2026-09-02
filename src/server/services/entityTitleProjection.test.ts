import { describe, expect, it } from "vitest";
import { createEntityTitleProjection } from "./entityTitleProjection.js";

describe("entity title projection", () => {
  it("hydrates and tracks Base-owned titles synchronously", async () => {
    const projection = createEntityTitleProjection();
    await projection.hydrate(async () => [
      { id: "panel:chat", title: "  Import Trello into Flowboard  " },
    ]);

    expect(projection.get("panel:chat")).toBe("Import Trello into Flowboard");
    projection.observe("panel:chat", "Renamed chat");
    expect(projection.get("panel:chat")).toBe("Renamed chat");
    projection.remove("panel:chat");
    expect(projection.get("panel:chat")).toBeUndefined();
  });
});
