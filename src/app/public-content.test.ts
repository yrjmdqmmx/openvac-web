// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ComplaintsPage, {
  dynamic as complaintsDynamic
} from "./complaints/page";
import { dynamic as privacyDynamic } from "./legal/privacy/page";
import { dynamic as termsDynamic } from "./legal/terms/page";
import ProductPage, { dynamic as productDynamic } from "./product/page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("formal-operation public content", () => {
  it("reads optional public operations data at request time", () => {
    expect({
      complaintsDynamic,
      privacyDynamic,
      productDynamic,
      termsDynamic
    }).toEqual({
      complaintsDynamic: "force-dynamic",
      privacyDynamic: "force-dynamic",
      productDynamic: "force-dynamic",
      termsDynamic: "force-dynamic"
    });
  });

  it("does not render missing operations information or placeholders", () => {
    vi.stubEnv("OPERATOR_NAME", "");
    vi.stubEnv("GEN_AI_FILING_NUMBER", "");
    vi.stubEnv("LEGAL_COMPLAINT_EMAIL", "legal@example.cn");

    render(createElement(ProductPage));

    expect(screen.queryByText("运营信息")).not.toBeInTheDocument();
    expect(screen.queryByText("生成式 AI 备案号")).not.toBeInTheDocument();
    expect(screen.queryByText(/补充备案号/)).not.toBeInTheDocument();
  });

  it("renders configured operations information", () => {
    vi.stubEnv("OPERATOR_NAME", "宁波义星科技有限公司");
    vi.stubEnv("GEN_AI_FILING_NUMBER", "备案示例号");

    render(createElement(ProductPage));

    expect(screen.getByText("运营信息")).toBeInTheDocument();
    expect(screen.getByText("宁波义星科技有限公司")).toBeInTheDocument();
    expect(screen.getByText("备案示例号")).toBeInTheDocument();
  });

  it("hides the complaint address when no legal email is configured", () => {
    vi.stubEnv("LEGAL_COMPLAINT_EMAIL", "");

    render(createElement(ComplaintsPage));

    expect(screen.queryByText("提交法律投诉")).not.toBeInTheDocument();
    expect(screen.getByText("处理范围")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /@/ })).not.toBeInTheDocument();
  });
});
