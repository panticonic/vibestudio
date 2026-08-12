import { contributedPanelCommandId, presentMobilePanelCommands } from "./mobilePanelCommands";

describe("mobile contributed panel commands", () => {
  it("turns the focused panel's commands into discoverable native rows", () => {
    const [item] = presentMobilePanelCommands([
      {
        id: "chat/conversation-actions",
        label: "Conversation actions",
        section: "Chat",
        hint: "People, agents, branches, and autonomy",
      },
    ]);

    expect(item).toEqual({
      id: "contributed-panel-command:chat%2Fconversation-actions",
      label: "Conversation actions",
      description: "Chat · People, agents, branches, and autonomy",
    });
    expect(contributedPanelCommandId(item!.id)).toBe("chat/conversation-actions");
  });

  it("does not confuse durable panel actions with contributed commands", () => {
    expect(contributedPanelCommandId("archive")).toBeNull();
    expect(contributedPanelCommandId("contributed-panel-command:%E0%A4%A")).toBeNull();
  });
});
