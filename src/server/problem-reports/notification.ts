import type { ProblemReportCategory } from "@/server/api/types";
import { getEmailProvider } from "@/server/providers";
import type { EmailProvider } from "@/server/providers/types";

type ProblemReportNotification = {
  id: string;
  category: ProblemReportCategory;
  createdAt: Date;
};

type NotificationOptions = {
  recipient?: string;
  appUrl?: string;
  provider?: Pick<EmailProvider, "sendTransactional">;
};

function escapeHtml(value: string): string {
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

function adminProblemReportsUrl(appUrl?: string): string {
  const base = appUrl?.trim() || "http://localhost:3000";
  const url = new URL("/admin/problem-reports", base);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Problem-report admin URL must use HTTP or HTTPS");
  }
  return url.toString();
}

export async function sendProblemReportNotification(
  input: ProblemReportNotification,
  options: NotificationOptions = {}
): Promise<boolean> {
  const recipient = (
    options.recipient ??
    process.env.PROBLEM_REPORT_NOTIFICATION_EMAIL ??
    ""
  ).trim();
  if (!recipient) return false;

  const url = adminProblemReportsUrl(
    options.appUrl ?? process.env.NEXT_PUBLIC_APP_URL
  );
  const receivedAt = input.createdAt.toISOString();
  const text = [
    "OpenVac 收到一条新的问题反馈。",
    `反馈编号：${input.id}`,
    `分类：${input.category}`,
    `接收时间：${receivedAt}`,
    `后台链接：${url}`
  ].join("\n");
  const html = `<p>OpenVac 收到一条新的问题反馈。</p>
<ul>
  <li>反馈编号：${escapeHtml(input.id)}</li>
  <li>分类：${escapeHtml(input.category)}</li>
  <li>接收时间：${escapeHtml(receivedAt)}</li>
</ul>
<p><a href="${escapeHtml(url)}">打开问题反馈后台</a></p>`;

  const provider = options.provider ?? getEmailProvider();
  await provider.sendTransactional({
    to: recipient,
    subject: `[OpenVac] 新问题反馈 ${input.id}`,
    text,
    html,
    tag: "problem-report-notification"
  });
  return true;
}
