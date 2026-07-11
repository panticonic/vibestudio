// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accountMock = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../shell/client", () => ({ account: accountMock }));

vi.mock("@radix-ui/themes", () => {
  const cleanLayoutProps = (props: Record<string, unknown>) => {
    const {
      align: _align,
      color: _color,
      direction: _direction,
      gap: _gap,
      justify: _justify,
      mb: _mb,
      mt: _mt,
      size: _size,
      variant: _variant,
      weight: _weight,
      wrap: _wrap,
      ...domProps
    } = props;
    return domProps;
  };
  const Text = ({ as = "span", children, ...props }: Record<string, unknown>) => {
    const Tag = as as "span" | "div" | "label";
    return <Tag {...cleanLayoutProps(props)}>{children as React.ReactNode}</Tag>;
  };
  const Root = ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      {children}
      <input {...props} />
    </div>
  );
  const Slot = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...cleanLayoutProps(props)}>{children}</div>
    ),
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...cleanLayoutProps(props)}>{children}</button>
    ),
    Callout: {
      Root: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
        <div {...cleanLayoutProps(props)}>{children}</div>
      ),
      Icon: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
      Text,
    },
    Flex: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...cleanLayoutProps(props)}>{children}</div>
    ),
    Spinner: () => <span>Loading</span>,
    Text,
    TextField: { Root, Slot },
  };
});

vi.mock("@radix-ui/react-icons", () => ({
  CheckCircledIcon: () => <span />,
  ExclamationTriangleIcon: () => <span />,
}));

import { AccountProfileSection } from "./AccountProfileSection";

const profile = {
  userId: "usr_ada",
  handle: "ada",
  displayName: "Ada Lovelace",
  role: "member" as const,
  color: "#123abc",
  avatar: "data:image/png;base64,YXZhdGFy",
};

describe("AccountProfileSection", () => {
  beforeEach(() => {
    accountMock.getProfile.mockReset().mockResolvedValue(profile);
    accountMock.updateProfile.mockReset().mockResolvedValue({
      ...profile,
      handle: "ada-updated",
      displayName: "Ada Byron",
      color: "#abcd",
      avatar: undefined,
    });
  });

  it("saves valid profile fields and clears the current avatar", async () => {
    render(<AccountProfileSection active />);
    await screen.findByDisplayValue("Ada Lovelace");

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Byron" } });
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "ada-updated" } });
    fireEvent.change(screen.getByLabelText("Profile color"), { target: { value: "#abcd" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear avatar" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(accountMock.updateProfile).toHaveBeenCalledWith({
        displayName: "Ada Byron",
        handle: "ada-updated",
        color: "#abcd",
        avatar: null,
      })
    );
    expect(screen.getByText("Profile saved.")).toBeTruthy();
  });

  it("surfaces server validation errors without discarding the draft", async () => {
    accountMock.updateProfile.mockRejectedValueOnce(new Error('Handle "taken" is already taken'));
    render(<AccountProfileSection active />);
    await screen.findByDisplayValue("Ada Lovelace");

    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText('Handle "taken" is already taken')).toBeTruthy();
    expect((screen.getByLabelText("Handle") as HTMLInputElement).value).toBe("taken");
    expect(
      (screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
