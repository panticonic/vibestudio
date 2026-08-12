import { Share } from "react-native";
import { shareText } from "./nativeCapabilities";

describe("nativeCapabilities", () => {
  it("hands panel addresses to the operating system share sheet", async () => {
    const share = jest.spyOn(Share, "share").mockResolvedValue({
      action: Share.sharedAction,
    });

    await shareText("panels/chat", "Agentic Chat");

    expect(share).toHaveBeenCalledWith(
      { title: "Agentic Chat", message: "panels/chat" },
      { dialogTitle: "Share Agentic Chat", subject: "Agentic Chat" }
    );
  });
});
