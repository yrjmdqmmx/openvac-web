import Link from "next/link";
import { MailCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";

export default function VerifyEmailPage() {
  return (
    <AuthShell
      title="检查你的邮箱"
      description="OpenVac 只允许已验证邮箱的账户开始对话。"
    >
      <div className="rounded-xl border border-[var(--border)] p-6">
        <MailCheck className="h-7 w-7 text-[var(--accent)]" />
        <p className="mt-5 text-sm leading-7 text-[var(--muted)]">
          点击验证邮件中的链接后返回登录页。如果没有收到，请检查垃圾邮件，或在登录页补发。
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-flex h-11 items-center rounded-lg bg-[var(--ink)] px-5 text-sm font-medium text-white"
        >
          返回登录
        </Link>
      </div>
    </AuthShell>
  );
}
