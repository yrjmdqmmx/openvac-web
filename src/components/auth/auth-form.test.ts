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
  push: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  searchParams: new URLSearchParams()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => mocks.searchParams
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: mocks.signInEmail },
    signUp: { email: vi.fn() },
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    sendVerificationEmail: vi.fn()
  }
}));

vi.mock("@/lib/use-hydrated", () => ({ useHydrated: () => true }));

import { AuthForm } from "./auth-form";

afterEach(cleanup);

beforeEach(() => {
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.signInEmail.mockReset();
  mocks.searchParams = new URLSearchParams();
});

function renderSignIn() {
  render(createElement(AuthForm, { mode: "sign-in" }));
  fireEvent.change(screen.getByLabelText("邮箱"), {
    target: { value: "person@example.com" }
  });
  return screen.getByLabelText("密码");
}

async function expectSignInError(
  authError: Record<string, unknown>,
  expected: string
) {
  const password = renderSignIn();
  mocks.signInEmail.mockResolvedValue({ error: authError });
  fireEvent.change(password, { target: { value: "oldpass8" } });
  fireEvent.submit(password.closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  expect(mocks.push).not.toHaveBeenCalled();
}

describe("AuthForm authentication boundaries", () => {
  it("allows an existing eight-character password at sign in while keeping new passwords at ten", () => {
    const signInPassword = renderSignIn();
    expect(signInPassword).toHaveAttribute("minlength", "8");

    cleanup();
    render(createElement(AuthForm, { mode: "sign-up" }));
    expect(screen.getByLabelText(/^密码/u)).toHaveAttribute("minlength", "10");
    expect(screen.getByLabelText("确认密码")).toHaveAttribute(
      "minlength",
      "10"
    );

    cleanup();
    mocks.searchParams = new URLSearchParams("token=reset-token");
    render(createElement(AuthForm, { mode: "reset" }));
    expect(screen.getByLabelText(/^新密码/u)).toHaveAttribute(
      "minlength",
      "10"
    );
  });

  it("submits an existing eight-character password", async () => {
    const password = renderSignIn();
    mocks.signInEmail.mockResolvedValue({ error: null });
    fireEvent.change(password, { target: { value: "oldpass8" } });
    fireEvent.submit(password.closest("form")!);

    await waitFor(() =>
      expect(mocks.signInEmail).toHaveBeenCalledWith(
        expect.objectContaining({ password: "oldpass8" })
      )
    );
  });

  it("does not enter the app before a required two-factor challenge", async () => {
    const password = renderSignIn();
    mocks.signInEmail.mockResolvedValue({
      error: null,
      data: { twoFactorRedirect: true, twoFactorMethods: ["totp"] }
    });
    fireEvent.change(password, { target: { value: "oldpass8" } });
    fireEvent.submit(password.closest("form")!);

    await waitFor(() => expect(mocks.signInEmail).toHaveBeenCalledOnce());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("openvac:two-factor:return-to")).toBe(
      "/chat"
    );
  });

  it("identifies an unverified email without exposing account existence", async () => {
    await expectSignInError(
      { code: "EMAIL_NOT_VERIFIED", status: 403 },
      "请先完成邮箱验证。验证邮件可在登录页重新发送。"
    );
  });

  it("uses one non-enumerating message for invalid credentials", async () => {
    await expectSignInError(
      { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 },
      "邮箱或密码不正确，请重试。"
    );
  });

  it("distinguishes an invalid origin from invalid credentials", async () => {
    await expectSignInError(
      { code: "INVALID_ORIGIN", status: 403, message: "Invalid origin" },
      "当前页面来源未获授权，请刷新后重试或联系管理员。"
    );
  });

  it("distinguishes rate limiting", async () => {
    await expectSignInError(
      { code: "TOO_MANY_REQUESTS", status: 429 },
      "操作过于频繁，请稍后再试。"
    );
  });

  it("distinguishes an effective account ban", async () => {
    await expectSignInError(
      { code: "BANNED_USER", status: 403 },
      "当前账号已被暂停使用。如有疑问，请联系管理员。"
    );
  });

  it("distinguishes an authentication service failure", async () => {
    await expectSignInError(
      { code: "SERVICE_UNAVAILABLE", status: 503 },
      "认证服务暂时不可用，请稍后重试。"
    );
  });

  it("does not expose whether an account already exists", async () => {
    await expectSignInError(
      {
        code: "USER_ALREADY_EXISTS",
        status: 422,
        message: "User already exists"
      },
      "暂时无法完成操作，请稍后重试。"
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/存在|已注册/u);
  });
});
