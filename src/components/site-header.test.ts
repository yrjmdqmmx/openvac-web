// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/modeling/feature-flag", () => ({
  isModelingEnabled: () => true
}));

import { SiteHeader } from "./site-header";

afterEach(cleanup);

describe("SiteHeader", () => {
  it("renders a text-only brand and a login link for signed-out visitors", () => {
    const { container } = render(
      createElement(SiteHeader, { authenticated: false })
    );

    expect(screen.getByLabelText("OpenVac 首页")).toHaveTextContent("OpenVac");
    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute(
      "href",
      "/sign-in"
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(
      container.querySelector("[class*='rounded-full'][aria-hidden]")
    ).toBeNull();
  });

  it("renders a server-determined continue link for signed-in users", () => {
    render(createElement(SiteHeader, { authenticated: true }));

    expect(screen.getByRole("link", { name: "继续对话" })).toHaveAttribute(
      "href",
      "/chat"
    );
    expect(
      screen.queryByRole("link", { name: "登录" })
    ).not.toBeInTheDocument();
  });
});
