import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  isConnectLink,
  markConnectLinkConsumed,
  consumeConnectLinkReplay,
  parseConnectLink,
} from "@vibestudio/mobile-webrtc/connectLink";

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

// A structurally-valid v2 pairing link (scheme carrier).
const VALID_LINK =
  "vibestudio://connect?room=room-1234-5678&fp=" +
  "a".repeat(64) +
  "&code=abcdefghijklmnopqrstuvwxyzABCDEF&sig=wss%3A%2F%2Fsignal.example%2F&v=2&ice=all";

describe("connectLink", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset();
    storage.removeItem.mockReset();
  });

  describe("isConnectLink", () => {
    it("recognizes both pairing-link carrier forms", () => {
      expect(isConnectLink("vibestudio://connect?room=x")).toBe(true);
      expect(isConnectLink("https://vibestudio.app/pair#room=x")).toBe(true);
    });
    it("rejects clipboard garbage and other links", () => {
      expect(isConnectLink("https://example.com/pair")).toBe(false);
      expect(isConnectLink("not a url")).toBe(false);
      expect(isConnectLink(null)).toBe(false);
      expect(isConnectLink(undefined)).toBe(false);
      expect(isConnectLink(42)).toBe(false);
    });
  });

  describe("parseConnectLink (shared parser re-export)", () => {
    it("parses a valid v2 link", () => {
      const parsed = parseConnectLink(VALID_LINK);
      expect(parsed.kind).toBe("ok");
    });
    it("rejects a stale/old-version link", () => {
      const stale = VALID_LINK.replace("v=2", "v=1");
      const parsed = parseConnectLink(stale);
      expect(parsed.kind).toBe("error");
    });
  });

  describe("replay guard", () => {
    it("suppresses a consumed link throughout its replay TTL", async () => {
      await markConnectLinkConsumed(VALID_LINK, 1_000);
      expect(storage.setItem).toHaveBeenCalledWith(
        "vibestudio:connect:consumed-url",
        JSON.stringify({ url: VALID_LINK, consumedAt: 1_000 })
      );

      storage.getItem.mockResolvedValueOnce(JSON.stringify({ url: VALID_LINK, consumedAt: 1_000 }));
      await expect(consumeConnectLinkReplay(VALID_LINK, 2_000)).resolves.toBe(true);
      expect(storage.removeItem).not.toHaveBeenCalled();
    });

    it("does not suppress a different link", async () => {
      storage.getItem.mockResolvedValueOnce(JSON.stringify({ url: VALID_LINK, consumedAt: 1_000 }));
      await expect(
        consumeConnectLinkReplay("vibestudio://connect?room=other", 2_000)
      ).resolves.toBe(false);
    });

    it("does not suppress (and clears) a stale consumed link", async () => {
      storage.getItem.mockResolvedValueOnce(JSON.stringify({ url: VALID_LINK, consumedAt: 1_000 }));
      await expect(consumeConnectLinkReplay(VALID_LINK, 1_000 + 11 * 60 * 1_000)).resolves.toBe(
        false
      );
      expect(storage.removeItem).toHaveBeenCalledWith("vibestudio:connect:consumed-url");
    });

    it("ignores non-connect links entirely", async () => {
      await markConnectLinkConsumed("https://example.com", 1_000);
      expect(storage.setItem).not.toHaveBeenCalled();
      await expect(consumeConnectLinkReplay("https://example.com", 2_000)).resolves.toBe(false);
    });

    it("fails closed when the store read throws", async () => {
      storage.getItem.mockRejectedValueOnce(new Error("store unavailable"));
      await expect(consumeConnectLinkReplay(VALID_LINK, 2_000)).resolves.toBe(false);
    });
  });
});
