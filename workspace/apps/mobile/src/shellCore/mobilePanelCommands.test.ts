import { contributedHostCommandId, presentMobileHostCommands } from "./mobilePanelCommands";

describe("mobile contributed panel commands", () => {
  it("turns the focused panel's commands into discoverable native rows", () => {
    const [item] = presentMobileHostCommands([
      {
        id: "chat/conversation-actions",
        label: "Conversation actions",
        group: "Chat",
        description: "People, agents, branches, and autonomy",
      },
    ]);

    expect(item).toEqual({
      id: "contributed-panel-command:chat%2Fconversation-actions",
      label: "Conversation actions",
      description: "Chat · People, agents, branches, and autonomy",
    });
    expect(contributedHostCommandId(item!.id)).toBe("chat/conversation-actions");
  });

  it("does not confuse durable panel actions with contributed commands", () => {
    expect(contributedHostCommandId("archive")).toBeNull();
    expect(contributedHostCommandId("contributed-panel-command:%E0%A4%A")).toBeNull();
  });
});
