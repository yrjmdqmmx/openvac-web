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
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProblemReportDialog } from "./problem-report-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProblemReportDialog", () => {
  it("keeps context and contact sharing off until the user opts in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        reportId: "f607d4d6-82df-4f1b-a5d4-7d80277e327d",
        receivedAt: "2026-08-01T00:00:00.000Z"
      })
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ProblemReportDialog, {
        open: true,
        conversationId: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
        messageId: "a607d4d6-82df-4f1b-a5d4-7d80277e327d",
        description: "回答中的单位不正确。",
        onClose: () => undefined
      })
    );

    expect(
      screen.getByRole("checkbox", { name: /附带当前对话/ })
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /明确同意 OpenVac/ })
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "提交问题反馈" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/problem-reports");
    expect(JSON.parse(String(options.body))).toEqual({
      clientRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      ),
      conversationId: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      messageId: "a607d4d6-82df-4f1b-a5d4-7d80277e327d",
      category: "answer_incorrect",
      description: "回答中的单位不正确。",
      includeContext: false,
      consentToContact: false
    });
    expect(await screen.findByText("反馈编号")).toBeInTheDocument();
    expect(
      screen.getByText("f607d4d6-82df-4f1b-a5d4-7d80277e327d")
    ).toBeInTheDocument();
    expect(screen.getByText("2026/8/1 08:00:00")).toBeInTheDocument();
  });
});
