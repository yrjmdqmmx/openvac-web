// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types/chat";
import { ExpertAnswer } from "./expert-answer";

const message: ChatMessage = {
  id: "message-1",
  role: "assistant",
  content: "请在建模工作台继续。",
  status: "completed",
  meta: {
    riskLevel: "low",
    missingInputs: [],
    webSearched: false,
    citations: [],
    modelingCards: [
      {
        kind: "project",
        projectId: "11111111-1111-4111-8111-111111111111",
        title: "原创旋片泵",
        description: "参数化项目"
      },
      {
        kind: "artifact",
        artifactId: "22222222-2222-4222-8222-222222222222",
        projectId: "11111111-1111-4111-8111-111111111111",
        title: "pump.step",
        projectTitle: "原创旋片泵",
        format: "STEP",
        sizeBytes: 1_572_864
      }
    ]
  }
};

afterEach(cleanup);

describe("ExpertAnswer modeling cards", () => {
  it("renders only fixed same-origin project and artifact destinations", () => {
    render(
      createElement(ExpertAnswer, {
        message,
        modelingEnabled: true,
        onFeedback: vi.fn(),
        onProblemReport: vi.fn()
      })
    );

    expect(screen.getByRole("link", { name: /打开项目/u })).toHaveAttribute(
      "href",
      "/modeling?project=11111111-1111-4111-8111-111111111111"
    );
    expect(screen.getByRole("link", { name: /授权下载/u })).toHaveAttribute(
      "href",
      "/api/modeling/artifacts/22222222-2222-4222-8222-222222222222/download"
    );
    expect(screen.getByText(/STEP · 1\.5 MB/u)).toBeInTheDocument();
    expect(screen.getByText(/不会让问答 Agent 执行 CAD/u)).toBeInTheDocument();
  });

  it("hides persisted cards when the modeling feature flag is off", () => {
    render(
      createElement(ExpertAnswer, {
        message,
        modelingEnabled: false,
        onFeedback: vi.fn(),
        onProblemReport: vi.fn()
      })
    );

    expect(
      screen.queryByRole("region", { name: "建模项目与制品" })
    ).not.toBeInTheDocument();
  });

  it("does not attach per-message feedback actions to a failed local answer", () => {
    render(
      createElement(ExpertAnswer, {
        message: {
          id: "assistant-local-only",
          role: "assistant",
          content: "本次回答未完成。",
          status: "error"
        },
        modelingEnabled: false,
        onFeedback: vi.fn(),
        onProblemReport: vi.fn()
      })
    );

    expect(
      screen.queryByRole("button", { name: "问题反馈" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "回答有帮助" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制回答" })
    ).not.toBeInTheDocument();
  });
});
