import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/get-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: null, user: null })
    });
  });
});

test("preserves a pre-login question and opens sign in", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "真空泵问题，直接问" })
  ).toBeVisible();

  const question = "旋片泵运行后温度升高并有异响，先查什么？";
  await page.getByLabel("向 OpenVac 提问").fill(question);
  await page.getByRole("button", { name: "发送问题" }).click();

  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fchat/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  const storage = await page.evaluate(() => ({
    sessionDraft: sessionStorage.getItem("openvac:pending-question-draft:v1"),
    legacyDraft: localStorage.getItem("openvac:pending-question")
  }));
  expect(storage.legacyDraft).toBeNull();
  expect(JSON.parse(storage.sessionDraft ?? "{}")).toMatchObject({
    version: 1,
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

test("does not expose a model picker or upload affordance", async ({
  page
}) => {
  await page.goto("/");
  await expect(page.getByText(/deepseek/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /上传|附件/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
