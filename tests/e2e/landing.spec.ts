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
  await expect(input).toBeEnabled();
  await input.focus();
  await expect(input).toBeFocused();

  const form = input.locator("xpath=ancestor::form");
  await expect
    .poll(() =>
      form.evaluate((element) => window.getComputedStyle(element).boxShadow)
    )
    .toContain("17, 19, 21");
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

test("links the homepage to the SemaCAD product page", async ({ page }) => {
  await page.goto("/");

  const semacadCard = page
    .locator('a[href="/semacad"]')
    .filter({ hasText: "基于 FreeCAD 的本地优先 CAD" });
  await expect(semacadCard).toBeVisible();
  await expect(semacadCard).toHaveAttribute("href", "/semacad");

  await semacadCard.click();
  await expect(page).toHaveURL(/\/semacad$/);
  await expect(page.getByRole("heading", { name: "SemaCAD" })).toBeVisible();
});

test("renders the verified SemaCAD public Beta release", async ({ page }) => {
  await page.goto("/semacad");

  const downloads = page.getByRole("link", { name: /下载 Mac 版/ });
  await expect(downloads).toHaveCount(2);
  await expect(downloads.first()).toHaveAttribute(
    "href",
    "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.1/semaCAD-0.2.0-beta.1-macOS26-arm64.dmg"
  );
  await expect(downloads.first()).toHaveCSS("color", "rgb(255, 255, 255)");
  const sourceLinks = page.getByRole("link", { name: /查看源代码/ });
  await expect(sourceLinks).toHaveCount(2);
  await expect(sourceLinks.first()).toHaveAttribute(
    "href",
    "https://github.com/zdywrnm/SemaCAD"
  );
  await expect(
    page.getByAltText(/六孔真空盲板法兰示意件与 OpenVac 计划面板/)
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "SemaCAD 产品亮点" })
  ).toContainText("FreeCAD本地优先BYOKApple Silicon已公证开源");
  const icon = page.getByTestId("semacad-app-icon-frame").first();
  const iconBox = await icon.boundingBox();
  const minimumIconWidth = (page.viewportSize()?.width ?? 0) >= 1024 ? 112 : 76;
  expect(iconBox?.width).toBeGreaterThanOrEqual(minimumIconWidth);
  await expect(
    page.getByText(
      "ab4fb2e669422a2fc9407fac1340c01e3a2cc02ae16e08ff7cb89936408fadfb"
    )
  ).toBeVisible();
  await expect(page.locator('link[rel~="icon"]')).toHaveCount(0);
});

test("uses the dynamic liquid-metal background and has no overflow on mobile", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/semacad");

  const backdrop = page.getByTestId("semacad-hero-backdrop");
  await expect(backdrop).toHaveAttribute("data-renderer", "webgl");
  await expect(backdrop.locator("canvas")).toHaveCount(1);
  await expect(backdrop).toHaveCSS(
    "background-image",
    /semacad-liquid-metal-poster\.avif/
  );
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("uses one liquid-metal backdrop across the complete homepage", async ({
  page
}) => {
  await page.goto("/");

  await expect(page.getByTestId("semacad-hero-backdrop")).toHaveCount(1);
  await expect(page.getByTestId("semacad-hero-backdrop")).toHaveCSS(
    "position",
    "fixed"
  );
  await expect(page.getByRole("link", { name: "知识来源" })).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await page.getByRole("button", { name: "打开导航菜单" }).click();
  }
  const sourceLink = page.getByRole("link", { name: "开源项目" });
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink.locator('[data-testid="github-mark"]')).toHaveCount(
    1
  );
});

test("redirects both legacy modeling URLs directly to SemaCAD", async ({
  request
}) => {
  for (const path of ["/modeling", "/modeling/"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe("/semacad");
  }
});

test("keeps the 320px title grouping and mobile navigation accessible", async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  const titleGroups = page.locator("h1 > span");
  await expect(titleGroups).toHaveCount(2);
  const firstBox = await titleGroups.nth(0).boundingBox();
  const secondBox = await titleGroups.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y).toBeGreaterThan(firstBox!.y);

  const menuButton = page.getByRole("button", { name: "打开导航菜单" });
  const menuButtonBox = await menuButton.boundingBox();
  expect(menuButtonBox?.width).toBeGreaterThanOrEqual(44);
  expect(menuButtonBox?.height).toBeGreaterThanOrEqual(44);

  await menuButton.click();
  const closeMenuButton = page.getByRole("button", { name: "关闭导航菜单" });
  await expect(closeMenuButton).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("navigation", { name: "移动端导航" })
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");

  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
