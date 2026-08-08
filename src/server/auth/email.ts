import { getEmailProvider } from "@/server/providers";

export type AuthEmailKind =
  | "change-email-confirmation"
  | "change-email-verification"
  | "delete-account"
  | "reset-password"
  | "verify-email";

interface AuthEmailContent {
  subject: string;
  text: string;
  html: string;
  tag: string;
}

const BRAND_NAME = "OpenVac";

const EMAIL_COPY: Record<
  AuthEmailKind,
  {
    subject: string;
    heading: string;
    action: string;
    notice: string;
    tag: string;
  }
> = {
  "verify-email": {
    subject: "验证你的 OpenVac 邮箱",
    heading: "完成邮箱验证",
    action: "验证邮箱",
    notice: "如果这不是你的操作，可以安全忽略这封邮件。",
    tag: "auth-verify-email"
  },
  "reset-password": {
    subject: "重置你的 OpenVac 密码",
    heading: "重置登录密码",
    action: "重置密码",
    notice: "如果你没有申请重置密码，请忽略这封邮件并继续使用原密码。",
    tag: "auth-reset-password"
  },
  "delete-account": {
    subject: "确认删除你的 OpenVac 账号",
    heading: "确认删除账号",
    action: "确认删除账号",
    notice: "如果你没有发起删除请求，请不要点击链接，并尽快修改密码。",
    tag: "auth-delete-account"
  },
  "change-email-confirmation": {
    subject: "确认更换你的 OpenVac 邮箱",
    heading: "在旧邮箱确认更换",
    action: "确认更换邮箱",
    notice: "如果你没有发起邮箱更换，请不要点击链接并立即修改密码。",
    tag: "auth-change-email-confirmation"
  },
  "change-email-verification": {
    subject: "验证你的 OpenVac 新邮箱",
    heading: "验证新邮箱",
    action: "验证新邮箱",
    notice: "完成验证后，新邮箱将用于登录 OpenVac。",
    tag: "auth-change-email-verification"
  }
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return escaped[character] ?? character;
  });
}

function safeActionUrl(value: string) {
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Authentication email URL must use HTTP or HTTPS");
  }

  return url.toString();
}

export function buildAuthEmail(
  kind: AuthEmailKind,
  actionUrl: string
): AuthEmailContent {
  const copy = EMAIL_COPY[kind];
  const url = safeActionUrl(actionUrl);
  const escapedUrl = escapeHtml(url);

  return {
    subject: copy.subject,
    tag: copy.tag,
    text: `${copy.heading}\n\n请在浏览器中打开以下链接：\n${url}\n\n${copy.notice}\n\n— ${BRAND_NAME}`,
    html: `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;background:#f6f7f8;color:#17202a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px">
      <div style="background:#ffffff;border:1px solid #e7e9ec;border-radius:16px;padding:32px">
        <p style="margin:0 0 24px;font-size:18px;font-weight:700">${BRAND_NAME}</p>
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.35">${escapeHtml(copy.heading)}</h1>
        <p style="margin:0 0 24px;color:#4b5563;line-height:1.7">请点击下方按钮继续。该链接包含一次性凭证，请勿转发给他人。</p>
        <p style="margin:0 0 24px">
          <a href="${escapedUrl}" style="display:inline-block;border-radius:10px;background:#111827;color:#ffffff;padding:12px 20px;text-decoration:none;font-weight:600">${escapeHtml(copy.action)}</a>
        </p>
        <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7">${escapeHtml(copy.notice)}</p>
      </div>
    </div>
  </body>
</html>`
  };
}

export async function sendAuthEmail(input: {
  kind: AuthEmailKind;
  to: string;
  url: string;
}): Promise<void> {
  const provider = await getEmailProvider();
  const message = buildAuthEmail(input.kind, input.url);

  await provider.sendTransactional({
    to: input.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tag: message.tag
  });
}
