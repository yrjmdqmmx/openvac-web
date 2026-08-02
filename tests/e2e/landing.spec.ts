import { expect, test } from "@playwright/test";

test("preserves a pre-login question and opens sign in", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今天想解决什么真空问题？" })
  ).toBeVisible();

  const question = "旋片泵运行后温度升高并有异响，先查什么？";
  await page.getByLabel("向 OpenVac 提问").fill(question);
  await page.getByRole("button", { name: "发送问题" }).click();

  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fchat/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  const storage = await page.evaluate(() => ({
    sendIntent: sessionStorage.getItem("openvac:pending-question-intent:v2"),
    legacyDraft: localStorage.getItem("openvac:pending-question")
  }));
  expect(storage.legacyDraft).toBeNull();
  expect(JSON.parse(storage.sendIntent ?? "{}")).toMatchObject({
    version: 2,
    intent: "send",
    text: question
  });
});

test("example questions populate the composer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "抽速不够怎么排查？" }).click();
  await expect(page.getByLabel("向 OpenVac 提问")).toHaveValue(
    "抽速不够怎么排查？"
  );
});

test("has no horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("uses a neutral focus treatment and no custom favicon", async ({
  page
}) => {
  await page.goto("/");
  const input = page.getByLabel("向 OpenVac 提问");
  await input.focus();

  const form = input.locator("xpath=ancestor::form");
  const shadow = await form.evaluate(
    (element) => window.getComputedStyle(element).boxShadow
  );
  expect(shadow).toContain("17, 19, 21");
  await expect(page.locator('link[rel~="icon"]')).toHaveCount(0);
});

test("removes the old feature strip and homepage modeling CTA", async ({
  page
}) => {
  await page.goto("/");
  await expect(page.getByText("答案有来源")).toHaveCount(0);
  await expect(page.getByText("安全有边界")).toHaveCount(0);
  await expect(page.getByText("源码可审计")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "进入智能建模工作台" })
  ).toHaveCount(0);
});

test("does not expose a model picker or upload affordance", async ({
  page
}) => {
  await page.goto("/");
  await expect(page.getByText(/deepseek/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /上传|附件/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
