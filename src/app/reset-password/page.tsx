import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="设置新密码"
      description="密码更新后，其他设备上的旧会话会立即失效。"
    >
      <Suspense
        fallback={<div className="h-72 animate-pulse bg-[var(--surface)]" />}
      >
        <AuthForm mode="reset" />
      </Suspense>
    </AuthShell>
  );
}
