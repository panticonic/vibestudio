import React from "react";
import { Alert, NativeModules } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import Clipboard from "@react-native-clipboard/clipboard";
import {
  clearShellCredential,
  loadShellCredential,
  persistStoredShellCredential,
} from "@vibestudio/mobile-webrtc";
import { SettingsScreen } from "./SettingsScreen";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import {
  listMobileWorkspaces,
  mobileWorkspaceSelectionDependencies,
  selectMobileWorkspace,
} from "../services/workspaceSelection";
import { setApprovedAppCapabilities } from "../services/appCapabilities";

jest.mock("../services/workspaceSelection", () => ({
  listMobileWorkspaces: jest.fn(),
  mobileWorkspaceSelectionDependencies: jest.fn((control) => ({ control })),
  selectMobileWorkspace: jest.fn(),
}));

jest.mock("@vibestudio/mobile-webrtc", () => ({
  clearShellCredential: jest.fn(async () => undefined),
  loadShellCredential: jest.fn(),
  persistStoredShellCredential: jest.fn(async () => undefined),
}));

jest.mock("./ConnectionBar", () => ({
  ConnectionBar: () => null,
}));

const listMock = listMobileWorkspaces as jest.MockedFunction<typeof listMobileWorkspaces>;
const selectMock = selectMobileWorkspace as jest.MockedFunction<typeof selectMobileWorkspace>;
const dependenciesMock = mobileWorkspaceSelectionDependencies as jest.MockedFunction<
  typeof mobileWorkspaceSelectionDependencies
>;
const clearCredentialMock = clearShellCredential as jest.MockedFunction<
  typeof clearShellCredential
>;
const loadCredentialMock = loadShellCredential as jest.MockedFunction<typeof loadShellCredential>;
const persistCredentialMock = persistStoredShellCredential as jest.MockedFunction<
  typeof persistStoredShellCredential
>;
const nativeHost = NativeModules.VibestudioMobileHost as {
  resetToNativeBootstrap: jest.Mock;
};

const workspaces = [
  { workspaceId: "ws-a", name: "alpha", lastOpened: 10, running: true },
  { workspaceId: "ws-b", name: "beta", lastOpened: 5, running: false },
];

const profile = {
  userId: "usr_ada",
  handle: "ada",
  displayName: "Ada Lovelace",
  role: "member" as const,
  color: "#123abc",
  avatar: "data:image/png;base64,YXZhdGFy",
};

function renderSettings() {
  const store = createStore();
  store.set(connectionStatusAtom, "connected");
  const shellClient = {
    workspaceId: "ws-a",
    credentials: { deviceId: `dev_${"d".repeat(24)}` },
    hubControl: { listWorkspaces: jest.fn(), routeWorkspace: jest.fn() },
    dispose: jest.fn(),
    refreshAccountProfile: jest.fn(async () => profile),
    updateAccountProfile: jest.fn(async () => ({
      ...profile,
      handle: "ada-updated",
      displayName: "Ada Byron",
      color: "#abc",
      avatar: undefined,
    })),
  };
  store.set(shellClientAtom, shellClient as never);
  const navigation = { goBack: jest.fn(), replace: jest.fn() };
  return {
    ...render(
      <Provider store={store}>
        <SettingsScreen navigation={navigation as never} />
      </Provider>
    ),
    navigation,
    shellClient,
  };
}

