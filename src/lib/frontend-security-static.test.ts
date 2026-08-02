import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("frontend authentication boundaries", () => {
  it("uses the centralized same-origin returnTo resolver", () => {
    const authForm = source("src/components/auth/auth-form.tsx");

    expect(authForm).toContain("resolveSafeReturnTo");
    expect(authForm).not.toContain(
      'searchParams.get("returnTo")?.startsWith("/")'
    );
  });

  it("uses a versioned, owner-aware sessionStorage send intent", () => {
    const homePrompt = source("src/components/home-prompt.tsx");
    const chatWorkspace = source("src/components/chat/chat-workspace.tsx");
    const pendingQuestion = source("src/lib/pending-question-draft.ts");

    expect(homePrompt).not.toContain("localStorage");
    expect(chatWorkspace).not.toContain("localStorage");
    expect(homePrompt).toContain("savePendingQuestionIntent");
    expect(chatWorkspace).toContain("consumePendingQuestionIntent");
    expect(chatWorkspace).toContain("consumeLegacyPendingQuestionDraft");
    expect(chatWorkspace).toContain("savePendingQuestionIntent");
    expect(chatWorkspace).not.toContain("系统不会自动发送");
    expect(chatWorkspace).not.toContain("确认发送");
    expect(pendingQuestion).toContain("ownerUserId");
    expect(pendingQuestion).toContain("target.removeItem");
  });

  it("does not retain another device token in account React state", () => {
    const accountSettings = source(
      "src/components/account/account-settings.tsx"
    );

    expect(accountSettings).not.toMatch(/token\s*:/);
    expect(accountSettings).not.toContain("session.token");
    expect(accountSettings).toContain("deleteAccountSession(session.id)");
  });
});
