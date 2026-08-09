import { expect, test } from "@playwright/test";

import { renderAgentV3BrowserContract } from "./fixtures/agent-v3-browser-contract";

test("covers upload progression, image preview, and quota exhaustion", async ({
  page
}) => {
  await page.setContent(
    renderAgentV3BrowserContract({
      attachments: [
        {
          filename: "真空泵手册.pdf",
          kind: "document",
          status: "processing"
        },
        { filename: "铭牌.png", kind: "image", status: "ready" }
      ],
      quota: {
        usedBytes: 500 * 1024 * 1024,
        limitBytes: 500 * 1024 * 1024,
        blocked: true
      }
    })
  );

  await expect(
    page.getByText("每条消息最多 5 个附件；每个附件最大 25 MiB。")
  ).toBeVisible();
  await expect(page.getByAltText("铭牌.png 的私有图片预览")).toBeVisible();
  const status = page.locator('[data-upload-status="0"]');
  await expect(status).toHaveText("处理中");
  await page.getByRole("button", { name: "完成上传处理" }).click();
  await expect(status).toHaveText("可用");
  await expect(page.getByRole("alert")).toContainText("存储配额已用尽");
});

test("renders only verified HTTPS links, semantic tables, and internal artifact downloads", async ({
  page
}) => {
  await page.setContent(
    renderAgentV3BrowserContract({
      links: [
        {
          label: "厂家手册",
          url: "https://manufacturer.example/manual",
          status: "verified"
        },
        {
          label: "不安全链接",
          url: "http://unsafe.example/manual",
          status: "verified"
        },
        {
          label: "不可用来源",
          url: "https://offline.example/manual",
          status: "unavailable"
        }
      ],
      table: {
        columns: ["参数", "值", "单位"],
        rows: [["有效抽速", "10", "L/s"]]
      },
      artifact: {
        id: "00000000-0000-4000-8000-000000000302",
        title: "选型参数表",
        format: "csv",
        status: "ready"
      }
    })
  );

  const verified = page.getByRole("link", { name: "厂家手册" });
  await expect(verified).toHaveAttribute(
    "href",
    "https://manufacturer.example/manual"
  );
  await expect(verified).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByText("不安全链接（链接不可用）")).toBeVisible();
  await expect(page.getByText("不可用来源（链接不可用）")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "参数" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "有效抽速" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "选型参数表（CSV）" })
  ).toHaveAttribute(
    "href",
    "/api/chat/artifacts/00000000-0000-4000-8000-000000000302/download?format=csv"
  );
  expect(await page.locator('a[href^="http:"]').count()).toBe(0);
});

test("covers deletion, legacy plaintext history, failed artifacts, and terminal-version reconciliation", async ({
  page
}) => {
  await page.setContent(
    renderAgentV3BrowserContract({
      attachments: [
        { filename: "secret.pdf", kind: "document", status: "deleted" }
      ],
      artifact: {
        id: "00000000-0000-4000-8000-000000000303",
        title: "失败报告",
        format: "pdf",
        status: "failed"
      },
      legacyContent: "这是 V2 旧历史的纯文本投影。",
      versions: [
        { id: "v1", status: "completed", text: "最后一个成功答案" },
        { id: "v2", status: "failed", text: "不得显示的失败骨架" },
        { id: "v3", status: "incomplete", text: "不得显示的未完成骨架" }
      ]
    })
  );

  await expect(page.getByText("附件已删除")).toBeVisible();
  await expect(page.getByText("secret.pdf")).toHaveCount(0);
  await expect(page.getByText("产物生成失败")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "工程产物" }).getByRole("link")
  ).toHaveCount(0);
  await expect(page.getByTestId("legacy-projection")).toHaveText(
    "这是 V2 旧历史的纯文本投影。"
  );
  await expect(page.getByTestId("terminal-version")).toHaveText(
    "最后一个成功答案"
  );
  await expect(page.getByText("不得显示的失败骨架")).toHaveCount(0);
  await expect(page.getByText("不得显示的未完成骨架")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "复制当前成功版本" })
  ).toBeEnabled();
});