describe("SettingsScreen workspace selector", () => {
  beforeEach(() => {
    setApprovedAppCapabilities(["clipboard"]);
    (Clipboard.getString as jest.Mock).mockReset().mockResolvedValue("");
    (Clipboard.hasImage as jest.Mock).mockReset().mockResolvedValue(false);
    listMock.mockReset().mockResolvedValue(workspaces);
    selectMock.mockReset().mockResolvedValue({} as never);
    dependenciesMock.mockClear();
    clearCredentialMock.mockReset().mockResolvedValue(undefined);
    loadCredentialMock.mockReset().mockResolvedValue({
      schemaVersion: 3,
      deviceId: `dev_${"d".repeat(24)}`,
      refreshToken: "r".repeat(43),
      controlPairing: {
        room: "control-1111",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      workspacePairing: {
        room: "workspace-a-1111",
        fp: "BB".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      pairedAt: 123,
    });
    persistCredentialMock.mockReset().mockResolvedValue(undefined);
    nativeHost.resetToNativeBootstrap.mockReset().mockResolvedValue({ reloading: true });
  });

  afterEach(() => {
    setApprovedAppCapabilities([]);
  });

  it("saves the current account profile and clears its avatar", async () => {
    const view = renderSettings();
    await waitFor(() => expect(view.getByLabelText("Display name")).toBeTruthy());

    fireEvent.changeText(view.getByLabelText("Display name"), "Ada Byron");
    fireEvent.changeText(view.getByLabelText("Handle"), "ada-updated");
    fireEvent.changeText(view.getByLabelText("Profile color"), "#abc");
    fireEvent.press(view.getByLabelText("Clear avatar"));
    fireEvent.press(view.getByTestId("profile-save"));

    await waitFor(() =>
      expect(view.shellClient.updateAccountProfile).toHaveBeenCalledWith({
        displayName: "Ada Byron",
        handle: "ada-updated",
        color: "#abc",
        avatar: null,
      })
    );
    expect(view.getByText("Profile saved.")).toBeTruthy();
  });

  it("sets a new avatar from the clipboard and previews it before save", async () => {
    const avatar = `data:image/png;base64,${"A".repeat(32)}`;
    (Clipboard.getString as jest.Mock).mockResolvedValueOnce(avatar);
    const view = renderSettings();
    await waitFor(() => expect(view.getByLabelText("Paste profile avatar")).toBeTruthy());

    fireEvent.press(view.getByLabelText("Paste profile avatar"));
    await waitFor(() =>
      expect(view.getByLabelText("Profile avatar preview").props.source).toEqual({ uri: avatar })
    );
    fireEvent.press(view.getByTestId("profile-save"));

    await waitFor(() =>
      expect(view.shellClient.updateAccountProfile).toHaveBeenCalledWith(
        expect.objectContaining({ avatar })
      )
    );
  });

  it("keeps the profile form usable when server validation rejects a save", async () => {
    const view = renderSettings();
    view.shellClient.updateAccountProfile.mockRejectedValueOnce(
      new Error('Handle "taken" is already taken')
    );
    await waitFor(() => expect(view.getByLabelText("Handle")).toBeTruthy());

    fireEvent.changeText(view.getByLabelText("Handle"), "taken");
    fireEvent.press(view.getByTestId("profile-save"));

    await waitFor(() => expect(view.getByText('Handle "taken" is already taken')).toBeTruthy());
    expect(view.getByLabelText("Handle").props.editable).toBe(true);
  });

  it("shows loading, current workspace, and the account-visible choices", async () => {
    let resolveList: ((value: typeof workspaces) => void) | undefined;
    listMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    const view = renderSettings();

    expect(view.getByText("Loading workspaces…")).toBeTruthy();
    resolveList?.(workspaces);

    await waitFor(() => expect(view.getByTestId("workspace-option-ws-a")).toBeTruthy());
    expect(view.getByText("Current workspace")).toBeTruthy();
    expect(view.getByText("Starts when selected")).toBeTruthy();
    expect(view.getByTestId("workspace-option-ws-a").props.accessibilityState).toMatchObject({
      selected: true,
      disabled: true,
    });
  });

  it("routes a non-current workspace and exposes the pending reload state", async () => {
    selectMock.mockImplementationOnce(() => new Promise(() => undefined));
    const view = renderSettings();
    await waitFor(() => expect(view.getByTestId("workspace-option-ws-b")).toBeTruthy());

    fireEvent.press(view.getByTestId("workspace-option-ws-b"));

    expect(selectMock).toHaveBeenCalledWith(
      "ws-b",
      expect.objectContaining({ control: view.shellClient.hubControl })
    );
    expect(view.getByText("Switching…")).toBeTruthy();
    expect(view.getByTestId("workspace-option-ws-b").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
  });

  it("surfaces loading errors and retries in place", async () => {
    listMock
      .mockRejectedValueOnce(new Error("control reach unavailable"))
      .mockResolvedValueOnce(workspaces);
    const view = renderSettings();

    await waitFor(() =>
      expect(view.getByRole("alert").props.children).toBe("control reach unavailable")
    );
    fireEvent.press(view.getByText("Retry"));

    await waitFor(() => expect(view.getByTestId("workspace-option-ws-b")).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the live workspace intact when secure disconnect cannot commit", async () => {
    clearCredentialMock.mockRejectedValueOnce(new Error("keychain locked"));
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const view = renderSettings();
    await waitFor(() => expect(view.getByText("Disconnect")).toBeTruthy());

    fireEvent.press(view.getByText("Disconnect"));
    const confirmButtons = alert.mock.calls[0]?.[2] ?? [];
    await act(async () => {
      confirmButtons.find((button) => button.text === "Disconnect")?.onPress?.();
    });

    await waitFor(() => expect(clearCredentialMock).toHaveBeenCalledTimes(1));
    expect(nativeHost.resetToNativeBootstrap).not.toHaveBeenCalled();
    expect(view.shellClient.dispose).not.toHaveBeenCalled();
    expect(alert.mock.calls[1]?.[0]).toBe("Could not disconnect securely");
    alert.mockRestore();
  });

  it("restores the current credential when native reset fails", async () => {
    nativeHost.resetToNativeBootstrap.mockRejectedValueOnce(new Error("reload unavailable"));
    const previous = await loadCredentialMock();
    loadCredentialMock.mockResolvedValueOnce(previous);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const view = renderSettings();
    await waitFor(() => expect(view.getByText("Disconnect")).toBeTruthy());

    fireEvent.press(view.getByText("Disconnect"));
    const confirmButtons = alert.mock.calls[0]?.[2] ?? [];
    await act(async () => {
      confirmButtons.find((button) => button.text === "Disconnect")?.onPress?.();
    });

    await waitFor(() => expect(persistCredentialMock).toHaveBeenCalledWith(previous));
    expect(view.shellClient.dispose).not.toHaveBeenCalled();
    expect(alert.mock.calls[1]?.[0]).toBe("Could not open pairing");
    alert.mockRestore();
  });
});
