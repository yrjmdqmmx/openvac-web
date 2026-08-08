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
  replace: vi.fn(),
  refresh: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh })
}));
vi.mock("@/lib/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    twoFactor: {
      verifyTotp: mocks.verifyTotp,
      verifyBackupCode: mocks.verifyBackupCode
    }
  }
}));

import { TwoFactorChallenge } from "./two-factor-challenge";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.refresh.mockReset();
  mocks.verifyTotp.mockReset();
  mocks.verifyBackupCode.mockReset();
  window.sessionStorage.clear();
});

afterEach(cleanup);

describe("two-factor sign-in challenge", () => {
  it("verifies TOTP and resumes only a safe stored return path", async () => {
    window.sessionStorage.setItem("openvac:two-factor:return-to", "/admin");
    mocks.verifyTotp.mockResolvedValue({
      error: null,
      data: { token: "token" }
    });
    render(createElement(TwoFactorChallenge));

    fireEvent.change(screen.getByLabelText("6 位动态验证码"), {
      target: { value: "123 456" }
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并继续" }));

    await waitFor(() =>
      expect(mocks.verifyTotp).toHaveBeenCalledWith({
        code: "123456",
        trustDevice: false
      })
    );
    expect(mocks.replace).toHaveBeenCalledWith("/admin");
  });

  it("supports a one-time backup code", async () => {
    mocks.verifyBackupCode.mockResolvedValue({
      error: null,
      data: { token: "token" }
    });
    render(createElement(TwoFactorChallenge));
    fireEvent.click(screen.getByRole("button", { name: "备用码" }));
    fireEvent.change(screen.getByLabelText("一次性备用码"), {
      target: { value: " backup-code " }
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并继续" }));

    await waitFor(() =>
      expect(mocks.verifyBackupCode).toHaveBeenCalledWith({
        code: "backup-code",
        trustDevice: false
      })
    );
  });
});
