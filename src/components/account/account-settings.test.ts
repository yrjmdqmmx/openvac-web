// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  deleteUser: vi.fn(),
  enableTwoFactor: vi.fn(),
  verifyTotp: vi.fn(),
  disableTwoFactor: vi.fn(),
  generateBackupCodes: vi.fn(),
  confirm: vi.fn(),
  fetch: vi.fn()
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    changePassword: mocks.changePassword,
    deleteUser: mocks.deleteUser,
    revokeOtherSessions: vi.fn(),
    revokeSessions: vi.fn(),
    twoFactor: {
      enable: mocks.enableTwoFactor,
      verifyTotp: mocks.verifyTotp,
      disable: mocks.disableTwoFactor,
      generateBackupCodes: mocks.generateBackupCodes
    }
  }
}));

import { AccountSettingsContent } from "./account-settings";

beforeEach(() => {
  mocks.changePassword.mockReset();
  mocks.deleteUser.mockReset();
  mocks.enableTwoFactor.mockReset();
  mocks.verifyTotp.mockReset();
  mocks.disableTwoFactor.mockReset();
  mocks.generateBackupCodes.mockReset();
  mocks.confirm.mockReset();
  mocks.fetch.mockReset();
  mocks.confirm.mockReturnValue(true);
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("confirm", mocks.confirm);
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("account profile and credentials", () => {
  it("uploads an avatar through the authenticated same-origin endpoint", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          image: "/api/account/avatar",
          revision: 2,
          avatarRevision: 2
        }
      })
    });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "account"
      })
    );

    const file = new File([new Uint8Array([1, 2, 3])], "avatar.png", {
      type: "image/png"
    });
    fireEvent.change(screen.getByLabelText("头像图片"), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: "上传头像" }));

    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/account/avatar",
        expect.objectContaining({ method: "POST", body: expect.any(FormData) })
      )
    );
    expect(await screen.findByAltText("账户头像")).toHaveAttribute(
      "src",
      "/api/account/avatar?revision=2"
    );
  });

  it("saves a trimmed display name through the profile endpoint", async () => {
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        userName: "Old Name",
        section: "account"
      })
    );

    fireEvent.change(screen.getByLabelText("姓名"), {
      target: { value: "  New Name  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存姓名" }));

    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/account/profile",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "New Name" })
        })
      )
    );
  });

  it("changes a password with confirmation and revokes other sessions", async () => {
    mocks.changePassword.mockResolvedValue({ error: null });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "account"
      })
    );

    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "current-password" }
    });
    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "new-password-123" }
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: "new-password-123" }
    });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith({
        currentPassword: "current-password",
        newPassword: "new-password-123",
        revokeOtherSessions: true
      })
    );
  });

  it("requires the current password for the first-party email-change endpoint", async () => {
    render(
      createElement(AccountSettingsContent, {
        email: "old@example.com",
        section: "account"
      })
    );

    fireEvent.change(screen.getByLabelText("新邮箱"), {
      target: { value: "new@example.com" }
    });
    fireEvent.change(screen.getByLabelText("邮箱更换当前密码"), {
      target: { value: "current-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送邮箱更换确认" }));

    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/account/profile/email",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            currentPassword: "current-password",
            newEmail: "new@example.com"
          })
        })
      )
    );
  });
});

describe("account sessions state", () => {
  it("enrolls TOTP only after a valid code and then reveals one-time backup codes", async () => {
    mocks.enableTwoFactor.mockResolvedValue({
      error: null,
      data: {
        totpURI: "otpauth://totp/OpenVac:user?secret=TESTSECRET&issuer=OpenVac",
        backupCodes: ["backup-one", "backup-two"]
      }
    });
    mocks.verifyTotp.mockResolvedValue({ error: null, data: { token: "x" } });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "sessions"
      })
    );

    fireEvent.change(screen.getByLabelText("两步验证当前密码"), {
      target: { value: "current-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "开始启用" }));
    expect(await screen.findByText("TESTSECRET")).toBeVisible();

    fireEvent.change(screen.getByLabelText("启用两步验证动态码"), {
      target: { value: "123456" }
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并启用" }));

    await waitFor(() =>
      expect(mocks.verifyTotp).toHaveBeenCalledWith({ code: "123456" })
    );
    expect(await screen.findByText("backup-one")).toBeVisible();
    expect(screen.getByText("backup-two")).toBeVisible();
    expect(screen.getByText("已启用")).toBeVisible();
  });

  it("shows session loading failures instead of presenting an empty list", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "sessions"
      })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读取登录设备"
    );
    expect(screen.queryByText("暂未读取到登录设备。")).not.toBeInTheDocument();
  });

  it("labels the current device and shows last activity and expiry", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "session-1",
            userAgent: "Browser",
            ipAddress: "127.0.0.1",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
            expiresAt: "2026-08-08T00:00:00.000Z",
            isCurrent: true
          }
        ]
      })
    });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "sessions"
      })
    );

    expect(await screen.findByText("当前设备")).toBeVisible();
    expect(screen.getByText(/最近活动/u)).toBeVisible();
    expect(screen.getByText(/到期/u)).toBeVisible();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account deletion confirmation", () => {
  it("offers a pre-deletion personal data export", () => {
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "data"
      })
    );

    expect(
      screen.getByRole("link", { name: "下载 JSON 导出" })
    ).toHaveAttribute("href", "/api/account/export");
  });

  it("sends a confirmation email without claiming the account is already deleted", async () => {
    mocks.deleteUser.mockResolvedValue({ error: null });
    render(
      createElement(AccountSettingsContent, {
        email: "user@example.com",
        section: "data"
      })
    );

    fireEvent.change(screen.getByPlaceholderText("当前密码"), {
      target: { value: "current-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送注销确认邮件" }));

    await waitFor(() =>
      expect(mocks.deleteUser).toHaveBeenCalledWith({
        password: "current-password"
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "注销确认邮件已发送"
    );
    expect(screen.getByText(/点击邮件中的有效确认链接后/u)).toBeVisible();
  });
});
