import { expect, test } from "@playwright/test";

const storageState = process.env.OPENVAC_E2E_STORAGE_STATE;
const attachmentId = "00000000-0000-4000-8000-000000000011";
const conversationId = "00000000-0000-4000-8000-000000000012";
const turnId = "00000000-0000-4000-8000-000000000013";
const runId = "00000000-0000-4000-8000-000000000014";

test.describe("Agent V3 chat composer", () => {
  test.use({ storageState: storageState ?? { cookies: [], origins: [] } });
  test.skip(
    !storageState,
    "Set OPENVAC_E2E_STORAGE_STATE to an authenticated Playwright storage state."
  );

  test("uploads a private attachment, sends V3 parts, and renders a safe block", async ({
    page
  }) => {
    let chatBody: Record<string, unknown> | undefined;
    let initiationBody: Record<string, unknown> | undefined;

    await page.route("**/api/conversations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { items: [], page: 1, pageSize: 20, total: 0 }
        })
      });
    });
    await page.route("**/api/chat/attachments", async (route) => {
      initiationBody = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            attachment: {
              type: "attachment",
              attachmentId,
              kind: "document",
              filename: "pump-manual.pdf",
              mimeType: "application/pdf",
              sizeBytes: 18,
              status: "initiated"
            },
            upload: {
              url: "https://uploads.openvac.test/private-object",
              method: "PUT",
              requiredHeaders: { "x-oss-object-acl": "private" }
            }
          }
        })
      });
    });
    await page.route("https://uploads.openvac.test/**", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route(
      `**/api/chat/attachments/${attachmentId}/complete`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              attachment: {
                type: "attachment",
                attachmentId,
                kind: "document",
                filename: "pump-manual.pdf",
                mimeType: "application/pdf",
                sizeBytes: 18,
                status: "ready"
              }
            }
          })
        });
      }
    );
    await page.route("**/api/chat", async (route) => {
      chatBody = route.request().postDataJSON() as Record<string, unknown>;
      const meta = {
        riskLevel: "low",
        missingInputs: [],
        webSearched: false,
        citations: [],
        turnId,
        runId,
        answerVersion: 1
      };
      const answer = {
        schemaVersion: "openvac.answer.v3",
        answerKind: "direct",
        riskLevel: "low",
        blocks: [
          { type: "heading", level: 2, text: "V3 安全回答" },
          {
            type: "paragraph",
            text: "附件已完成安全扫描。",
            evidenceIds: []
          }
        ],
        missingInputs: [],
        usedEvidenceIds: [],
        usedLinkIds: []
      };
      const events = [
        {
          type: "run.accepted",
          runId,
          sequence: 1,
          turnId,
          conversationId,
          userMessageId: "00000000-0000-4000-8000-000000000015",
          messageId: "00000000-0000-4000-8000-000000000016",
          answerVersion: 1
        },
        {
          type: "answer.block.committed",
          runId,
          sequence: 2,
          index: 0,
          block: answer.blocks[0]
        },
        {
          type: "answer.block.committed",
          runId,
          sequence: 3,
          index: 1,
          block: answer.blocks[1]
        },
        { type: "answer.completed", runId, sequence: 4, answer },
        {
          type: "run.completed",
          runId,
          sequence: 5,
          conversationId,
          turnId,
          messageId: "00000000-0000-4000-8000-000000000016",
          answerVersion: 1,
          answer,
          meta
        }
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("")
      });
    });

    await page.goto("/chat");
    await page.getByLabel("添加工程附件").setInputFiles({
      name: "pump-manual.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("private-pdf-fixture")
    });
    await expect(page.getByText(/就绪 ·/)).toBeVisible();

    await page.getByRole("button", { name: "链接" }).click();
    await page.getByLabel("HTTPS 链接").fill("https://docs.example.com/pump");
    await page.getByRole("button", { name: "添加" }).click();
    await page.getByLabel("继续提问").fill("分析这份泵手册");
    await page.getByRole("button", { name: "发送" }).click();

    await expect(
      page.getByRole("heading", { name: "V3 安全回答" })
    ).toBeVisible();
    expect(initiationBody?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(chatBody).toMatchObject({
      protocolVersion: 3,
      parts: [
        { type: "text", text: "分析这份泵手册" },
        {
          type: "link",
          url: "https://docs.example.com/pump",
          label: "docs.example.com"
        },
        { type: "attachment", attachmentId }
      ]
    });
    expect(chatBody).not.toHaveProperty("message");

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
});
