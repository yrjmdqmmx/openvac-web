import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="重置密码"
      description="我们会向已注册邮箱发送一次性重置链接。"
    >
      <Suspense
        fallback={<div className="h-64 animate-pulse bg-[var(--surface)]" />}
      >
        <AuthForm mode="forgot" />
      </Suspense>
    </AuthShell>
  );
}
