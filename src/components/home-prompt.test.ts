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
import { PENDING_QUESTION_INTENT_KEY } from "@/lib/pending-question-draft";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push })
}));

import { HomePrompt } from "./home-prompt";

beforeEach(() => {
  mocks.push.mockReset();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("HomePrompt", () => {
  it("stores an unbound send intent and opens sign in for a visitor", async () => {
    render(createElement(HomePrompt, {}));

    const input = screen.getByLabelText("向 OpenVac 提问");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "登录前的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(mocks.push).toHaveBeenCalledWith("/sign-in?returnTo=%2Fchat");
    expect(
      JSON.parse(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY) ?? "{}")
    ).toMatchObject({
      version: 2,
      intent: "send",
      text: "登录前的问题"
    });
  });

  it("binds the intent to the server user and opens chat directly", async () => {
    render(createElement(HomePrompt, { currentUserId: "user-a" }));

    const input = screen.getByLabelText("向 OpenVac 提问");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "已登录的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(mocks.push).toHaveBeenCalledWith("/chat");
    expect(
      JSON.parse(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY) ?? "{}")
    ).toMatchObject({ ownerUserId: "user-a" });
  });

  it("sends the homepage reasoning and web choices into chat", async () => {
    render(createElement(HomePrompt, { currentUserId: "user-a" }));

    const input = screen.getByLabelText("向 OpenVac 提问");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "深度思考" }));
    fireEvent.click(screen.getByRole("button", { name: "联网" }));
    fireEvent.change(input, { target: { value: "联网分析这个真空问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(
      JSON.parse(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY) ?? "{}")
    ).toMatchObject({ mode: "deep", webMode: "always" });
  });

  it("does not submit while a Chinese IME composition is active", async () => {
    render(createElement(HomePrompt, { currentUserId: "user-a" }));

    const input = screen.getByLabelText("向 OpenVac 提问");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "真空" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: true
    });

    expect(mocks.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY)).toBeNull();
  });
});
