import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default function SignUpPage() {
  return (
    <AuthShell
      title="创建 OpenVac 账户"
      description="使用邮箱和密码注册。验证邮箱后即可开始提问。"
    >
      <Suspense
        fallback={<div className="h-96 animate-pulse bg-[var(--surface)]" />}
      >
        <AuthForm mode="sign-up" />
      </Suspense>
    </AuthShell>
  );
}
