import { describe, expect, it, vi } from "vitest";
vi.mock("./polyfills.js", () => ({}));
vi.mock("react-native", () => ({ AppState: {}, NativeModules: {} }));
vi.mock("react-native-keychain", () => ({}));
import { MobileEndpointPool } from "./connect.js";

describe("MobileEndpointPool relay configuration", () => {
  it("shares one endpoint when peers prefer different homes in the same relay set", async () => {
    const relays = ["https://us.example/", "https://eu.example/"];
    const pool = new MobileEndpointPool("identity", relays);
    expect(() => pool.acquire(relays)).not.toThrow();
    expect(() => pool.acquire([...relays].reverse())).not.toThrow();
    expect(() => pool.acquire(["https://other.example/", relays[1]!])).toThrow(
      "same Iroh relay set"
    );
    await pool.release();
    await pool.release();
  });
});
