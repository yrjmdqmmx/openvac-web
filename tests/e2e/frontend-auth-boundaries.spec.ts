import { expect, test } from "@playwright/test";

test("normalizes a double-encoded cross-origin returnTo before sign in", async ({
  page
}) => {
  let requestBody: Record<string, unknown> | undefined;

  await page.route("**/api/auth/sign-in/email", async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        redirect: false,
        token: "test-session",
        user: {
          id: "test-user",
          name: "测试用户",
          email: "test@example.com",
          emailVerified: true
        }
      })
    });
  });

  await page.goto("/sign-in?returnTo=%252F%252Fevil.example");
  await page.getByLabel("邮箱").fill("test@example.com");
  await page.getByLabel("密码").fill("long-enough-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect.poll(() => requestBody?.callbackURL).toBe("/chat");
});
