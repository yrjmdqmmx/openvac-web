import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default function SignInPage() {
  return (
    <AuthShell
      title="欢迎回来"
      description="登录后继续你的真空泵问题与历史对话。"
    >
      <Suspense
        fallback={<div className="h-80 animate-pulse bg-[var(--surface)]" />}
      >
        <AuthForm mode="sign-in" />
      </Suspense>
    </AuthShell>
  );
}
