import { describe, expect, it, vi } from "vitest";

import { sendProblemReportNotification } from "./notification";

const report = {
  id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
  category: "citation_problem" as const,
  createdAt: new Date("2026-08-01T00:00:00.000Z")
};

describe("problem report product-owner notification", () => {
  it("sends only the minimal report metadata to the configured recipient", async () => {
    const sendTransactional = vi.fn().mockResolvedValue({ messageId: "m-1" });

    await expect(
      sendProblemReportNotification(report, {
        recipient: "owner@example.com",
        appUrl: "https://openvac.example",
        provider: { sendTransactional }
      })
    ).resolves.toBe(true);

    expect(sendTransactional).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
        tag: "problem-report-notification"
      })
    );
    const message = sendTransactional.mock.calls[0]?.[0];
    expect(`${message?.text}\n${message?.html}`).toContain(report.id);
    expect(`${message?.text}\n${message?.html}`).toContain(report.category);
    expect(`${message?.text}\n${message?.html}`).not.toContain(
      "user@example.com"
    );
  });

  it("silently skips when no product-owner recipient is configured", async () => {
    const sendTransactional = vi.fn();

    await expect(
      sendProblemReportNotification(report, {
        recipient: "",
        provider: { sendTransactional }
      })
    ).resolves.toBe(false);
    expect(sendTransactional).not.toHaveBeenCalled();
  });
});
