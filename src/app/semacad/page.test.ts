// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  ready: false,
  release: {
    status: "preparing",
    version: "0.2.0",
    build: "2026080501",
    assetName: null as string | null,
    downloadUrl: null as string | null,
    releaseUrl: null as string | null,
    sizeBytes: null as number | null,
    sha256: null as string | null,
    architecture: "arm64",
    minimumMacOS: "26.0",
    notarized: false,
    publishedAt: null as string | null
  }
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers())
}));
vi.mock("next/image", () => ({
  default: (props: { priority?: boolean }) =>
    createElement("img", { ...props, priority: undefined })
}));
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: mocks.getSession } }
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: ({ authenticated }: { authenticated: boolean }) =>
    createElement("div", {
      "data-testid": "site-header",
      "data-authenticated": String(authenticated)
    })
}));
vi.mock("@/lib/semacad-release", () => ({
  semacadRelease: mocks.release,
  isSemacadDownloadReady: () => mocks.ready
}));

import SemacadPage, { metadata } from "./page";

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue(null);
  mocks.ready = false;
  Object.assign(mocks.release, {
    status: "preparing",
    assetName: null,
    downloadUrl: null,
    releaseUrl: null,
    sizeBytes: null,
    sha256: null,
    notarized: false,
    publishedAt: null
  });
});

afterEach(cleanup);

describe("SemaCAD product page", () => {
  it("publishes canonical and social metadata", () => {
    expect(metadata.alternates).toEqual({
      canonical: "https://openvac.cn/semacad"
    });
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({
        url: "https://openvac.cn/semacad",
        title: "SemaCAD｜OpenVac",
        images: expect.arrayContaining([
          expect.objectContaining({
            url: "https://openvac.cn/semacad/semacad-app-icon.png"
          })
        ])
      })
    );
    expect(metadata.twitter).toEqual(
      expect.objectContaining({
        title: "SemaCAD｜OpenVac",
        images: ["https://openvac.cn/semacad/semacad-app-icon.png"]
      })
    );
  });

  it("renders the approved preparing state without referencing a fake screenshot", async () => {
    const { container } = render(await SemacadPage());

    expect(
      screen.getByRole("heading", { name: "SemaCAD" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac/)
    ).toBeInTheDocument();
    expect(screen.getByText("下载准备中")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("link", { name: /查看源代码/ })).toHaveAttribute(
      "href",
      "https://github.com/zdywrnm/SemaCAD"
    );
    expect(
      screen.queryByAltText(/SemaCAD 公开 Beta 主窗口/)
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('script[type="application/ld+json"]')
    ).not.toBeNull();
  });

  it("renders the immutable download, screenshot and checksum when public Beta is ready", async () => {
    mocks.ready = true;
    Object.assign(mocks.release, {
      status: "public-beta",
      assetName: "semaCAD-0.2.0-beta.1-macOS26-arm64.dmg",
      downloadUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.1/semaCAD-0.2.0-beta.1-macOS26-arm64.dmg",
      releaseUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/tag/v0.2.0-beta.1",
      build: "2026080605",
      sizeBytes: 1_742_524_586,
      sha256:
        "ab4fb2e669422a2fc9407fac1340c01e3a2cc02ae16e08ff7cb89936408fadfb",
      notarized: true,
      publishedAt: "2026-08-06T16:10:24Z"
    });

    render(await SemacadPage());

    const downloadLinks = screen.getAllByRole("link", {
      name: /下载 Mac 版/
    });
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]).toHaveClass("!text-white");
    expect(downloadLinks[1]).toHaveClass("!text-[var(--ink)]");
    expect(screen.getByAltText(/SemaCAD 公开 Beta 主窗口/)).toHaveAttribute(
      "src",
      "/semacad/semacad-main-window.png"
    );
    expect(
      screen.getByText(
        "ab4fb2e669422a2fc9407fac1340c01e3a2cc02ae16e08ff7cb89936408fadfb"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("已公证")).toBeInTheDocument();
  });
});
