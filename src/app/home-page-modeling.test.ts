// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const featureFlagMocks = vi.hoisted(() => ({
  isModelingEnabled: vi.fn()
}));

vi.mock("@/server/modeling/feature-flag", () => featureFlagMocks);
vi.mock("@/components/home-prompt", () => ({
  HomePrompt: () => createElement("div", { "data-testid": "home-prompt" })
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: () => null
}));

import HomePage, { dynamic } from "./page";

beforeEach(() => {
  featureFlagMocks.isModelingEnabled.mockReset();
});

afterEach(cleanup);

describe("home page modeling entry", () => {
  it("renders dynamically so the runtime kill switch cannot be baked in", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("links to the modeling workspace when modeling is enabled", () => {
    featureFlagMocks.isModelingEnabled.mockReturnValue(true);

    render(createElement(HomePage));

    expect(
      screen.getByRole("link", { name: "进入智能建模工作台" })
    ).toHaveAttribute("href", "/modeling");
  });

  it("does not advertise a disabled modeling workspace", () => {
    featureFlagMocks.isModelingEnabled.mockReturnValue(false);

    render(createElement(HomePage));

    expect(
      screen.queryByRole("link", { name: "进入智能建模工作台" })
    ).not.toBeInTheDocument();
  });
});
